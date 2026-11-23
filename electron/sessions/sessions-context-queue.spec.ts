import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  type SessionId,
  type QueuedMessage,
  type SessionStreamItem,
  type TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';
import { EMPTY_WORKSPACE } from '../../src/shared/tabs/workspace-layout';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { type AgentLifetime, layerAgentLifetime } from '../acp/acpLifetime';
import { type AcpClient } from '../acp/acpSessionManager';
import { layerAgents } from '../agents/agents';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { makeFakeBrowserHost } from '../browser/browser-host-fake';
import { layerBrowserService } from '../browser/browser-service';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore, type Store } from '../store/store';
import { layerDeleteQueue } from './delete-queue';
import { layerSessionStore, type SessionStore } from './session-store';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessions, Sessions } from './sessions';
import {
  TIMEOUT,
  PROJECT_FOLDER,
  withSessionsCustom,
  withSessions,
  text,
  workspaceFor,
  untilTurnEnd,
  transcript,
  agentReply,
  events,
  seqs,
  agentAnswering,
  liveState,
  userTexts,
  steeredTexts,
  until,
  isSteerMessage,
  isPendingPermission,
} from './sessions-spec-fakes';

describe('ContextUsage lifecycle in Sessions', () => {
  const runOnRoot = <A, E>(
    root: string,
    install: { readonly bin: string; readonly logs: string },
    agentArgs: ReadonlyArray<string> | undefined,
    body: (
      project: ProjectId,
    ) => Effect.Effect<
      A,
      E,
      Sessions | Projects | AgentLifetime | AcpClient | SessionStore | Store
    >,
  ) =>
    Effect.gen(function* () {
      const store = layerStore(root);
      const sessionStore = layerSessionStore.pipe(Layer.provide(store));
      const projects = layerProjects.pipe(
        Layer.provide(sessionStore),
        Layer.provide(store),
        Layer.provide(
          Layer.succeed(Folders, {
            platform: process.platform,
            realPath: (folder) => Effect.succeed(Option.some(folder)),
            exists: () => Effect.succeed(true),
          }),
        ),
        Layer.provide(
          Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(PROJECT_FOLDER)) }),
        ),
      );
      const remembered = layerRemembered.pipe(Layer.provide(store));
      const settings = layerSettings.pipe(
        Layer.provide(remembered),
        Layer.provide(
          Layer.succeed(WindowSettings, {
            applyTheme: () => Effect.void,
            applyLanguage: () => Effect.void,
          }),
        ),
        Layer.provide(store),
      );
      const acpClient = layerAcpClientWithFakeAgent(install);
      const agentsLayer = layerAgents.pipe(
        Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
        Layer.provide(layerPathSources),
      );
      const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
      const layer = layerSessions.pipe(
        Layer.provideMerge(projects),
        Layer.provideMerge(sessionStore),
        Layer.provideMerge(remembered),
        Layer.provideMerge(deleteQueue),
        Layer.provideMerge(store),
        Layer.provide(settings),
        Layer.provide(agentsLayer),
        Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
        Layer.provide(
          layerBrowserService.pipe(
            Layer.provide(makeFakeBrowserHost().layer),
            Layer.provide(settings),
          ),
        ),
        Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry(agentArgs)]))),
      );
      return yield* Effect.gen(function* () {
        const list = yield* Projects.use((p) => p.list);
        const existing = list[0];
        const project = existing ?? (yield* Projects.use((p) => p.add));
        if (project === null) return yield* Effect.die('the picker answered nothing');
        return yield* body(project.id);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped);

  const sendAndEnd = (id: SessionId, message: string, afterSeq: number) =>
    Effect.gen(function* () {
      yield* yieldTurn(id, message);
      const items = yield* untilTurnEnd(events(id, afterSeq));
      return seqs(items).at(-1) ?? afterSeq;
    });

  const yieldTurn = (id: SessionId, message: string) =>
    Sessions.use((sessions) => sessions.prompt(id, text(message)));

  it.live(
    'maps reported, over-capacity, and countOnly usage_update and ignores cumulative Usage',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const initial = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(initial.contextUsage).toEqual({ _tag: 'unavailable' });

          // Cumulative PromptResponse.usage must never populate ContextUsage.
          let seq = yield* sendAndEnd(id, 'cumulative-only', 0);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });

          seq = yield* sendAndEnd(id, 'usage:24000/200000', seq);
          const reported = yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');
          expect(reported.contextUsage).toEqual({
            _tag: 'reported',
            used: 24_000,
            capacity: 200_000,
          });

          // Over-capacity (>100%) is preserved without clamping.
          seq = yield* sendAndEnd(id, 'usage:210000/200000', seq);
          const over = yield* liveState(
            id,
            (state) =>
              state.contextUsage?._tag === 'reported' && state.contextUsage.used === 210_000,
          );
          expect(over.contextUsage).toEqual({
            _tag: 'reported',
            used: 210_000,
            capacity: 200_000,
          });

          // Missing / zero capacity yields countOnly.
          yield* sendAndEnd(id, 'usage:12000/0', seq);
          const countOnly = yield* liveState(
            id,
            (state) => state.contextUsage?._tag === 'countOnly',
          );
          expect(countOnly.contextUsage).toEqual({ _tag: 'countOnly', used: 12_000 });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'invalidates ContextUsage immediately on Clear and Model change, but preserves it on Effort/Permission change',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          let seq = yield* sendAndEnd(id, 'usage:24000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Effort and permissionMode changes keep the current reading.
          yield* sessions.setOption({ sessionId: id, option: 'effort', value: 'high' });
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'reported',
            used: 24_000,
            capacity: 200_000,
          });

          // Model change invalidates immediately.
          yield* sessions.setOption({ sessionId: id, option: 'model', value: 'large' });
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });

          yield* sendAndEnd(id, 'usage:15000/200000', seq);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Clear invalidates immediately.
          yield* sessions.clearContext(id);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({ _tag: 'unavailable' });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'transitions through waiting during compaction and reverts to historical on failure or cancellation',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          let seq = yield* sendAndEnd(id, 'usage:50000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Failed compaction leaves prior reading historical.
          seq = yield* sendAndEnd(id, 'compact-fail', seq);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'historical',
            used: 50_000,
            capacity: 200_000,
          });

          // Successful compaction without usage_update stays waiting until a report arrives.
          seq = yield* sendAndEnd(id, 'compact-ok', seq);
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'waiting',
            prior: { used: 50_000, capacity: 200_000 },
          });

          // Cancelled compaction restores historical reading.
          yield* sessions.prompt(id, text('compact-cancel'));
          yield* until(
            events(id, seq),
            (item) =>
              item._tag === 'Transcript' &&
              item.event.item._tag === 'Compaction' &&
              item.event.item.status === 'running',
          );
          yield* sessions.cancel(id);
          const cancelledItems = yield* untilTurnEnd(events(id, seq));
          seq = seqs(cancelledItems).at(-1) ?? seq;
          expect((yield* liveState(id, () => true)).contextUsage).toEqual({
            _tag: 'historical',
            used: 50_000,
            capacity: 200_000,
          });

          // Compaction followed by usage_update updates to the new reported reading.
          yield* sendAndEnd(id, 'compact-ok:12000/200000', seq);
          const updated = yield* liveState(
            id,
            (state) =>
              state.contextUsage?._tag === 'reported' && state.contextUsage.used === 12_000,
          );
          expect(updated.contextUsage).toEqual({
            _tag: 'reported',
            used: 12_000,
            capacity: 200_000,
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'restores saved ContextUsage as historical on reopen, ignores invalid payloads, and invalidates on lost memory',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-context-reopen-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        let sessionId!: SessionId;

        yield* runOnRoot(root, install, undefined, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            sessionId = yield* sessions.create(project);
            yield* liveState(sessionId, (state) => state.agentStatus === 'ready');
            yield* sessions.prompt(sessionId, text('usage:24000/200000'));
            yield* liveState(sessionId, (state) => state.contextUsage?._tag === 'reported');
            yield* untilTurnEnd(events(sessionId));
          }),
        );

        // Second run: reopen succeeds (resume), saved reading starts historical; invalid usage_update never overwrites it.
        yield* runOnRoot(root, install, undefined, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const beforeTab = yield* liveState(sessionId, () => true);
            expect(beforeTab.contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });
            yield* sessions.setTabs(workspaceFor(project, [sessionId], sessionId));
            const afterResume = yield* liveState(
              sessionId,
              (state) => state.agentStatus === 'ready',
            );
            expect(afterResume.contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });

            // Invalid payload (-1) must not overwrite the historical reading.
            yield* sessions.prompt(sessionId, text('usage:-1/200000'));
            yield* untilTurnEnd(events(sessionId));
            expect((yield* liveState(sessionId, () => true)).contextUsage).toEqual({
              _tag: 'historical',
              used: 24_000,
              capacity: 200_000,
            });
          }),
        );

        // Third run: resume and load both fail -> memory lost -> historical reading invalidated to unavailable.
        yield* runOnRoot(root, install, ['--fail-resume', '--fail-load'], (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            yield* sessions.setTabs(workspaceFor(project, [sessionId], sessionId));
            const afterLost = yield* liveState(sessionId, (state) => state.agentStatus === 'ready');
            expect(afterLost.contextUsage).toEqual({ _tag: 'unavailable' });
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'streams user-triggered Session.compact, transitions ContextUsage, and blocks Busy while a Turn or PermissionRequest runs',
    () =>
      withSessionsCustom({ agentArgs: ['--compact-usage=12000/200000'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.capabilities?.supportsCompaction).toBe(true);

          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          let seq = yield* sendAndEnd(id, 'usage:50000/200000', 0);
          yield* liveState(id, (state) => state.contextUsage?._tag === 'reported');

          // Refuses Busy while a Turn (including pending PermissionRequest) is running.
          yield* sessions.prompt(id, text('permit'));
          yield* liveState(id, (state) => state.attention === 'needsAnswer');
          const busyDuringTurn = yield* sessions.compact(id).pipe(Effect.flip);
          expect(busyDuringTurn.reason).toBe('Busy');
          yield* sessions.cancel(id);
          const cancelledTurn = yield* untilTurnEnd(events(id, seq));
          seq = seqs(cancelledTurn).at(-1) ?? seq;

          // Standalone Session.compact streams Compaction and updates ContextUsage.
          yield* sessions.compact(id);
          const afterCompact = yield* liveState(
            id,
            (state) =>
              state.compacting !== true &&
              state.contextUsage?._tag === 'reported' &&
              state.contextUsage.used === 12_000,
          );
          expect(afterCompact.compacting).toBeUndefined();
          const compactItems = yield* events(id, seq).pipe(
            Stream.takeUntil(
              (event) =>
                event._tag === 'Transcript' &&
                event.event.item._tag === 'Compaction' &&
                event.event.item.status === 'done',
            ),
            Stream.runCollect,
          );
          const compactions = [...compactItems]
            .filter(
              (event): event is Extract<SessionStreamItem, { _tag: 'Transcript' }> =>
                event._tag === 'Transcript',
            )
            .map((event) => event.event.item)
            .filter(
              (item): item is Extract<TranscriptItem, { _tag: 'Compaction' }> =>
                item._tag === 'Compaction',
            );
          expect(compactions.at(0)?.status).toBe('running');
          expect(compactions.at(-1)).toMatchObject({
            _tag: 'Compaction',
            status: 'done',
            summary: 'Compacted summary',
          });
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'supports Session.cancel and failure fallback on standalone Session.compact, and refuses Unsupported',
    () =>
      Effect.gen(function* () {
        yield* withSessionsCustom({ agentArgs: ['--compact-hold'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* liveState(id, (state) => state.agentStatus === 'ready');
            const seq = yield* sendAndEnd(id, 'usage:40000/200000', 0);

            yield* sessions.compact(id);
            yield* liveState(id, (state) => state.compacting === true);
            yield* until(
              events(id, seq),
              (item) =>
                item._tag === 'Transcript' &&
                item.event.item._tag === 'Compaction' &&
                item.event.item.status === 'running',
            );

            const [promptBusy, clearBusy, compactBusy] = yield* Effect.all([
              sessions.prompt(id, text('hi')).pipe(Effect.flip),
              sessions.clearContext(id).pipe(Effect.flip),
              sessions.compact(id).pipe(Effect.flip),
            ]);
            expect([promptBusy.reason, clearBusy.reason, compactBusy.reason]).toEqual([
              'Busy',
              'Busy',
              'Busy',
            ]);

            yield* sessions.cancel(id);
            const settled = yield* liveState(id, (state) => state.compacting !== true);
            expect(settled.contextUsage).toEqual({
              _tag: 'historical',
              used: 40_000,
              capacity: 200_000,
            });
            const tail = yield* events(id, seq).pipe(
              Stream.takeUntil(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'cancelled',
              ),
              Stream.runCollect,
            );
            expect(
              [...tail].some(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'cancelled',
              ),
            ).toBe(true);
          }),
        );

        yield* withSessionsCustom({ agentArgs: ['--compact-fail'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            yield* liveState(id, (state) => state.agentStatus === 'ready');
            const seq = yield* sendAndEnd(id, 'usage:30000/200000', 0);

            yield* sessions.compact(id);
            const settled = yield* liveState(
              id,
              (state) => state.compacting !== true && state.contextUsage?._tag === 'historical',
            );
            expect(settled.contextUsage).toEqual({
              _tag: 'historical',
              used: 30_000,
              capacity: 200_000,
            });
            const tail = yield* events(id, seq).pipe(
              Stream.takeUntil(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'failed',
              ),
              Stream.runCollect,
            );
            expect(
              [...tail].some(
                (event) =>
                  event._tag === 'Transcript' &&
                  event.event.item._tag === 'Compaction' &&
                  event.event.item.status === 'failed',
              ),
            ).toBe(true);
          }),
        );

        yield* withSessionsCustom({ agentArgs: ['--no-compaction'] }, (project) =>
          Effect.gen(function* () {
            const sessions = yield* Sessions;
            const id = yield* sessions.create(project);
            const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
            expect(ready.capabilities?.supportsCompaction).toBe(false);
            const unsupported = yield* sessions.compact(id).pipe(Effect.flip);
            expect(unsupported.reason).toBe('Unsupported');
          }),
        );
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.effect(
    'surfaces cancelGrace for stalled Compaction and settles active Compaction on stopAgent',
    () =>
      withSessionsCustom({ agentArgs: ['--compact-hold', '--stall-cancel'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const a = yield* sessions.create(project);
          const b = yield* sessions.create(project);
          yield* sessions.setTabs(workspaceFor(project, [a, b], a));
          yield* liveState(a, (state) => state.agentStatus === 'ready');
          yield* liveState(b, (state) => state.agentStatus === 'ready');

          const seq = yield* sendAndEnd(a, 'usage:40000/200000', 0);
          yield* sessions.compact(a);
          yield* liveState(a, (state) => state.compacting === true);

          yield* sessions.cancel(a);
          const waiting = yield* liveState(a, (state) => state.cancelGrace?.phase === 'waiting');
          expect(waiting.cancelGrace).toEqual({ phase: 'waiting', otherWorkingCount: 0 });

          yield* TestClock.adjust('5 seconds');
          yield* Effect.yieldNow;
          const ready = yield* liveState(a, (state) => state.cancelGrace?.phase === 'ready');
          expect(ready.cancelGrace).toEqual({ phase: 'ready', otherWorkingCount: 0 });

          // Another Session compacting on the same Agent counts as otherWorking.
          yield* sessions.compact(b);
          yield* liveState(b, (state) => state.compacting === true);
          const confirm = yield* sessions.stopAgent(a);
          expect(confirm).toEqual({
            _tag: 'confirmRequired',
            otherWorkingCount: 1,
            agentName: 'Fake',
          });

          const stopped = yield* sessions.stopAgent(a, true);
          expect(stopped._tag).toBe('stopped');

          const settledA = yield* liveState(
            a,
            (state) => state.compacting !== true && state.cancelGrace === undefined,
          );
          expect(settledA.contextUsage).toEqual({
            _tag: 'historical',
            used: 40_000,
            capacity: 200_000,
          });
          const settledB = yield* liveState(b, (state) => state.compacting !== true);
          expect(settledB.compacting).toBeUndefined();

          const tail = yield* events(a, seq).pipe(
            Stream.takeUntil(
              (event) =>
                event._tag === 'Transcript' &&
                event.event.item._tag === 'Compaction' &&
                event.event.item.status === 'cancelled',
            ),
            Stream.runCollect,
          );
          expect(
            [...tail].some(
              (event) =>
                event._tag === 'Transcript' &&
                event.event.item._tag === 'Compaction' &&
                event.event.item.status === 'cancelled',
            ),
          ).toBe(true);
        }),
      ),
    TIMEOUT,
  );
});

describe('Queue and Steer', () => {
  it.live(
    'steers a running Turn in place, preserving its Thought and output, in arrival order',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(
            id,
            (state) => state.agentStatus === 'ready' && state.steeringSupported === true,
          );
          expect(ready.steeringSupported).toBe(true);

          yield* sessions.prompt(id, text('steer-hold'));
          const running = yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(id);

          yield* sessions.steer(id, text('first'));
          yield* sessions.steer(id, text('second'));

          yield* sessions.cancel(id);
          const items = transcript(yield* untilTurnEnd(events(id)));
          const turnId = running.runningTurn;
          expect(turnId).toBeDefined();
          expect(steeredTexts(items)).toEqual(['first', 'second']);
          for (const message of items) {
            if (message._tag === 'Message' && message.steer === true) {
              expect(message.turnId).toBe(turnId);
            }
          }
          expect(items.filter((item) => item._tag === 'TurnStarted')).toHaveLength(1);
          expect(
            items.flatMap((item) => (item._tag === 'Thought' ? [item.text] : [])).join(''),
          ).toContain('Planning the Turn.');
          expect(agentReply(items)).toContain('working');
          expect(agentReply(items)).toContain('steered:first');
          expect(agentReply(items)).toContain('steered:second');
          expect(items).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              turnId,
              outcome: { _tag: 'cancelled' },
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'steer supersedes a pending Permission request, answering it cancelled',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.setOption({ sessionId: id, option: 'permissionMode', value: 'ask' });
          yield* sessions.prompt(id, text('ask'));

          const pending = yield* until(events(id), isPendingPermission);
          const seq = seqs(pending).at(-1) ?? 0;
          yield* sessions.steer(id, text('redirect'));

          const tail = transcript(yield* until(events(id, seq), isSteerMessage('redirect')));
          expect(tail).toContainEqual(
            expect.objectContaining({
              _tag: 'PermissionRequest',
              state: { _tag: 'cancelled' },
            }),
          );
          expect(steeredTexts(tail)).toEqual(['redirect']);

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'refuses Steer when no Turn runs or when the Agent cannot steer',
    () =>
      withSessionsCustom({ agentArgs: ['--no-steering'] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          const idle = yield* sessions.steer(id, text('too early')).pipe(Effect.flip);
          expect(idle.reason).toBe('NotRunning');

          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(id);
          const unsupported = yield* sessions.steer(id, text('nope')).pipe(Effect.flip);
          expect(unsupported.reason).toBe('Unsupported');

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'steers a native-Steering Agent with a mid-Turn prompt',
    () =>
      withSessionsCustom({ catalog: [fakeEntry([], { nativeSteering: true })] }, (project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          const ready = yield* liveState(id, (state) => state.agentStatus === 'ready');
          expect(ready.steeringSupported).toBe(true);
          yield* sessions.prompt(id, text('hold'));
          const running = yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(id);

          yield* sessions.steer(id, text('echo:native'));
          const tail = transcript(yield* until(events(id), isSteerMessage('echo:native')));
          expect(steeredTexts(tail)).toEqual(['echo:native']);
          // Wait for the native prompt's reply to finish streaming before the Turn ends.
          yield* until(
            events(id),
            (item) =>
              item._tag === 'Transcript' &&
              item.event.item._tag === 'MessageDelta' &&
              item.event.item.text === 've',
          );

          yield* sessions.cancel(id);
          const end = transcript(yield* untilTurnEnd(events(id)));
          expect(agentReply(end)).toContain('native');
          expect(end).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              turnId: running.runningTurn,
              outcome: { _tag: 'cancelled' },
            }),
          );
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'queues FIFO, replaces the Queue whole, and drains one Message per settled Turn',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(id);

          yield* sessions.enqueue(id, text('echo:first'));
          yield* sessions.enqueue(id, text('echo:second'));
          const queued = yield* liveState(id, (state) => state.queue.length === 2);
          const [first, second] = queued.queue;
          if (first === undefined || second === undefined) {
            return yield* Effect.die('the Queue lost a Message');
          }

          // Reorder matters: the Queue sends the order the user sees.
          yield* sessions.setQueue(id, [second, first]);
          yield* liveState(id, (state) => state.queue[0]?.id === second.id);

          // Edit in place: the same Message, new text.
          const edited: QueuedMessage = {
            ...first,
            parts: [{ _tag: 'text', text: 'echo:edited' }],
          };
          yield* sessions.setQueue(id, [second, edited]);
          const replaced = yield* liveState(
            id,
            (state) => state.queue[1]?.parts[0]?._tag === 'text',
          );
          expect(
            replaced.queue[1]?.parts.map((part) => (part._tag === 'text' ? part.text : '')),
          ).toEqual(['echo:edited']);

          // Remove one, then clear all; what is enqueued again is what drains.
          yield* sessions.setQueue(id, [edited]);
          yield* liveState(id, (state) => state.queue.length === 1);
          yield* sessions.clearQueue(id);
          yield* liveState(id, (state) => state.queue.length === 0);
          yield* sessions.enqueue(id, text('echo:first'));
          yield* sessions.enqueue(id, [
            { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            { _tag: 'text', text: 'echo:second' },
          ]);

          // Cancel never clears the Queue: both Messages become their own Turns.
          yield* sessions.cancel(id);
          const firstEnd = transcript(yield* untilTurnEnd(events(id)));
          expect(firstEnd).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: { _tag: 'cancelled' },
            }),
          );
          let seq = seqs(yield* untilTurnEnd(events(id))).at(-1) ?? 0;
          const secondTurn = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(secondTurn)).toEqual(['echo:first']);
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const thirdTurn = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(thirdTurn)).toEqual(['echo:second']);
          const queuedUser = thirdTurn.find(
            (item) => item._tag === 'Message' && item.role === 'user',
          );
          expect(queuedUser).toMatchObject({
            parts: expect.arrayContaining([
              { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
            ]),
          });
          yield* liveState(id, (state) => state.queue.length === 0);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'halts the Queue on a failed Turn and keeps its Messages until a later Turn settles',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* sessions.enqueue(id, text('echo:queued'));

          yield* sessions.stopAgent(id, true);
          const failed = transcript(yield* untilTurnEnd(events(id)));
          expect(failed).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'failed', reason: 'interrupted' }),
            }),
          );
          const held = yield* liveState(id, (state) => state.queue.length === 1);
          expect(held.queue).toHaveLength(1);

          yield* sessions.prompt(id, text('echo:recovered'));
          let seq = seqs(yield* untilTurnEnd(events(id))).at(-1) ?? 0;
          const recovered = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(recovered)).toEqual(['echo:recovered']);
          seq = seqs(yield* untilTurnEnd(events(id, seq))).at(-1) ?? seq;
          const drained = transcript(yield* untilTurnEnd(events(id, seq)));
          expect(userTexts(drained)).toEqual(['echo:queued']);
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'sends the Queue immediately when idle, survives resubscription, and is lost with its Tab',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(project);
          yield* liveState(id, (state) => state.agentStatus === 'ready');

          yield* sessions.enqueue(id, text('echo:idle'));
          const idleItems = yield* untilTurnEnd(events(id));
          const idle = transcript(idleItems);
          const afterIdleSeq = seqs(idleItems).at(-1);
          expect(userTexts(idle)).toEqual(['echo:idle']);

          yield* sessions.prompt(id, text('hold'));
          yield* liveState(id, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(id, afterIdleSeq);
          yield* sessions.enqueue(id, text('echo:kept'));
          // A new subscription is a window reload: the Queue is still in main.
          const reloaded = yield* liveState(id, (state) => state.queue.length === 1);
          expect(reloaded.queue).toHaveLength(1);

          yield* sessions.setTabs(workspaceFor(project, [id], id));
          yield* sessions.setTabs(EMPTY_WORKSPACE);
          yield* liveState(id, (state) => state.queue.length === 0);

          yield* sessions.cancel(id);
          yield* untilTurnEnd(events(id, afterIdleSeq));
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'drains on refused and cutShort Turns',
    () =>
      withSessions((project) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const refused = yield* sessions.create(project);
          yield* liveState(refused, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(refused, text('hold'));
          yield* liveState(refused, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(refused);
          yield* sessions.enqueue(refused, text('refuse'));
          yield* sessions.enqueue(refused, text('echo:after-refuse'));
          yield* sessions.cancel(refused);

          let seq = seqs(yield* untilTurnEnd(events(refused))).at(-1) ?? 0;
          const refusedTurn = transcript(yield* untilTurnEnd(events(refused, seq)));
          expect(userTexts(refusedTurn)).toEqual(['refuse']);
          expect(refusedTurn).toContainEqual(
            expect.objectContaining({ _tag: 'TurnEnded', outcome: { _tag: 'refused' } }),
          );
          seq = seqs(yield* untilTurnEnd(events(refused, seq))).at(-1) ?? seq;
          const afterRefuse = transcript(yield* untilTurnEnd(events(refused, seq)));
          expect(userTexts(afterRefuse)).toEqual(['echo:after-refuse']);

          const cut = yield* sessions.create(project);
          yield* liveState(cut, (state) => state.agentStatus === 'ready');
          yield* sessions.prompt(cut, text('hold'));
          yield* liveState(cut, (state) => state.runningTurn !== undefined);
          yield* agentAnswering(cut);
          yield* sessions.enqueue(cut, text('max-tokens'));
          yield* sessions.enqueue(cut, text('echo:after-cut'));
          yield* sessions.cancel(cut);

          let cutSeq = seqs(yield* untilTurnEnd(events(cut))).at(-1) ?? 0;
          const cutTurn = transcript(yield* untilTurnEnd(events(cut, cutSeq)));
          expect(userTexts(cutTurn)).toEqual(['max-tokens']);
          expect(cutTurn).toContainEqual(
            expect.objectContaining({
              _tag: 'TurnEnded',
              outcome: expect.objectContaining({ _tag: 'cutShort' }),
            }),
          );
          cutSeq = seqs(yield* untilTurnEnd(events(cut, cutSeq))).at(-1) ?? cutSeq;
          const afterCut = transcript(yield* untilTurnEnd(events(cut, cutSeq)));
          expect(userTexts(afterCut)).toEqual(['echo:after-cut']);
        }),
      ),
    TIMEOUT,
  );
});
