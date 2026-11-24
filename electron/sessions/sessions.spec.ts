import { execFileSync } from 'node:child_process';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Exit, Fiber, Option, Schedule, Stream } from 'effect';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { SessionId, type TranscriptItem } from '../../src/shared/sessions/sessions.rpc';
import { EMPTY_WORKSPACE, allWorkspaceSessionIds } from '../../src/shared/tabs/workspace-layout';
import type { AcpSessionEvent } from '../acp/acpClientDispatcher';
import { fakeEntry } from '../acp/acpFakes';
import { AgentLifetime } from '../acp/acpLifetime';
import { AcpClient } from '../acp/acpSessionManager';
import { antigravity as antigravityCatalog } from '../agents/antigravity/antigravity';
import { codex as codexCatalog } from '../agents/codex/codex';
import { Settings } from '../settings/settings';
import { AgentContextId, SessionStore } from './session-store';
import { Sessions } from './sessions';
import {
  TIMEOUT,
  withSessionsCustom,
  withSessions,
  text,
  workspaceFor,
  waitForVerificationApproval,
  untilTurnEnd,
  transcript,
  agentReply,
  events,
  seqs,
  agentAnswering,
  agentStatus,
  liveState,
  permissionRequest,
} from './sessions-spec-fakes';

const realAgentBin = process.env['SPENCE_CODEX_ACP_BIN'];

// Deliberately opt-in because this exercises an authenticated provider and consumes Usage.
describe.skipIf(realAgentBin === undefined || process.env['SPENCE_WORKFLOW_BENCHMARK'] !== '1')(
  'Workflow comparison with real Codex ACP',
  () => {
    it.live(
      'compares matched Worktrees with an independent acceptance check',
      () =>
        Effect.gen(function* () {
          const strong = process.env['SPENCE_BENCH_STRONG_MODEL'] ?? 'gpt-6.2-sol';
          const cheap = process.env['SPENCE_BENCH_WORKER_MODEL'] ?? 'gpt-6.1-terra';
          const taskFilter = process.env['SPENCE_BENCH_TASK'];
          const report = process.env['SPENCE_BENCH_REPORT'];
          for (const task of [
            {
              name: 'clamp',
              input: [-5, 7, 15],
              expected: [0, 7, 10],
              request: 'Clamp every number to the inclusive range 0 to 10, preserving order.',
            },
            {
              name: 'slug',
              input: [' Hello, WORLD! ', '_a__b_', '***'],
              expected: ['hello-world', 'a-b', ''],
              request:
                'Convert every value to a lowercase ASCII slug, replacing each non-alphanumeric run with one hyphen, then removing leading and trailing hyphens.',
            },
          ]) {
            if (taskFilter !== undefined && taskFilter !== task.name) continue;
            for (const method of ['single', 'coordinate', 'divide-and-conquer'] as const) {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const folder = yield* Effect.acquireRelease(
                    Effect.promise(() =>
                      mkdtemp(path.join(tmpdir(), 'spence-workflow-benchmark-')),
                    ),
                    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
                  );
                  yield* Effect.promise(() =>
                    writeFile(path.join(folder, 'solution.json'), JSON.stringify(task.input)),
                  );
                  yield* Effect.sync(() => {
                    execFileSync('git', ['init', '-q'], { cwd: folder });
                    execFileSync('git', ['add', '--', 'solution.json'], { cwd: folder });
                  });
                  const prompted = new Set<string>();
                  const tokens = new Map<string, number>();
                  const costs = new Map<string, { amount: number; currency: string }>();
                  const observeAcp = (id: string, event: AcpSessionEvent) => {
                    if (event._tag === 'PromptEnded') {
                      prompted.add(id);
                      if (
                        Exit.isSuccess(event.result) &&
                        event.result.value.usage !== undefined &&
                        event.result.value.usage !== null
                      ) {
                        const total = event.result.value.usage.totalTokens;
                        if (Number.isSafeInteger(total) && total >= 0) tokens.set(id, total);
                      }
                    }
                    if (
                      event._tag === 'Update' &&
                      event.update.sessionUpdate === 'usage_update' &&
                      event.update.cost !== undefined &&
                      event.update.cost !== null &&
                      Number.isFinite(event.update.cost.amount) &&
                      event.update.cost.amount >= 0 &&
                      event.update.cost.currency.trim() !== ''
                    ) {
                      costs.set(id, {
                        amount: event.update.cost.amount,
                        currency: event.update.cost.currency,
                      });
                    }
                  };
                  yield* withSessionsCustom(
                    {
                      realAgentBin,
                      catalog: [codexCatalog],
                      observeAcp,
                      picker: Effect.succeed(Option.some(folder)),
                    },
                    (project) =>
                      Effect.gen(function* () {
                        const sessions = yield* Sessions;
                        const primary = { agentId: codexCatalog.id, model: strong };
                        const worker = { agentId: codexCatalog.id, model: cheap };
                        yield* Settings.use((settings) =>
                          settings.update({
                            coordinator: { coordinator: primary, worker, verifier: primary },
                            divideAndConquer: {
                              planner: primary,
                              taskBreaker: worker,
                              implementer: worker,
                              verifier: primary,
                            },
                          }),
                        );
                        const parent = yield* sessions.create(project, codexCatalog.id);
                        const live = yield* liveState(
                          parent,
                          (state) => state.agentStatus !== 'starting',
                        );
                        if (live.agentStatus !== 'ready') {
                          return yield* Effect.die(
                            `Codex ACP unavailable: ${live.cantStartDetail ?? live.agentStatus}`,
                          );
                        }
                        const models = live.options.model?.choices.map((model) => model.id) ?? [];
                        if (!models.includes(strong) || !models.includes(cheap)) {
                          return yield* Effect.die(
                            `Benchmark Models unavailable. Offered Models: ${models.join(', ')}`,
                          );
                        }
                        yield* sessions.setOption({
                          sessionId: parent,
                          option: 'model',
                          value: strong,
                        });
                        const parts = text(
                          `Update solution.json in place. ${task.request} Keep the file a JSON array and verify it against that requirement. Change only solution.json.`,
                        );
                        const began = performance.now();
                        const result = yield* Effect.result(
                          method === 'single'
                            ? sessions.prompt(parent, parts)
                            : sessions.runWorkflow(parent, parts, undefined, method),
                        );
                        const items =
                          result._tag === 'Success'
                            ? transcript(yield* untilTurnEnd(events(parent)))
                            : [];
                        const elapsedMs = Math.round(performance.now() - began);
                        const completed = items.some(
                          (item) => item._tag === 'TurnEnded' && item.outcome._tag === 'done',
                        );
                        const checked = yield* Effect.tryPromise(async () => {
                          const actual: unknown = JSON.parse(
                            await readFile(path.join(folder, 'solution.json'), 'utf8'),
                          );
                          const entries = await readdir(folder);
                          return (
                            JSON.stringify(actual) === JSON.stringify(task.expected) &&
                            entries.every((name) => name === '.git' || name === 'solution.json')
                          );
                        }).pipe(Effect.orElseSucceed(() => false));
                        const totalByCurrency = new Map<string, number>();
                        for (const [id, { amount, currency }] of costs) {
                          if (prompted.has(id))
                            totalByCurrency.set(
                              currency,
                              (totalByCurrency.get(currency) ?? 0) + amount,
                            );
                        }
                        const allReported = (data: ReadonlyMap<string, unknown>) =>
                          prompted.size > 0 && [...prompted].every((id) => data.has(id));
                        const sample = {
                          task: task.name,
                          method,
                          strong,
                          cheap,
                          elapsedMs,
                          verified: completed && checked,
                          cost: allReported(costs) ? Object.fromEntries(totalByCurrency) : null,
                          cumulativeTokens: allReported(tokens)
                            ? [...tokens.values()].reduce((sum, value) => sum + value, 0)
                            : null,
                          promptedSessions: prompted.size,
                          ...(result._tag === 'Failure' ? { blocked: result.failure.detail } : {}),
                        };
                        if (report !== undefined)
                          yield* Effect.promise(() =>
                            appendFile(report, JSON.stringify(sample) + '\n'),
                          );
                        yield* Effect.logInfo('Workflow benchmark', sample);
                      }),
                  );
                }),
              );
            }
          }
        }),
      600_000,
    );
  },
);

// Opt-in: runs real authenticated provider turns; never used by CI.
/**
 * Real-Agent probe: a Parent's Agent creates Worker B, then Worker A, and A's Agent finds B with `list_sessions`
 * and messages it with `send_message`. Passes when B's Transcript holds A's message attributed to A and B answered.
 */
const realWorkerToWorkerMessage = (project: ProjectId) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const store = yield* SessionStore;
    const parent = yield* sessions.create(project);
    yield* sessions.prompt(
      parent,
      text(
        'Use the Spence delegate MCP tool exactly twice, one call at a time, waiting for each result. First call, task: "Reply only WORKER_B_READY". Second call, task: "Use the Spence list_sessions tool, find the session whose relation is sibling, then use the Spence send_message tool to send it exactly PING_4417. Reply only SENT." Do not use native subagents.',
      ),
    );
    yield* untilTurnEnd(events(parent));
    const workers = (yield* store.listAll).filter(
      (meta) => meta.parentSessionId === parent && meta.workerKind === 'owned',
    );
    expect(workers).toHaveLength(2);
    const received = yield* Effect.forEach(workers, (worker) => store.replay(worker.id));
    const target = received.find((replayed) =>
      replayed.some(
        (event) =>
          event.item._tag === 'Message' &&
          event.item.role === 'user' &&
          event.item.from !== undefined &&
          event.item.parts.some((part) => part._tag === 'text' && part.text.includes('PING_4417')),
      ),
    );
    expect(target).toBeDefined();
  });

describe.skipIf(realAgentBin === undefined)('Sessions with real Codex ACP', () => {
  it.live(
    'sends a message between two owned Workers',
    () => withSessionsCustom({ realAgentBin, catalog: [codexCatalog] }, realWorkerToWorkerMessage),
    300_000,
  );
  it.live(
    'discovers delegation, returns a Worker result, and accepts a Worker follow-up',
    () =>
      withSessionsCustom({ realAgentBin, catalog: [codexCatalog] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(
            parent,
            text(
              'Use the Spence delegate MCP tool exactly once. Ask the Worker to invent an eight-digit number and reply only WORKER_RESULT_ followed by that number. Return the Worker result verbatim. Do not use native subagents.',
            ),
          );
          const parentItems = transcript(yield* untilTurnEnd(events(parent)));
          const children = (yield* store.listAll).filter(
            (meta) => meta.parentSessionId === parent && meta.workerKind === 'owned',
          );
          expect(children).toHaveLength(1);
          const child = children[0];
          if (child === undefined) return yield* Effect.die('Owned Worker missing');
          const childItems = yield* store.replay(child.id);
          const workerResult = /WORKER_RESULT_\d{8}/.exec(
            agentReply(childItems.map((event) => event.item)),
          )?.[0];
          expect(workerResult).toBeDefined();
          if (workerResult === undefined) return yield* Effect.die('Worker result missing');
          expect(agentReply(parentItems)).toContain(workerResult);
          const lastSeq = childItems.at(-1)?.seq;
          yield* sessions.prompt(child.id, text('Reply with the exact text WORKER_FOLLOWUP_728.'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq))))).toContain(
            'WORKER_FOLLOWUP_728',
          );
        }),
      ),
    240_000,
  );
});

// Opt-in: runs real authenticated provider turns; never used by CI.
const antigravityBin = process.env['SPENCE_ANTIGRAVITY_ACP_BIN'];

describe.skipIf(antigravityBin === undefined)('Sessions with real Antigravity ACP', () => {
  it.live(
    'sends a message between two owned Workers',
    () =>
      withSessionsCustom(
        { realAgentBin: antigravityBin, catalog: [antigravityCatalog] },
        realWorkerToWorkerMessage,
      ),
    300_000,
  );
  it.live(
    'discovers delegation, returns a Worker result, and accepts a Worker follow-up',
    () =>
      withSessionsCustom(
        { realAgentBin: antigravityBin, catalog: [antigravityCatalog] },
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const parent = yield* sessions.create(project);
            yield* sessions.prompt(
              parent,
              text(
                'Use the Spence delegate MCP tool exactly once. Ask the Worker to invent an eight-digit number and reply only WORKER_RESULT_ followed by that number. Return the Worker result verbatim. Do not use native subagents.',
              ),
            );
            const parentItems = transcript(yield* untilTurnEnd(events(parent)));
            const children = (yield* store.listAll).filter(
              (meta) => meta.parentSessionId === parent && meta.workerKind === 'owned',
            );
            expect(children).toHaveLength(1);
            const child = children[0];
            if (child === undefined) return yield* Effect.die('Owned Worker missing');
            const childItems = yield* store.replay(child.id);
            const workerResult = /WORKER_RESULT_\d{8}/.exec(
              agentReply(childItems.map((event) => event.item)),
            )?.[0];
            expect(workerResult).toBeDefined();
            if (workerResult === undefined) return yield* Effect.die('Worker result missing');
            expect(agentReply(parentItems)).toContain(workerResult);
            const lastSeq = childItems.at(-1)?.seq;
            yield* sessions.prompt(
              child.id,
              text('Reply with the exact text WORKER_FOLLOWUP_728.'),
            );
            expect(
              agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq)))),
            ).toContain('WORKER_FOLLOWUP_728');
          }),
      ),
    240_000,
  );
});

describe('Sessions with the fake Agent', () => {
  it.live(
    'includes Worker preference in Agent guidance',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-guidance'));
          const reply = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          expect(reply).toContain('Prefer the Spence delegate tool');
          expect(reply).toContain('Native delegation remains available');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'coordinates with a different Agent and gates success on a fresh Verifier',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-coordinate-test-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
          const primary = fakeEntry();
          const secondary = fakeEntry([], { id: AgentId.make('fake-worker'), name: 'Fake Worker' });
          yield* withSessionsCustom(
            {
              catalog: [primary, secondary],
              picker: Effect.succeed(Option.some(folder)),
            },
            (project) =>
              Effect.gen(function* () {
                const sessions = yield* Sessions;
                const settings = yield* Settings;
                yield* settings.update({
                  coordinator: {
                    coordinator: { agentId: primary.id, model: 'large' },
                    worker: { agentId: secondary.id, model: 'small' },
                    verifier: { agentId: primary.id, model: 'small' },
                  },
                });
                const parent = yield* sessions.create(project);
                yield* sessions.runWorkflow(parent, text('coordinate-fixture'));
                const items = transcript(yield* untilTurnEnd(events(parent)));
                expect(items).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ _tag: 'Notice', title: 'Verification passed' }),
                    expect.objectContaining({ _tag: 'TurnEnded', outcome: { _tag: 'done' } }),
                  ]),
                );
                const store = yield* SessionStore;
                const roles = (yield* store.listAll)
                  .filter((meta) => meta.parentSessionId === parent)
                  .map(({ autoTitle, agentId, model }) => ({ autoTitle, agentId, model }));
                expect(roles).toEqual(
                  expect.arrayContaining([
                    { autoTitle: 'Coordinator', agentId: primary.id, model: 'large' },
                    { autoTitle: 'Worker', agentId: secondary.id, model: 'small' },
                    { autoTitle: 'Verifier', agentId: primary.id, model: 'small' },
                  ]),
                );
                expect(roles).toHaveLength(3);
              }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'routes a Coordinator Worker approval to the Parent Session and protects the Worktree until Stop finishes',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-workflow-stop-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
          yield* withSessionsCustom({ picker: Effect.succeed(Option.some(folder)) }, (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const settings = yield* Settings;
              const target = { agentId: fakeEntry().id, model: 'small' };
              yield* settings.update({
                defaultPermissionMode: 'ask',
                coordinator: { coordinator: target, worker: target, verifier: target },
              });
              const parent = yield* sessions.create(project);
              const other = yield* sessions.create(project);
              yield* sessions.runWorkflow(parent, text('coordinate-fixture:approval'));
              const pending = yield* events(parent).pipe(
                Stream.filter(
                  (entry) =>
                    entry._tag === 'Transcript' &&
                    entry.event.item._tag === 'PermissionRequest' &&
                    entry.event.item.state._tag === 'pending',
                ),
                Stream.runHead,
                Effect.timeout('5 seconds'),
              );
              const approval = Option.getOrUndefined(pending);
              if (
                approval?._tag !== 'Transcript' ||
                approval.event.item._tag !== 'PermissionRequest'
              ) {
                return yield* Effect.die('The Parent Session did not surface the Worker approval');
              }
              expect(approval.event.item.workflowSource).toEqual({
                role: 'Worker',
                agentName: 'Fake',
                title: 'Run checks',
              });
              const overlap = yield* Effect.result(
                sessions.runWorkflow(other, text('coordinate-fixture')),
              );
              expect(overlap._tag).toBe('Failure');
              if (overlap._tag === 'Failure') expect(overlap.failure.reason).toBe('Busy');
              yield* sessions.cancel(parent);
              const items = transcript(yield* untilTurnEnd(events(parent)));
              expect(items).toContainEqual(
                expect.objectContaining({
                  _tag: 'TurnEnded',
                  outcome: { _tag: 'cancelled' },
                }),
              );
              expect(items).not.toContainEqual(
                expect.objectContaining({ title: 'Verifying Worktree changes' }),
              );
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(folder, 'coordinator-fixture.txt'), 'utf8'),
                ),
              ).toBe('Implemented by the Worker\n');
              yield* sessions.runWorkflow(other, text('coordinate-fixture:approval:second'));
              const resumed = yield* events(other).pipe(
                Stream.filter(
                  (entry) =>
                    entry._tag === 'Transcript' &&
                    entry.event.item._tag === 'PermissionRequest' &&
                    entry.event.item.state._tag === 'pending',
                ),
                Stream.runHead,
                Effect.timeout('5 seconds'),
              );
              const next = Option.getOrUndefined(resumed);
              if (next?._tag !== 'Transcript' || next.event.item._tag !== 'PermissionRequest') {
                return yield* Effect.die('The second run did not request approval');
              }
              yield* sessions.answerPermission(other, next.event.item.id, 'allow');
              expect(transcript(yield* untilTurnEnd(events(other)))).toContainEqual(
                expect.objectContaining({
                  _tag: 'TurnEnded',
                  outcome: { _tag: 'done' },
                }),
              );
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'recovers an interrupted Coordinator run and the outcomes of its started roles',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-workflow-reopen-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          const folder = path.join(root, 'worktree');
          yield* Effect.promise(() => mkdir(folder));
          yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
          yield* Effect.promise(() =>
            writeFile(path.join(folder, 'existing.txt'), 'before restart'),
          );
          const setup = { storeRoot: root, picker: Effect.succeed(Option.some(folder)) };
          const parent = yield* withSessionsCustom(setup, (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const target = { agentId: fakeEntry().id, model: 'small' };
              yield* Settings.use((settings) =>
                settings.update({
                  defaultPermissionMode: 'ask',
                  coordinator: { coordinator: target, worker: target, verifier: target },
                }),
              );
              const id = yield* sessions.create(project);
              const originalTurn = yield* sessions.runWorkflow(
                id,
                text('coordinate-fixture:verify-approval'),
              );
              yield* liveState(
                id,
                (state) =>
                  state.workers?.some(
                    (role) => role.title === 'Verifier' && role.state === 'requiresAction',
                  ) === true,
              );
              return { id, originalTurn };
            }),
          );
          yield* withSessionsCustom(setup, () =>
            Effect.gen(function* () {
              const state = yield* liveState(parent.id, () => true);
              expect(state.runningTurn).toBeUndefined();
              expect(state.workers).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ title: 'Coordinator', stageOutcome: { _tag: 'done' } }),
                  expect.objectContaining({ title: 'Worker', stageOutcome: { _tag: 'done' } }),
                  expect.objectContaining({
                    title: 'Verifier',
                    stageOutcome: expect.objectContaining({
                      _tag: 'failed',
                      reason: 'interrupted',
                    }),
                  }),
                ]),
              );
              const restored = yield* untilTurnEnd(events(parent.id));
              const items = transcript(restored);
              expect(items).toContainEqual(
                expect.objectContaining({
                  _tag: 'TurnEnded',
                  outcome: expect.objectContaining({ reason: 'interrupted' }),
                }),
              );
              expect(state.verificationRetries).toEqual([
                { turnId: parent.originalTurn, originalTurnId: parent.originalTurn },
              ]);
              const afterSeq = seqs(restored).at(-1) ?? 0;
              const sessions = yield* Sessions;
              yield* Effect.promise(() =>
                writeFile(path.join(folder, 'existing.txt'), 'after restart'),
              );
              yield* sessions.runWorkflow(parent.id, [], parent.originalTurn);
              const request = yield* waitForVerificationApproval(parent.id, afterSeq);
              yield* sessions.answerPermission(parent.id, request, 'allow');
              expect(transcript(yield* untilTurnEnd(events(parent.id, afterSeq)))).toContainEqual(
                expect.objectContaining({ _tag: 'TurnEnded', outcome: { _tag: 'done' } }),
              );
              expect(
                yield* Effect.promise(() => readFile(path.join(folder, 'existing.txt'), 'utf8')),
              ).toBe('after restart');
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'rejects a stale workflow verdict and retries only verification against the original baseline',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const folder = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-workflow-retry-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );
          yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
          const outside = path.join(folder, 'outside.txt');
          yield* Effect.promise(() => writeFile(outside, 'original draft'));
          yield* Effect.sync(() => execFileSync('git', ['add', 'outside.txt'], { cwd: folder }));
          yield* Effect.sync(() =>
            execFileSync('git', ['update-index', '--assume-unchanged', 'outside.txt'], {
              cwd: folder,
            }),
          );
          yield* withSessionsCustom({ picker: Effect.succeed(Option.some(folder)) }, (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const target = { agentId: fakeEntry().id, model: 'small' };
              yield* Settings.use((settings) =>
                settings.update({
                  defaultPermissionMode: 'ask',
                  coordinator: { coordinator: target, worker: target, verifier: target },
                }),
              );
              const parent = yield* sessions.create(project);
              const originalTurn = yield* sessions.runWorkflow(
                parent,
                text('coordinate-fixture:verify-approval'),
              );
              const approval = yield* waitForVerificationApproval(parent);
              yield* Effect.promise(() => writeFile(outside, 'external edit'));
              yield* sessions.answerPermission(parent, approval, 'allow');
              const first = yield* untilTurnEnd(events(parent));
              expect(transcript(first)).toContainEqual(
                expect.objectContaining({
                  _tag: 'TurnEnded',
                  outcome: expect.objectContaining({ _tag: 'failed' }),
                }),
              );
              const availability = yield* liveState(
                parent,
                (state) => state.verificationRetries?.length === 1,
              ).pipe(Effect.timeout('5 seconds'));
              expect(availability.verificationRetries).toEqual([
                { turnId: originalTurn, originalTurnId: originalTurn },
              ]);
              const afterSeq = seqs(first).at(-1) ?? 0;
              yield* sessions.runWorkflow(parent, [], originalTurn);
              const approvalAgain = yield* waitForVerificationApproval(parent, afterSeq);
              yield* sessions.answerPermission(parent, approvalAgain, 'allow');
              expect(transcript(yield* untilTurnEnd(events(parent, afterSeq)))).toContainEqual(
                expect.objectContaining({
                  _tag: 'TurnEnded',
                  outcome: { _tag: 'done' },
                }),
              );
              const final = yield* liveState(parent, (state) => state.runningTurn === undefined);
              expect(final.verificationRetries ?? []).toEqual([]);
              const ineligible = yield* Effect.result(
                sessions.runWorkflow(parent, [], originalTurn),
              );
              expect(ineligible._tag).toBe('Failure');
              expect(final.workers?.map((worker) => worker.title).sort()).toEqual([
                'Coordinator',
                'Verifier',
                'Verifier',
                'Worker',
              ]);
              expect(
                yield* Effect.promise(() => readFile(path.join(folder, 'outside.txt'), 'utf8')),
              ).toBe('external edit');
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  for (const scenario of [
    {
      fixture: 'pass',
      title: 'Verification passed',
      detail: 'Repair checks passed',
      repair: true,
      passed: true,
    },
    {
      fixture: 'findings',
      title: 'Verification findings',
      detail: 'A follow-up issue remains',
      repair: true,
      passed: false,
    },
    {
      fixture: 'incomplete',
      title: 'Verification incomplete',
      detail: 'Required check blocked',
      repair: false,
      passed: false,
    },
    {
      fixture: 'post-incomplete',
      title: 'Verification incomplete',
      detail: 'Post-repair check blocked',
      repair: true,
      passed: false,
    },
  ]) {
    it.live(
      `handles workflow repair with ${scenario.fixture} verification`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const folder = yield* Effect.acquireRelease(
              Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-workflow-repair-'))),
              (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
            );
            yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
            yield* withSessionsCustom({ picker: Effect.succeed(Option.some(folder)) }, (project) =>
              Effect.gen(function* () {
                const sessions = yield* Sessions;
                const target = { agentId: fakeEntry().id, model: 'small' };
                yield* Settings.use((settings) =>
                  settings.update({
                    coordinator: { coordinator: target, worker: target, verifier: target },
                  }),
                );
                const parent = yield* sessions.create(project);
                const original = yield* sessions.runWorkflow(
                  parent,
                  text(`coordinate-fixture:repair-${scenario.fixture}`),
                );
                const initialResult = yield* untilTurnEnd(events(parent));
                const items = transcript(initialResult);
                expect(items).toContainEqual(
                  expect.objectContaining({
                    _tag: 'Notice',
                    title: scenario.title,
                    description: scenario.detail,
                  }),
                );
                expect(items).toContainEqual(
                  expect.objectContaining({
                    _tag: 'TurnEnded',
                    outcome: expect.objectContaining({ _tag: scenario.passed ? 'done' : 'failed' }),
                  }),
                );
                const live = yield* liveState(parent, (state) => state.runningTurn === undefined);
                expect(live.verificationRetries ?? []).toEqual(
                  scenario.passed ? [] : [{ turnId: original, originalTurnId: original }],
                );
                const roles = live.workers ?? [];
                const workers = roles.filter((role) => role.title === 'Worker');
                expect(workers).toHaveLength(1);
                expect(roles.filter((role) => role.title === 'Verifier')).toHaveLength(
                  scenario.repair ? 2 : 1,
                );
                const worker = workers[0];
                if (worker === undefined) return yield* Effect.die('Missing implementation Worker');
                const workerEvents = yield* SessionStore.use((store) =>
                  store.replay(worker.sessionId),
                );
                expect(workerEvents.filter(({ item }) => item._tag === 'TurnStarted')).toHaveLength(
                  scenario.repair ? 2 : 1,
                );
                expect(
                  yield* Effect.promise(() =>
                    readFile(path.join(folder, 'coordinator-fixture.txt'), 'utf8'),
                  ),
                ).toBe(
                  scenario.repair ? 'Repaired by the Worker\n' : 'Implemented by the Worker\n',
                );
                if (scenario.fixture === 'findings') {
                  const afterSeq = seqs(initialResult).at(-1) ?? 0;
                  yield* sessions.runWorkflow(parent, [], original);
                  const retry = transcript(yield* untilTurnEnd(events(parent, afterSeq)));
                  expect(retry).toContainEqual(
                    expect.objectContaining({
                      title: 'Verification findings',
                      description: 'A follow-up issue remains',
                    }),
                  );
                  const afterRetry = yield* SessionStore.use((store) =>
                    store.replay(worker.sessionId),
                  );
                  expect(afterRetry.filter(({ item }) => item._tag === 'TurnStarted')).toHaveLength(
                    2,
                  );
                }
              }),
            );
          }),
        ),
      TIMEOUT,
    );
  }

  for (const repair of [false, true]) {
    it.live(
      `runs Divide and Conquer in order with bounded handoffs (repair: ${repair})`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const folder = yield* Effect.acquireRelease(
              Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-divide-and-conquer-'))),
              (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
            );
            yield* Effect.sync(() => execFileSync('git', ['init', '-q'], { cwd: folder }));
            yield* withSessionsCustom(
              { picker: Effect.succeed(Option.some(folder)), agentArgs: ['--config-mode-only'] },
              (project) =>
                Effect.gen(function* () {
                  const sessions = yield* Sessions;
                  const small = { agentId: fakeEntry().id, model: 'small' };
                  const large = { ...small, model: 'large' };
                  yield* Settings.use((settings) =>
                    settings.update({
                      divideAndConquer: {
                        planner: large,
                        taskBreaker: small,
                        implementer: small,
                        verifier: large,
                      },
                    }),
                  );
                  const parent = yield* sessions.create(project);
                  yield* sessions.runWorkflow(
                    parent,
                    text(repair ? 'divide-fixture:repair' : 'divide-fixture'),
                    undefined,
                    'divide-and-conquer',
                  );
                  const items = transcript(yield* untilTurnEnd(events(parent)));
                  expect(
                    items.flatMap((item) => (item._tag === 'Notice' ? [item.title] : [])),
                  ).toEqual([
                    'Planning the implementation',
                    'Breaking the plan into tasks',
                    'Implementing the tasks',
                    'Verifying Worktree changes',
                    ...(repair
                      ? ['Repairing verification findings', 'Verifying Worktree changes']
                      : []),
                    'Verification passed',
                  ]);
                  expect(items).toContainEqual(
                    expect.objectContaining({ _tag: 'TurnEnded', outcome: { _tag: 'done' } }),
                  );
                  const live = yield* liveState(parent, (state) => state.runningTurn === undefined);
                  const roles = live.workers ?? [];
                  expect(roles.map(({ title, modelName }) => ({ title, modelName }))).toEqual(
                    expect.arrayContaining([
                      { title: 'Planner', modelName: 'Large' },
                      { title: 'Task Breaker', modelName: 'Small' },
                      { title: 'Implementer', modelName: 'Small' },
                      { title: 'Verifier', modelName: 'Large' },
                    ]),
                  );
                  expect(roles).toHaveLength(repair ? 5 : 4);
                  expect(roles.filter(({ title }) => title === 'Verifier')).toHaveLength(
                    repair ? 2 : 1,
                  );
                  const implementer = roles.find(({ title }) => title === 'Implementer');
                  if (implementer === undefined)
                    return yield* Effect.die('Missing Implementer Session');
                  const implementationEvents = yield* SessionStore.use((store) =>
                    store.replay(implementer.sessionId),
                  );
                  expect(
                    implementationEvents.filter(({ item }) => item._tag === 'TurnStarted'),
                  ).toHaveLength(repair ? 2 : 1);
                }),
            );
          }),
        ),
      TIMEOUT,
    );
  }

  it.live(
    'requires all Coordinator roles before starting a workflow Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          const result = yield* Effect.result(
            sessions.runWorkflow(parent, text('Implement the task')),
          );
          expect(result._tag).toBe('Failure');
          if (result._tag === 'Failure') expect(result.failure.detail).toContain('Settings');
          expect(yield* sessions.isDraft(parent)).toBe(true);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'delivers a delegated Worker reply to its Parent Session',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:echo:worker result'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(parent))))).toBe('worker result');
          const children = (yield* store.listAll).filter((meta) => meta.parentSessionId === parent);
          expect(children).toHaveLength(1);
          const child = children[0];
          if (child === undefined) return yield* Effect.die('Worker missing');
          expect(child.workerKind).toBe('owned');
          const lastSeq = (yield* store.replay(child.id)).at(-1)?.seq;
          yield* sessions.prompt(child.id, text('echo:follow up'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child.id, lastSeq))))).toBe(
            'follow up',
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'revokes the old delegation capability when a Session clears its context',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          yield* sessions.clearContext(parent);
          const status = yield* Effect.promise(() =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            }).then((response) => response.status),
          );
          expect(status).toBe(403);
        }),
      ),
    TIMEOUT,
  );
  for (const crossDeviceTools of [true, false]) {
    it.live(
      crossDeviceTools
        ? 'offers the cross-device tools to an Agent that can carry them'
        : 'withholds the cross-device tools from an Agent that cannot carry them, and keeps the others',
      () =>
        withSessionsCustom(
          {
            catalog: [
              fakeEntry([], {
                capabilities: { ...fakeEntry().capabilities, crossDeviceTools },
              }),
            ],
          },
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              const parent = yield* sessions.create(project);
              yield* sessions.prompt(parent, text('report-mcp-servers'));
              const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
              const [server]: ReadonlyArray<{
                url: string;
                headers: ReadonlyArray<{ name: string; value: string }>;
              }> = JSON.parse(report);
              if (server === undefined) return yield* Effect.die('Delegation server missing');
              const post = (body: unknown) =>
                Effect.promise(() =>
                  fetch(server.url, {
                    method: 'POST',
                    headers: Object.fromEntries(
                      server.headers.map(({ name, value }) => [name, value]),
                    ),
                    body: JSON.stringify(body),
                  }).then(async (response) => ({
                    status: response.status,
                    body: response.ok ? await response.json() : undefined,
                  })),
                );
              const listed = yield* post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
              const names = (
                listed.body as { result: { tools: ReadonlyArray<{ name: string }> } }
              ).result.tools.map((tool) => tool.name);
              const called = yield* post({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'list_targets', arguments: {} },
              });

              const crossDevice = ['list_targets'];
              expect(names).toEqual(
                expect.arrayContaining([
                  'delegate',
                  'list_sessions',
                  'send_message',
                  'start_session',
                  'await_result',
                ]),
              );
              expect(crossDevice.filter((name) => names.includes(name))).toEqual(
                crossDeviceTools ? crossDevice : [],
              );
              expect(called.status).toBe(crossDeviceTools ? 200 : 400);
            }),
        ),
      TIMEOUT,
    );
  }
  it.live(
    'deduplicates concurrent delegation retries in the same context',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          // A capability is only usable while its parent Turn is live. Keep one open across the calls.
          yield* sessions.prompt(parent, text('hold'));
          const call = () =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'delegate', arguments: { task: 'echo:once', requestId: 'retry' } },
              }),
            }).then((response) => response.json());
          const [first, second] = yield* Effect.promise(() => Promise.all([call(), call()]));
          expect(first.result.content[0].text).toBe('once');
          expect(second).toEqual(first);
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(1);
          yield* sessions.cancel(parent);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'creates new work for each delegated call without a retry key',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          yield* sessions.prompt(parent, text('hold'));
          const call = () =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: { name: 'delegate', arguments: { task: 'echo:fresh' } },
              }),
            }).then((response) => response.json());
          const [first, second] = yield* Effect.promise(() => Promise.all([call(), call()]));
          expect(first.result.content[0].text).toBe('fresh');
          expect(second.result.content[0].text).toBe('fresh');
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(2);
          yield* sessions.cancel(parent);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'rejects a delegated Worker call once the parent Turn has ended',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('report-mcp-servers'));
          const report = agentReply(transcript(yield* untilTurnEnd(events(parent))));
          const servers: ReadonlyArray<{
            url: string;
            headers: ReadonlyArray<{ name: string; value: string }>;
          }> = JSON.parse(report);
          const server = servers[0];
          if (server === undefined) return yield* Effect.die('Delegation server missing');
          const response = yield* Effect.promise(() =>
            fetch(server.url, {
              method: 'POST',
              headers: Object.fromEntries(server.headers.map(({ name, value }) => [name, value])),
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                  name: 'delegate',
                  arguments: { task: 'echo:stale', requestId: 'after-turn' },
                },
              }),
            }),
          );
          const body = yield* Effect.promise(() => response.json());
          expect(body.result.isError).toBe(true);
          expect(
            (yield* store.listAll).filter((meta) => meta.parentSessionId === parent),
          ).toHaveLength(0);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'shows an owned Worker waiting for permission',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: parent, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(parent, text('delegate:ask'));
          const waiting = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'requiresAction') === true,
          );
          const worker = waiting.workers?.find((item) => item.state === 'requiresAction');
          if (worker === undefined) return yield* Effect.die('Waiting Worker missing');
          yield* sessions.cancel(worker.sessionId);
        }),
      ),
    TIMEOUT,
  );
  /** How the Session's first Turn ended, once it has. */
  const firstOutcome = (id: SessionId) =>
    untilTurnEnd(events(id)).pipe(
      Effect.map((items) => {
        const ended = transcript(items).find((item) => item._tag === 'TurnEnded');
        return ended?._tag === 'TurnEnded' ? ended.outcome._tag : undefined;
      }),
    );
  const runningWorkers = (id: SessionId, count: number) =>
    liveState(
      id,
      (state) =>
        (state.workers ?? []).filter((worker) => worker.state === 'running').length === count,
    );
  it.live(
    'stopping a Parent Turn stops its nested working Workers through their own Sessions',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:delegate:busy'));
          const child = (yield* runningWorkers(parent, 1)).workers?.[0];
          if (child === undefined) return yield* Effect.die('Worker missing');
          const grandchild = (yield* runningWorkers(child.sessionId, 1)).workers?.[0];
          if (grandchild === undefined) return yield* Effect.die('Nested Worker missing');
          yield* sessions.cancel(parent);
          expect(yield* firstOutcome(grandchild.sessionId)).toBe('cancelled');
          expect(yield* firstOutcome(child.sessionId)).toBe('cancelled');
          yield* runningWorkers(parent, 0);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'stopping a Parent Turn stops a Worker waiting for permission',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: parent, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(parent, text('delegate:ask'));
          const waiting = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'requiresAction') === true,
          );
          const worker = waiting.workers?.find((item) => item.state === 'requiresAction');
          if (worker === undefined) return yield* Effect.die('Waiting Worker missing');
          yield* sessions.cancel(parent);
          expect(yield* firstOutcome(worker.sessionId)).toBe('cancelled');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'stopping one Worker leaves its Parent and its sibling running',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:busy&&busy'));
          const both = yield* runningWorkers(parent, 2);
          const [first, second] = both.workers ?? [];
          if (first === undefined || second === undefined) {
            return yield* Effect.die('Workers missing');
          }
          yield* sessions.cancel(first.sessionId);
          expect(yield* firstOutcome(first.sessionId)).toBe('cancelled');
          const after = yield* runningWorkers(parent, 1);
          expect(after.workers?.find((worker) => worker.state === 'running')?.sessionId).toBe(
            second.sessionId,
          );
          expect(after.runningTurn).toBeDefined();
          expect(after.cancelGrace).toBeUndefined();
          yield* sessions.cancel(parent);
          expect(yield* firstOutcome(second.sessionId)).toBe('cancelled');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'counts only direct working children: a grandchild is the Worker of its own parent, and siblings stay apart',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const other = yield* sessions.create(project);
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:delegate:busy'));
          yield* sessions.prompt(other, text('delegate:busy'));
          const parentState = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const child = parentState.workers?.find((worker) => worker.state === 'running');
          if (child === undefined) return yield* Effect.die('Child missing');
          const childState = yield* liveState(
            child.sessionId,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const grandchild = childState.workers?.find((worker) => worker.state === 'running');
          if (grandchild === undefined) return yield* Effect.die('Grandchild missing');
          const otherState = yield* liveState(
            other,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const sibling = otherState.workers?.[0];
          if (sibling === undefined) return yield* Effect.die('Sibling missing');
          expect(parentState.workers?.map((worker) => worker.sessionId)).toEqual([child.sessionId]);
          expect(childState.workers?.map((worker) => worker.sessionId)).toEqual([
            grandchild.sessionId,
          ]);
          expect(otherState.workers).toHaveLength(1);
          expect(sibling.sessionId).not.toBe(child.sessionId);
          expect((yield* store.get(grandchild.sessionId)).parentSessionId).toBe(child.sessionId);
          expect((yield* store.get(child.sessionId)).parentSessionId).toBe(parent);
          yield* sessions.cancel(grandchild.sessionId);
          yield* sessions.cancel(child.sessionId);
          yield* sessions.cancel(sibling.sessionId);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'routes a nested Worker permission request and answer to that Worker only',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: parent, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(parent, text('delegate:delegate:permit'));
          const parentState = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const child = parentState.workers?.find((worker) => worker.state === 'running');
          if (child === undefined) return yield* Effect.die('Child missing');
          const childState = yield* liveState(
            child.sessionId,
            (state) => state.workers?.some((worker) => worker.state === 'requiresAction') === true,
          );
          const grandchild = childState.workers?.find(
            (worker) => worker.state === 'requiresAction',
          );
          if (grandchild === undefined) return yield* Effect.die('Grandchild missing');
          const request = yield* permissionRequest(grandchild.sessionId, 'pending');
          expect((yield* liveState(parent, () => true)).status).toBe('working');
          expect((yield* liveState(child.sessionId, () => true)).status).toBe('working');
          expect((yield* liveState(grandchild.sessionId, () => true)).status).toBe('blocked');
          yield* sessions.answerPermission(grandchild.sessionId, request.id, 'allow');
          expect((yield* liveState(grandchild.sessionId, () => true)).status).not.toBe('blocked');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'tells the Parent which Agent runs a running Worker and when its run began',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:busy'));
          const running = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const worker = running.workers?.find((item) => item.state === 'running');
          expect(worker?.agentId).toBeDefined();
          expect(worker?.agentName).toBeTruthy();
          expect(typeof worker?.startedAt).toBe('number');
          expect(worker?.turnId).toBeDefined();
          if (worker === undefined) return yield* Effect.die('Owned Worker missing');
          yield* sessions.cancel(worker.sessionId);
          const idle = yield* liveState(
            parent,
            (state) => state.workers?.some((item) => item.state === 'idle') === true,
          );
          expect(idle.workers?.find((item) => item.state === 'idle')?.startedAt).toBeUndefined();
          expect(idle.workers?.find((item) => item.state === 'idle')?.turnId).toBe(worker.turnId);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'tracks an owned Worker through completion and a later Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:busy'));
          const running = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const worker = running.workers?.find((item) => item.state === 'running');
          if (worker === undefined) return yield* Effect.die('Owned Worker missing');
          yield* sessions.cancel(worker.sessionId);
          yield* liveState(
            parent,
            (state) =>
              state.workers?.some(
                (item) => item.sessionId === worker.sessionId && item.state === 'idle',
              ) === true,
          );
          yield* sessions.prompt(worker.sessionId, text('busy'));
          yield* liveState(
            parent,
            (state) =>
              state.workers?.some(
                (item) => item.sessionId === worker.sessionId && item.state === 'running',
              ) === true,
          );
          yield* sessions.cancel(worker.sessionId);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'deleting a Worker directly removes it from the Parent live Worker list and closes its Tab',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('delegate:busy'));
          const running = yield* liveState(
            parent,
            (state) => state.workers?.some((worker) => worker.state === 'running') === true,
          );
          const worker = running.workers?.find((item) => item.state === 'running');
          if (worker === undefined) return yield* Effect.die('Owned Worker missing');
          yield* sessions.cancel(worker.sessionId);
          yield* liveState(
            parent,
            (state) =>
              state.workers?.some(
                (item) => item.sessionId === worker.sessionId && item.state === 'idle',
              ) === true,
          );
          yield* sessions.setTabs(
            workspaceFor(project, [parent, worker.sessionId], worker.sessionId),
          );
          expect(yield* sessions.countWorkers(parent)).toBe(1);

          yield* sessions.remove(worker.sessionId);

          const after = yield* liveState(
            parent,
            (state) => state.workers?.some((item) => item.sessionId === worker.sessionId) !== true,
          );
          expect(after.workers ?? []).toEqual([]);
          expect([...allWorkspaceSessionIds((yield* sessions.restoreTabs).workspace)]).toEqual([
            parent,
          ]);
          expect(yield* sessions.countWorkers(parent)).toBe(0);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'opens an owned Worker as its own writable Session',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const parent = yield* sessions.create(project);
          const parentMeta = yield* store.get(parent);
          const child = SessionId.make('owned-child');
          const context = AgentContextId.make('owned-context');
          yield* store.createDraft({
            ...parentMeta,
            id: child,
            parentSessionId: parent,
            workerKind: 'owned',
            activeContextId: context,
            contexts: [
              {
                id: context,
                agentId: parentMeta.agentId,
                acpSessionIds: [],
                createdAt: parentMeta.createdAt,
              },
            ],
          });
          yield* sessions.prompt(child, text('echo:child reply'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(child))))).toBe('child reply');
          const state = yield* liveState(child, (current) => current.parentSessionId !== undefined);
          expect(state.workerKind).toBe('owned');
          expect(state.parentSessionId).toBe(parent);
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'discovers an announced Worker and routes its transcript through Sessions',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const parent = yield* sessions.create(project);
          yield* sessions.prompt(parent, text('spawn-worker'));
          const state = yield* liveState(parent, (current) => (current.workers?.length ?? 0) > 0);
          const worker = state.workers?.[0];
          expect(worker?.title).toBe('Research');
          if (worker === undefined) return yield* Effect.die('Worker missing');
          const reply = yield* events(worker.sessionId).pipe(
            Stream.filter(
              (item) => item._tag === 'Transcript' && item.event.item._tag === 'Message',
            ),
            Stream.runHead,
          );
          expect(agentReply(transcript(Option.toArray(reply)))).toBe('child output');
          const finished = yield* untilTurnEnd(events(worker.sessionId));
          expect(agentReply(transcript(finished))).toBe('child output');
          const idle = yield* liveState(
            parent,
            (current) => current.workers?.[0]?.state === 'idle',
          );
          expect(idle.workers?.map((item) => item.sessionId)).toEqual([worker.sessionId]);
          const error = yield* sessions.prompt(worker.sessionId, text('hello')).pipe(Effect.flip);
          expect(error.reason).toBe('Unsupported');
          const workerState = yield* liveState(
            worker.sessionId,
            (current) => current.parentSessionId !== undefined,
          );
          expect(workerState.parentSessionId).toBe(parent);
          expect(workerState.workerKind).toBe('native');
          expect((yield* sessions.list(project)).some((item) => item.id === worker.sessionId)).toBe(
            false,
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'assigns a fallback title while the first Turn is still running',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          expect((yield* store.get(id)).autoTitle).toBe('hold');
          expect((yield* liveState(id, () => true)).title.auto).toBe('hold');
          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'records an image-only first Message as an image title',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, [{ _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }]);
          yield* untilTurnEnd(events(id));
          expect(yield* store.get(id)).toMatchObject({
            autoTitleImageCount: 1,
            autoTitleIsPlaceholder: true,
          });

          const second = yield* sessions.create(project);
          yield* sessions.prompt(second, [
            { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            { _tag: 'image', mimeType: 'image/png', data: 'd29ybGQ=' },
          ]);
          yield* untilTurnEnd(events(second));
          expect(yield* store.get(second)).toMatchObject({
            autoTitleImageCount: 2,
            autoTitleIsPlaceholder: true,
          });
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'marks every Session as needing login when a prompt requires authentication',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          const second = yield* sessions.create(project);
          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');
          yield* sessions.prompt(first, text('login'));
          const end = yield* untilTurnEnd(events(first));
          expect(transcript(end)).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'needsLogin' }),
            }),
          );
          yield* agentStatus(first, 'needsLogin');
          yield* agentStatus(second, 'needsLogin');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'keeps the user title while the Agent replaces its automatic title',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.rename(id, 'Mine');
          yield* sessions.prompt(id, text('title:Agent title'));
          yield* untilTurnEnd(events(id));
          expect(yield* store.get(id)).toMatchObject({
            userTitle: 'Mine',
            autoTitle: 'Agent title',
            autoTitleIsPlaceholder: false,
          });
          yield* sessions.rename(id, '');
          expect((yield* liveState(id, (state) => state.title.user === undefined)).title.auto).toBe(
            'Agent title',
          );
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'renames a Session and restores its automatic title when cleared',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Hello'));
          yield* untilTurnEnd(events(id));
          yield* sessions.rename(id, 'Mine');
          expect((yield* store.get(id)).userTitle).toBe('Mine');
          yield* sessions.rename(id, '');
          expect((yield* store.get(id)).userTitle).toBeUndefined();
          expect((yield* store.get(id)).autoTitle).toBe('echo:Hello');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'uses the first Message as the automatic title after the first Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Hello   there\nsecond line'));
          yield* untilTurnEnd(events(id));
          expect((yield* store.get(id)).autoTitle).toBe('echo:Hello there');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'replaces the automatic title on session_info_update after Clear without adding Transcript items',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const store = yield* SessionStore;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:Initial prompt'));
          const first = yield* untilTurnEnd(events(id));
          expect((yield* store.get(id)).autoTitle).toBe('echo:Initial prompt');

          yield* sessions.clearContext(id);
          yield* sessions.prompt(id, text('title:After clear'));
          const second = yield* untilTurnEnd(events(id, seqs(first).at(-1)));
          expect(yield* store.get(id)).toMatchObject({
            autoTitle: 'After clear',
            autoTitleIsPlaceholder: false,
          });

          const countBeforeRename = second.filter((item) => item._tag === 'Transcript').length;
          yield* sessions.rename(id, 'User title');
          yield* sessions.rename(id, '');
          const afterRename = yield* untilTurnEnd(events(id, seqs(first).at(-1)));
          expect(afterRename.filter((item) => item._tag === 'Transcript')).toHaveLength(
            countBeforeRename,
          );
          expect((yield* store.get(id)).autoTitle).toBe('After clear');
        }),
      ),
    TIMEOUT,
  );
  it.live(
    'creates a Session while tab state is being saved',
    () =>
      Effect.gen(function* () {
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let pause = false;
        let readingState = false;
        let paused = false;
        yield* withSessions(
          (project) =>
            Effect.gen(function* () {
              const sessions = yield* Sessions;
              pause = true;
              const creating = yield* Effect.forkChild(sessions.create(project));
              yield* Deferred.await(reading);
              const saving = yield* Effect.forkChild(sessions.setTabs(EMPTY_WORKSPACE));
              yield* Effect.sleep('50 millis');
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(saving);
              const id = yield* Fiber.join(creating);
              expect(id).toBeDefined();
            }),
          (store) => ({
            ...store,
            readVersioned: (spec) =>
              Effect.suspend(() =>
                spec.file !== 'state.json' || !pause || paused
                  ? store.readVersioned(spec)
                  : Effect.gen(function* () {
                      paused = true;
                      readingState = true;
                      yield* Deferred.succeed(reading, undefined);
                      yield* Deferred.await(release);
                      const value = yield* store.readVersioned(spec);
                      readingState = false;
                      return value;
                    }),
              ),
            writeVersioned: (spec, value) =>
              spec.file === 'state.json' && readingState
                ? Effect.die('Windows cannot replace state.json during a read')
                : store.writeVersioned(spec, value),
          }),
        );
      }),
    TIMEOUT,
  );

  it.live(
    'streams a prompt as Message deltas and ends the Turn done',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const turnId = yield* sessions.prompt(id, text('echo:Hello there'));
          const items = yield* untilTurnEnd(events(id));

          expect(items[0]?._tag).toBe('Live');
          const kept = transcript(items);
          expect(kept[0]).toMatchObject({ _tag: 'TurnStarted', turnId });
          expect(kept[1]).toMatchObject({
            _tag: 'Message',
            role: 'user',
            parts: text('echo:Hello there'),
          });
          expect(kept.filter((item) => item._tag === 'MessageDelta').length).toBeGreaterThan(0);
          expect(agentReply(kept)).toBe('Hello there');
          expect(kept.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'done' },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'cancel asks the Agent to stop, and the Turn ends cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const turnId = yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          const working = AgentLifetime.use((lifetime) => lifetime.working);
          expect(yield* working).toBe(1);

          yield* sessions.cancel(id);

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'cancelled' },
          });
          // The Turn no longer holds the ACP session open.
          expect(yield* working).toBe(0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a stopped Turn ends its running Step cancelled, with files relative to the Project',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // `busy` leaves a command running until the cancel.
          yield* sessions.prompt(id, text('busy'));
          yield* events(id).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'Step' &&
                item.event.item.kind === 'execute',
            ),
            Stream.runHead,
          );

          yield* sessions.cancel(id);

          const kept = transcript(yield* untilTurnEnd(events(id)));
          const steps = kept.flatMap((item) => (item._tag === 'Step' ? [item] : []));
          expect(steps.at(-1)).toMatchObject({ kind: 'execute', status: 'cancelled' });
          expect(steps[0]).toMatchObject({ kind: 'read', files: ['src/view.ts'] });
          expect(kept.at(-1)).toMatchObject({ _tag: 'TurnEnded', outcome: { _tag: 'cancelled' } });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'moves an unsent draft to another folder and restarts its Agent there; refuses once a Turn ran',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (next) => next.agentStatus === 'ready');
          const original = yield* sessions.folderOf(id);

          yield* sessions.setDraftFolder(id, `${original}-linked`);

          expect(yield* sessions.folderOf(id)).toBe(`${original}-linked`);
          const restarted = yield* liveState(id, (next) => next.agentStatus === 'ready');
          expect(restarted.isDraft).toBe(true);

          yield* sessions.prompt(id, text('echo:hi'));
          yield* untilTurnEnd(events(id));
          const refused = yield* sessions.setDraftFolder(id, original).pipe(Effect.flip);
          expect(refused.reason).toBe('Busy');
          expect(yield* sessions.folderOf(id)).toBe(`${original}-linked`);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses a second prompt Busy while a Turn runs; cancel does nothing when idle',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.cancel(id);
          const runningTurn = yield* sessions.prompt(id, text('hold'));
          const snapshot = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(snapshot)).toMatchObject({ state: { runningTurn } });

          const second = yield* sessions.prompt(id, text('echo:again')).pipe(Effect.flip);
          expect(second.reason).toBe('Busy');

          yield* agentAnswering(id);
          yield* sessions.cancel(id);
          const lastSeq = seqs(yield* untilTurnEnd(events(id))).at(-1);
          // The Turn is over: the next prompt runs.
          yield* sessions.prompt(id, text('echo:again'));
          expect(agentReply(transcript(yield* untilTurnEnd(events(id, lastSeq))))).toBe('again');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a resubscription with afterSeq continues where the last one stopped, with no event twice',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('echo:first'));
          const before = yield* untilTurnEnd(events(id));

          // The renderer reloads: its stream is gone, and the new one asks for what came after.
          yield* sessions.prompt(id, text('echo:second'));
          const after = yield* untilTurnEnd(events(id, seqs(before).at(-1)));

          expect(after[0]?._tag).toBe('Live');
          const all = [...seqs(before), ...seqs(after)];
          expect(all).toEqual(all.map((_, index) => index + 1));
          expect(agentReply(transcript(after))).toBe('second');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'follows a new Session from the start, before its Agent is up, through its first Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // The renderer subscribes as soon as the Tab shows, while the Agent is still starting.
          const following = yield* untilTurnEnd(events(id)).pipe(Effect.forkChild);
          yield* sessions.prompt(id, text('echo:early'));

          const items = yield* Fiber.join(following);
          expect(items[0]).toMatchObject({ _tag: 'Live', state: { agentStatus: 'starting' } });
          expect(agentReply(transcript(items))).toBe('early');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a Stop while the Agent is still starting ends the Turn cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          // `hold` never ends on its own: only a cancel the Agent sees ends it.
          const prompting = yield* sessions.prompt(id, text('hold')).pipe(Effect.forkChild);
          const working = AgentLifetime.use((lifetime) => lifetime.working);
          yield* working.pipe(
            Effect.repeat({ until: (count) => count === 1, schedule: Schedule.spaced('5 millis') }),
          );
          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({ state: { agentStatus: 'starting' } });

          yield* sessions.cancel(id);

          const turnId = yield* Fiber.join(prompting);
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'cancelled' },
          });
          expect(yield* working).toBe(0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a draft whose Agent restarted before its first prompt keeps nothing but that prompt',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          yield* AcpClient.use((client) => client.disconnect(fakeEntry().id));
          const afterDisconnect = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(afterDisconnect.agentStatus).toBe('ready');

          const turnId = yield* sessions.prompt(id, text('echo:first'));

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept[0]).toMatchObject({ _tag: 'TurnStarted', turnId });
          expect(kept.some((item) => item._tag === 'ContextCleared')).toBe(false);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'shows the Agent Model, Effort and Commands, and a set option is what the next Turn runs with',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(
            id,
            (state) => state.agentStatus === 'ready' && state.commands.length > 0,
          );
          expect(ready.options.model).toEqual({
            value: 'small',
            choices: [
              { id: 'small', name: 'Small' },
              { id: 'large', name: 'Large' },
            ],
          });
          // The fake Agent has no `max`: the level is not offered.
          expect(ready.options.effort).toEqual({
            value: 'medium',
            choices: ['low', 'medium', 'high'],
          });
          // The Agent's own clear is advertised; the renderer reserves `/clear` for Spence.
          expect(ready.commands.map((command) => command.name)).toEqual([
            'clear',
            'compact',
            'review',
          ]);
          expect(ready.commands[0]).toMatchObject({
            owner: { kind: 'agent', name: fakeEntry().name },
            kind: 'command',
            invocation: '/clear',
          });
          expect(ready.commandsLoaded).toBe(true);

          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.setOption({ sessionId: id, option: 'model', value: 'large' });
          const set = yield* liveState(id, (state) => state.options.model?.value === 'large');
          expect(set.options.effort?.value).toBe('high');

          const turnId = yield* sessions.prompt(id, text('echo:hi'));
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept[0]).toEqual({
            _tag: 'TurnStarted',
            turnId,
            agentId: fakeEntry().id,
            model: 'large',
            effort: 'high',
            permissionMode: 'auto',
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'a new Session starts on the options last used with the Agent',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          yield* liveState(first, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: first, option: 'model', value: 'large' });
          yield* sessions.setOption({ sessionId: first, option: 'effort', value: 'low' });

          const second = yield* sessions.create(project);
          const ready = yield* liveState(second, (state) => state.agentStatus === 'ready');
          expect(ready.options.model?.value).toBe('large');
          expect(ready.options.effort?.value).toBe('low');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'Clear starts a fresh ACP session with the same options and marks it in the Transcript',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.prompt(id, text('echo:before'));
          const lastSeq = seqs(yield* untilTurnEnd(events(id))).at(-1);

          yield* sessions.clearContext(id);

          const meta = yield* SessionStore.use((store) => store.meta(id));
          expect(meta.contexts).toHaveLength(2);
          expect(meta.contexts[0]?.retiredAt).toBeTypeOf('number');
          expect(meta.contexts[1]?.id).toBe(meta.activeContextId);
          expect(meta.contexts[1]?.acpSessionIds[0]).not.toBe(meta.contexts[0]?.acpSessionIds[0]);
          const after = yield* events(id, lastSeq).pipe(Stream.take(2), Stream.runCollect);
          expect(transcript([...after])).toEqual([{ _tag: 'ContextCleared', reason: 'cleared' }]);
          const live = [...after][0];
          expect(live?._tag === 'Live' && live.state.options.effort?.value).toBe('high');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses Clear Busy while a Turn runs',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id);
          const error = yield* sessions.clearContext(id).pipe(Effect.flip);
          expect(error.reason).toBe('Busy');
          yield* sessions.cancel(id);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'does not create a Session in an unknown Project',
    () =>
      withSessions(() =>
        Effect.gen(function* () {
          const error = yield* Sessions.use((s) => s.create(ProjectId.make('nope'))).pipe(
            Effect.flip,
          );
          expect(error.reason).toBe('NotFound');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'fails only running Sessions with agentStopped and stderr tail on crash; idle Sessions stay ready and resume on next prompt',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const crashing = yield* sessions.create(project);
          const idle = yield* sessions.create(project);
          yield* agentStatus(crashing, 'ready');
          yield* agentStatus(idle, 'ready');
          // Give `idle` a prior Turn so its next prompt after the crash resumes cleanly.
          yield* sessions.prompt(idle, text('echo:before'));
          const beforeEnd = yield* untilTurnEnd(events(idle));
          const afterSeq = seqs(beforeEnd).at(-1);

          const crashTurn = yield* sessions.prompt(crashing, text('crash'));
          const crashedEnd = yield* untilTurnEnd(events(crashing));
          const crashedOutcome = transcript(crashedEnd).find(
            (item): item is Extract<TranscriptItem, { _tag: 'TurnEnded' }> =>
              item._tag === 'TurnEnded' && item.turnId === crashTurn,
          )?.outcome;
          expect(crashedOutcome).toMatchObject({ _tag: 'failed', reason: 'agentStopped' });
          if (crashedOutcome?._tag === 'failed') {
            expect(crashedOutcome.detail).toContain('exit code 3');
            expect(crashedOutcome.detail).toMatch(/fake agent \d+ up/);
          }
          yield* agentStatus(crashing, 'stopped');

          // The idle Session never transitions to `stopped` and handles the next prompt cleanly.
          const idleLive = yield* events(idle, afterSeq).pipe(Stream.runHead);
          expect(Option.getOrUndefined(idleLive)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'ready' },
          });
          yield* sessions.prompt(idle, text('echo:after'));
          const resumed = transcript(yield* untilTurnEnd(events(idle, afterSeq)));
          expect(agentReply(resumed)).toBe('after');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'publishes agentId, agentPackage and terminal authMethods in LiveState',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.agentId).toBe(fakeEntry().id);
          expect(ready.agentPackage).toBe(fakeEntry().package);
          expect(ready.cantStartReason).toBeUndefined();
          expect(ready.authMethods).toEqual([
            {
              id: 'login',
              name: 'Log in with Browser',
              description: 'Open browser to log in',
              command: 'fake-agent --extra-auth --login-mode',
            },
            {
              id: 'api-key',
              name: 'API Key',
              description: 'Use an API key',
              command: 'fake-agent --extra-auth --login-key',
            },
          ]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks cantStart with cantStartReason protocolVersion when the Agent speaks ACP 2',
    () =>
      withSessionsCustom({ agentArgs: ['--protocol=2'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'cantStart');
          expect(state.cantStartReason).toBe('protocolVersion');
          expect(state.agentPackage).toBe(fakeEntry().package);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks cantStart with cantStartReason spawn when the Agent exits during initialize',
    () =>
      withSessionsCustom({ agentArgs: ['--fail-init'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'cantStart');
          expect(state.cantStartReason).toBe('spawn');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'marks notInstalled when the Agent binary vanishes from PATH before spawn',
    () =>
      withSessionsCustom({}, (project, install) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          yield* Effect.promise(() => rm(install.bin, { recursive: true, force: true }));
          const id = yield* sessions.create(project);
          const state = yield* liveState(id, (next) => next.agentStatus === 'notInstalled');
          expect(state.agentId).toBe(fakeEntry().id);
          expect(state.agentPackage).toBe(fakeEntry().package);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'surfaces -32603 as failed agentError with verbatim detail and keeps agentStatus ready',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          const turnId = yield* sessions.prompt(id, text('error'));
          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept.at(-1)).toMatchObject({
            _tag: 'TurnEnded',
            turnId,
            outcome: { _tag: 'failed', reason: 'agentError', detail: 'API Error: overloaded' },
          });
          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'ready' },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'loginAgent runs the first authMethod, disconnects the Agent, and restores every open Session to ready without sending anything',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const first = yield* sessions.create(project);
          const second = yield* sessions.create(project);
          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');

          yield* sessions.prompt(first, text('login'));
          const loginEnd = yield* untilTurnEnd(events(first));
          const afterSeqFirst = seqs(loginEnd).at(-1);
          yield* agentStatus(first, 'needsLogin');
          yield* agentStatus(second, 'needsLogin');
          // A Session opened while the Agent needs login also starts in needsLogin.
          const late = yield* sessions.create(project);
          yield* agentStatus(late, 'needsLogin');

          yield* sessions.loginAgent(first);

          yield* agentStatus(first, 'ready');
          yield* agentStatus(second, 'ready');
          yield* agentStatus(late, 'ready');
          // Nothing was sent automatically after login completed.
          const after = yield* events(first, afterSeqFirst).pipe(Stream.take(1), Stream.runCollect);
          expect(transcript([...after])).toEqual([]);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'interrupting loginAgent kills the login process and leaves the Session in needsLogin',
    () =>
      withSessionsCustom({ agentArgs: ['--extra-auth', '--login-hold'] }, (project, install) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* agentStatus(id, 'ready');
          yield* sessions.prompt(id, text('login'));
          yield* untilTurnEnd(events(id));
          yield* agentStatus(id, 'needsLogin');

          const fiber = yield* Effect.forkChild(sessions.loginAgent(id));
          // Wait until the login child process writes to stderr (recorded in fake.log).
          yield* Effect.promise(async () => {
            const logPath = path.join(install.logs, 'fake.log');
            for (let i = 0; i < 50; i++) {
              const content = await readFile(logPath, 'utf8').catch(() => '');
              if (content.includes('login waiting')) return;
              await new Promise((r) => setTimeout(r, 50));
            }
          });
          yield* Fiber.interrupt(fiber);

          const live = yield* events(id).pipe(Stream.runHead);
          expect(Option.getOrUndefined(live)).toMatchObject({
            _tag: 'Live',
            state: { agentStatus: 'needsLogin' },
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'persists Step timing, structured payloads, 32 KB rolling tail, and exitCode across reopen',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-step-details-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const setup = { storeRoot: root };
        const sessionId = yield* withSessionsCustom(setup, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* sessions.prompt(id, text('step-details'));
            const kept = transcript(yield* untilTurnEnd(events(id)));
            const steps = kept.filter(
              (item): item is Extract<TranscriptItem, { _tag: 'Step' }> => item._tag === 'Step',
            );
            const execDone = steps.find(
              (step) => step.kind === 'execute' && step.status === 'failed',
            );
            expect(execDone).toBeDefined();
            expect(execDone?.startedAt).toBeTypeOf('number');
            expect(execDone?.endedAt).toBeTypeOf('number');
            expect((execDone?.endedAt ?? 0) - (execDone?.startedAt ?? 0)).toBeGreaterThanOrEqual(
              15,
            );
            expect(execDone?.cwd).toContain('pkg');
            expect(execDone?.input).toBe('npm test -- --run');
            expect(execDone?.exitCode).toBe(2);
            expect(execDone?.outputTruncated).toBe(true);
            expect(Buffer.byteLength(execDone?.output ?? '', 'utf8')).toBeLessThanOrEqual(32_768);
            expect(execDone?.output.endsWith('TAIL_END')).toBe(true);

            const editDone = steps.find((step) => step.kind === 'edit' && step.status === 'done');
            expect(editDone?.diffs).toEqual([
              { path: 'src/a.ts', before: 'const a = 1;', after: 'const a = 2;' },
            ]);
            return id;
          }),
        );

        // Reopen Spence from disk and verify the Transcript retains all Step timing and payload fields.
        yield* withSessionsCustom(setup, () =>
          Effect.gen(function* () {
            const kept = transcript(yield* untilTurnEnd(events(sessionId)));
            const execDone = kept.find(
              (item): item is Extract<TranscriptItem, { _tag: 'Step' }> =>
                item._tag === 'Step' && item.kind === 'execute' && item.status === 'failed',
            );
            expect(execDone).toBeDefined();
            expect(execDone?.startedAt).toBeTypeOf('number');
            expect(execDone?.endedAt).toBeTypeOf('number');
            expect(execDone?.cwd).toContain('pkg');
            expect(execDone?.input).toBe('npm test -- --run');
            expect(execDone?.exitCode).toBe(2);
            expect(execDone?.outputTruncated).toBe(true);
            expect(execDone?.output.endsWith('TAIL_END')).toBe(true);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'normalizes Permission request edit Step relative to the Session cwd before tool_call_update',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('permit-edit'));
          const pending = yield* permissionRequest(id, 'pending');
          yield* sessions.answerPermission(id, pending.id, 'allow');

          const kept = transcript(yield* untilTurnEnd(events(id)));
          expect(kept).toContainEqual(
            expect.objectContaining({
              _tag: 'Step',
              id: pending.stepId,
              kind: 'edit',
              files: ['src/perm.ts'],
              diffs: [{ path: 'src/perm.ts', before: 'before', after: 'after' }],
            }),
          );
        }),
      ),
    TIMEOUT,
  );
});

const isPidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('Sessions ACP terminal hosting', () => {
  it.live(
    'streams live StepDelta tails, sets exitCode without wiping on later updates, and survives reopen',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-term-session-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const setup = { storeRoot: root };
        const sessionId = yield* withSessionsCustom(setup, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* sessions.prompt(id, text('terminal-stream-fail'));
            const kept = transcript(yield* untilTurnEnd(events(id)));

            const deltas = kept.filter(
              (item): item is Extract<TranscriptItem, { _tag: 'StepDelta' }> =>
                item._tag === 'StepDelta',
            );
            expect(deltas.length).toBeGreaterThanOrEqual(1);
            const combinedOutput = deltas.map((d) => d.output).join('');
            expect(combinedOutput).toContain('first-line\n');
            expect(combinedOutput).toContain('second-line\n');

            const lastStep = [...kept]
              .reverse()
              .find(
                (item): item is Extract<TranscriptItem, { _tag: 'Step' }> =>
                  item._tag === 'Step' && item.kind === 'execute',
              );
            expect(lastStep).toBeDefined();
            expect(lastStep?.status).toBe('failed');
            expect(lastStep?.exitCode).toBe(2);
            expect(lastStep?.output).toBe('');
            return id;
          }),
        );

        // Reopen and verify persisted StepDelta items replay cleanly alongside the Step.
        yield* withSessionsCustom(setup, () =>
          Effect.gen(function* () {
            const kept = transcript(yield* untilTurnEnd(events(sessionId)));
            const deltas = kept.filter(
              (item): item is Extract<TranscriptItem, { _tag: 'StepDelta' }> =>
                item._tag === 'StepDelta',
            );
            expect(deltas.map((d) => d.output).join('')).toContain('first-line\n');
            expect(deltas.map((d) => d.output).join('')).toContain('second-line\n');
            const lastStep = [...kept]
              .reverse()
              .find(
                (item): item is Extract<TranscriptItem, { _tag: 'Step' }> =>
                  item._tag === 'Step' && item.kind === 'execute',
              );
            expect(lastStep?.exitCode).toBe(2);
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'caps buffered terminal output at 32 KB with truncated flag and rejects cwd outside Session root',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);

          yield* sessions.prompt(id, text('terminal-truncate'));
          const turn1Stream = yield* untilTurnEnd(events(id));
          const truncatedKept = transcript(turn1Stream);
          const deltas = truncatedKept.filter(
            (item): item is Extract<TranscriptItem, { _tag: 'StepDelta' }> =>
              item._tag === 'StepDelta',
          );
          const combined = deltas.map((d) => d.output).join('');
          expect(deltas.some((d) => d.truncated === true)).toBe(true);
          expect(Buffer.byteLength(combined, 'utf8')).toBeLessThanOrEqual(32_768);
          expect(combined.endsWith('TAIL_OK')).toBe(true);
          const truncatedStep = [...truncatedKept]
            .reverse()
            .find(
              (item): item is Extract<TranscriptItem, { _tag: 'Step' }> =>
                item._tag === 'Step' && item.kind === 'execute',
            );
          expect(truncatedStep?.exitCode).toBe(0);

          const afterTurn1 = seqs(turn1Stream).at(-1);
          yield* sessions.prompt(id, text('terminal-cwd-outside'));
          const outsideKept = transcript(yield* untilTurnEnd(events(id, afterTurn1)));
          expect(agentReply(outsideKept)).toContain('rejected:');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'kills unreleased terminal process trees on Turn cancel and Stop Agent',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tempDir = yield* Effect.acquireRelease(
            Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-term-pid-'))),
            (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
          );

          // 1. Turn cancel cleans up unreleased terminal process tree
          const id1 = yield* sessions.create(project);
          const pidFile1 = path.join(tempDir, 'pid1.txt');
          yield* sessions.prompt(id1, text(`terminal-hold:${pidFile1}`));
          yield* events(id1).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'StepDelta' &&
                item.event.item.output.includes('holding'),
            ),
            Stream.runHead,
          );
          const pid1 = Number.parseInt(yield* Effect.promise(() => readFile(pidFile1, 'utf8')), 10);
          expect(isPidRunning(pid1)).toBe(true);
          yield* sessions.cancel(id1);
          yield* untilTurnEnd(events(id1));
          expect(isPidRunning(pid1)).toBe(false);

          // 2. Stop Agent cleans up unreleased terminal process tree
          const id2 = yield* sessions.create(project);
          const pidFile2 = path.join(tempDir, 'pid2.txt');
          yield* sessions.prompt(id2, text(`terminal-hold:${pidFile2}`));
          yield* events(id2).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'StepDelta' &&
                item.event.item.output.includes('holding'),
            ),
            Stream.runHead,
          );
          const pid2 = Number.parseInt(yield* Effect.promise(() => readFile(pidFile2, 'utf8')), 10);
          expect(isPidRunning(pid2)).toBe(true);
          yield* sessions.stopAgent(id2, true);
          yield* untilTurnEnd(events(id2));
          expect(isPidRunning(pid2)).toBe(false);

          // 3. App quit (`AgentLifetime.quit`) cleans up unreleased terminal process tree
          const id3 = yield* sessions.create(project);
          const pidFile3 = path.join(tempDir, 'pid3.txt');
          yield* sessions.prompt(id3, text(`terminal-hold:${pidFile3}`));
          yield* events(id3).pipe(
            Stream.filter(
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'StepDelta' &&
                item.event.item.output.includes('holding'),
            ),
            Stream.runHead,
          );
          const pid3 = Number.parseInt(yield* Effect.promise(() => readFile(pidFile3, 'utf8')), 10);
          expect(isPidRunning(pid3)).toBe(true);
          yield* (yield* AgentLifetime).quit;
          yield* untilTurnEnd(events(id3));
          expect(isPidRunning(pid3)).toBe(false);
        }).pipe(Effect.scoped),
      ),
    TIMEOUT,
  );
});

describe('Unified SessionStatus, lastTurn, quit confirmation, and blob-free snapshots', () => {
  it.live(
    'tracks lastTurn across done, refused, cutShort, cancelled, and failed, and clears it on clearContext',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);

          // Unprompted draft starts idle with no lastTurn.
          const initial = yield* liveState(id, () => true);
          expect(initial.status).toBe('idle');
          expect(initial.lastTurn).toBeUndefined();

          // 1. done
          const doneTurn = yield* sessions.prompt(id, text('echo:hello'));
          let seq = seqs(yield* untilTurnEnd(events(id))).at(-1) ?? 0;
          const afterDone = yield* liveState(id, () => true);
          expect(afterDone.status).toBe('idle');
          expect(afterDone.lastTurn).toEqual({ turnId: doneTurn, outcome: 'done' });

          // 2. refused
          const refusedTurn = yield* sessions.prompt(id, text('refuse'));
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const afterRefuse = yield* liveState(id, () => true);
          expect(afterRefuse.status).toBe('idle');
          expect(afterRefuse.lastTurn).toEqual({ turnId: refusedTurn, outcome: 'refused' });

          // 3. cutShort
          const cutShortTurn = yield* sessions.prompt(id, text('max-tokens'));
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const afterCutShort = yield* liveState(id, () => true);
          expect(afterCutShort.status).toBe('idle');
          expect(afterCutShort.lastTurn).toEqual({ turnId: cutShortTurn, outcome: 'cutShort' });

          // 4. cancelled
          const cancelledTurn = yield* sessions.prompt(id, text('hold'));
          yield* agentAnswering(id, seq);
          expect((yield* liveState(id, () => true)).status).toBe('working');
          yield* sessions.cancel(id);
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const afterCancel = yield* liveState(id, () => true);
          expect(afterCancel.status).toBe('idle');
          expect(afterCancel.lastTurn).toEqual({ turnId: cancelledTurn, outcome: 'cancelled' });

          // 5. failed -> status error until next Turn or clearContext
          const failedTurn = yield* sessions.prompt(id, text('crash'));
          yield* untilTurnEnd(events(id, seq));
          const afterFail = yield* liveState(id, () => true);
          expect(afterFail.status).toBe('error');
          expect(afterFail.lastTurn).toEqual({ turnId: failedTurn, outcome: 'failed' });

          // clearContext clears lastTurn and resets status to idle
          yield* sessions.clearContext(id);
          const afterClear = yield* liveState(
            id,
            (state) => state.lastTurn === undefined && state.status === 'idle',
          );
          expect(afterClear.lastTurn).toBeUndefined();
          expect(afterClear.status).toBe('idle');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'keeps AgentLifetime.working > 0 when blocked on mid-Turn Permission request and archives to idle',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const lifetime = yield* AgentLifetime;
          const id = yield* sessions.create(project);
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });

          yield* sessions.prompt(id, text('permit'));
          const pending = yield* permissionRequest(id, 'pending');
          expect((yield* liveState(id, () => true)).status).toBe('blocked');
          // Quitting Spence still asks for confirmation while blocked mid-Turn.
          expect(yield* lifetime.working).toBe(1);
          expect((yield* lifetime.workingSessions).has(id)).toBe(true);

          yield* sessions.answerPermission(id, pending.id, 'allow');
          const firstEnd = yield* untilTurnEnd(events(id));
          const seq = seqs(firstEnd).at(-1) ?? 0;
          expect(yield* lifetime.working).toBe(0);
          expect((yield* liveState(id, () => true)).status).toBe('idle');

          // Compaction sets status working, then returns to idle.
          yield* sessions.compact(id);
          yield* liveState(id, (state) => state.compacting === true && state.status === 'working');
          yield* liveState(id, (state) => state.compacting !== true && state.status === 'idle');

          // Failed Turn -> error, then archiving forces idle everywhere.
          yield* sessions.prompt(id, text('crash'));
          yield* untilTurnEnd(events(id, seq));
          expect((yield* liveState(id, () => true)).status).toBe('error');
          yield* sessions.archive(id);
          expect((yield* liveState(id, () => true)).status).toBe('idle');
          expect((yield* sessions.list(project)).find((s) => s.id === id)?.status).toBe('idle');
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'does not read image blobs or re-read transcript.jsonl during snapshot updates or Sessions.list',
    () => {
      let blobReads = 0;
      let transcriptReads = 0;
      return withSessions(
        (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const store = yield* SessionStore;
            const id = yield* sessions.create(project);
            yield* sessions.prompt(id, [
              { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
              { _tag: 'text', text: 'echo:with-image' },
            ]);
            yield* untilTurnEnd(events(id));
            yield* store.flush(id);

            blobReads = 0;
            transcriptReads = 0;

            // Multiple state updates (snapshot) and Sessions.list calls should hit zero disk blob/transcript reads.
            yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
            yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'low' });
            const listed1 = yield* sessions.list(project);
            const listed2 = yield* sessions.list(project);
            expect(listed1.find((s) => s.id === id)?.status).toBe('idle');
            expect(listed2.find((s) => s.id === id)?.status).toBe('idle');
            expect(blobReads).toBe(0);
            expect(transcriptReads).toBe(0);
          }),
        (base) => ({
          ...base,
          getBlob: (dir, hash) => {
            blobReads += 1;
            return base.getBlob(dir, hash);
          },
          readLines: (file, schema) => {
            if (file.endsWith('transcript.jsonl')) transcriptReads += 1;
            return base.readLines(file, schema);
          },
        }),
      );
    },
    TIMEOUT,
  );
});
