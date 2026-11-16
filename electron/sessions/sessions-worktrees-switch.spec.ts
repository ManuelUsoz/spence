import { layerHistoryStore } from '../history/history-store';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Stream } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  type LiveState,
  MessageId,
  SessionId,
  type SessionStreamItem,
  type TranscriptItem,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import { type WorktreeInventory } from '../../src/shared/worktrees/worktrees.rpc';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { layerAgentLifetime } from '../acp/acpLifetime';
import { layerAgents } from '../agents/agents';
import { layerMergedPath, layerPathSources, MergedPath } from '../agents/merged-path';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { layerReservationCoordinator } from '../source-control/reservation-coordinator';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { layerWorktrees, reconcileWorktreeBinding, Worktrees } from '../worktrees/worktrees';
import { layerDeleteQueue } from './delete-queue';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { AgentContextId, layerSessionStore, SessionStore } from './session-store';
import { layerSessions, Sessions } from './sessions';

const TIMEOUT = 30_000;
const execFile = promisify(execFileCb);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFile('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Spence Test',
      GIT_AUTHOR_EMAIL: 'spence@example.com',
      GIT_COMMITTER_NAME: 'Spence Test',
      GIT_COMMITTER_EMAIL: 'spence@example.com',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
    shell: false,
    windowsHide: true,
  });

const makeProjectHarness = (options: {
  readonly projectDir: string;
  readonly storeDir: string;
  readonly customWorktreesLayer?: Layer.Layer<Worktrees>;
  readonly pickerQueue?: Array<string>;
  readonly agentArgs?: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const install = yield* installFakeAgent;
    const store = layerStore(options.storeDir);
    const sessionStore = layerSessionStore.pipe(Layer.provide(store));
    const pathLayer = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
    const worktrees =
      options.customWorktreesLayer ??
      layerWorktrees.pipe(
        Layer.provide(layerGitWorkerDirect.pipe(Layer.provide(pathLayer))),
        Layer.provide(Layer.mergeAll(store, pathLayer)),
      );
    const pickAnswers = options.pickerQueue ?? [options.projectDir];
    const projects = layerProjects.pipe(
      Layer.provide(sessionStore),
      Layer.provide(store),
      Layer.provide(worktrees),
      Layer.provide(
        Layer.succeed(Folders, {
          platform: process.platform,
          realPath: (folder) => Effect.succeed(Option.some(folder)),
          exists: () => Effect.succeed(true),
        }),
      ),
      Layer.provide(
        Layer.succeed(FolderPicker, {
          pick: Effect.sync(() => Option.fromUndefinedOr(pickAnswers.shift())),
        }),
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
    const agents = layerAgents.pipe(
      Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
      Layer.provide(layerPathSources),
    );
    const lifetime = layerAgentLifetime.pipe(Layer.provide(acpClient), Layer.provide(agents));
    const entry = fakeEntry(options.agentArgs);
    const catalog = Layer.succeed(AgentCatalog, makeAgentCatalog([entry], entry.id));
    const deleteQueue = layerDeleteQueue.pipe(
      Layer.provide(store),
      Layer.provide(acpClient),
      Layer.provide(catalog),
    );
    const sessions = layerSessions.pipe(
      Layer.provide(layerHistoryStore.pipe(Layer.provide(store))),
      Layer.provide(sessionStore),
      Layer.provide(deleteQueue),
      Layer.provide(lifetime),
      Layer.provide(acpClient),
      Layer.provide(catalog),
      Layer.provide(agents),
      Layer.provide(projects),
      Layer.provide(settings),
      Layer.provide(remembered),
      Layer.provide(worktrees),
      Layer.provide(layerReservationCoordinator),
    );

    return Layer.mergeAll(
      sessions,
      projects,
      acpClient,
      sessionStore,
      settings,
      remembered,
      catalog,
      worktrees,
    );
  });

const snapshotEvents = (
  id: SessionId,
  until: (item: SessionStreamItem) => boolean = (item) => item._tag === 'Live',
) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const items = yield* sessions.events(id).pipe(Stream.takeUntil(until), Stream.runCollect);
    const list = [...items];
    let live: LiveState | undefined;
    const transcript: TranscriptItem[] = [];
    for (const item of list) {
      if (item._tag === 'Live') live = item.state;
      if (item._tag === 'Transcript') transcript.push(item.event.item);
    }
    if (live === undefined) return yield* Effect.die('no LiveState in snapshot');
    return { live, transcript };
  });

const promptAndWait = (id: SessionId, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const prompted = yield* Deferred.make<TurnId>();
    const stream = yield* sessions.events(id).pipe(
      Stream.takeUntilEffect((item: SessionStreamItem) =>
        item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded'
          ? Effect.map(Deferred.await(prompted), (turnId) =>
              item.event.item._tag === 'TurnEnded' ? item.event.item.turnId === turnId : false,
            )
          : Effect.succeed(false),
      ),
      Stream.runCollect,
      Effect.forkChild,
    );
    const turnId = yield* sessions.prompt(id, [{ _tag: 'text', text }]);
    yield* Deferred.succeed(prompted, turnId);
    return [...(yield* Fiber.join(stream))];
  });

const waitLiveMatching = (id: SessionId, predicate: (state: LiveState) => boolean) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const last = yield* sessions.events(id).pipe(
      Stream.filter(
        (item): item is Extract<SessionStreamItem, { _tag: 'Live' }> => item._tag === 'Live',
      ),
      Stream.takeUntil((item) => predicate(item.state)),
      Stream.runLast,
    );
    if (last._tag !== 'Some') return yield* Effect.die('stream ended without matching LiveState');
    return last.value.state;
  });

describe('Sessions & SessionStore Worktree lifecycle (#98)', () => {
  it.effect(
    'migrates v2 SessionMeta to v3 preserving cwd, Transcript, and ACP contexts, and refuses v4 untouched',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-s-wt-mig-'))),
        (root) =>
          Effect.gen(function* () {
            const storeDir = path.join(root, 'store');
            const projectDir = path.join(root, 'repo');
            yield* Effect.promise(() => mkdir(projectDir, { recursive: true }));

            const v2SessionDir = path.join(storeDir, 'sessions', 's-v2');
            yield* Effect.promise(() => mkdir(v2SessionDir, { recursive: true }));
            const v2Meta = {
              version: 2,
              id: SessionId.make('s-v2'),
              projectId: ProjectId.make('p-1'),
              cwd: projectDir,
              agentId: AgentId.make('claude'),
              userTitle: 'Legacy Session',
              autoTitleIsPlaceholder: false,
              createdAt: 1000,
              lastActivityAt: 2000,
              activeContextId: AgentContextId.make('ctx-1'),
              contexts: [
                {
                  id: AgentContextId.make('ctx-1'),
                  agentId: AgentId.make('claude'),
                  acpSessionIds: ['acp-legacy-99'],
                  createdAt: 1000,
                },
              ],
              permissionMode: 'ask',
            };
            yield* Effect.promise(() =>
              writeFile(path.join(v2SessionDir, 'session.json'), JSON.stringify(v2Meta, null, 2)),
            );
            const transcriptLine = `${JSON.stringify({
              seq: 1,
              at: 1000,
              item: {
                _tag: 'Message',
                id: MessageId.make('m1'),
                turnId: TurnId.make('t1'),
                role: 'user',
                parts: [{ _tag: 'text', text: 'preserved question' }],
              },
            })}\n`;
            yield* Effect.promise(() =>
              writeFile(path.join(v2SessionDir, 'transcript.jsonl'), transcriptLine),
            );

            const v4SessionDir = path.join(storeDir, 'sessions', 's-v4');
            yield* Effect.promise(() => mkdir(v4SessionDir, { recursive: true }));
            const v4Raw = JSON.stringify({
              version: 4,
              futureField: 'do-not-overwrite',
            });
            yield* Effect.promise(() => writeFile(path.join(v4SessionDir, 'session.json'), v4Raw));

            const storeLayer = layerSessionStore.pipe(Layer.provide(layerStore(storeDir)));
            yield* Effect.gen(function* () {
              const store = yield* SessionStore;
              const migrated = yield* store.getChecked(SessionId.make('s-v2'));
              expect(migrated.cwd).toBe(projectDir);
              expect(migrated.contexts[0]?.acpSessionIds).toEqual(['acp-legacy-99']);
              expect(migrated.worktreeBinding?.state).toBe('undiscovered');
              expect(migrated.worktreeBinding?.expectedPath).toBe(projectDir);

              const persistedDisk = JSON.parse(
                yield* Effect.promise(() =>
                  readFile(path.join(v2SessionDir, 'session.json'), 'utf8'),
                ),
              ) as {
                readonly version: number;
                readonly worktreeBinding?: { readonly state: string };
              };
              expect(persistedDisk.version).toBe(3);
              expect(persistedDisk.worktreeBinding?.state).toBe('undiscovered');
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(v2SessionDir, 'transcript.jsonl'), 'utf8'),
                ),
              ).toBe(transcriptLine);

              // v4 newer format must fail without overwriting!
              const newerErr = yield* store.getChecked(SessionId.make('s-v4')).pipe(Effect.flip);
              expect(newerErr._tag).toBe('StoreError');
              if (newerErr._tag === 'StoreError') {
                expect(newerErr.reason).toBe('NewerVersion');
              }
              expect(
                yield* Effect.promise(() =>
                  readFile(path.join(v4SessionDir, 'session.json'), 'utf8'),
                ),
              ).toBe(v4Raw);
            }).pipe(Effect.provide(storeLayer));
          }).pipe(Effect.scoped),
        (root) =>
          Effect.promise(() =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      ),
  );

  it.live(
    'binds new Sessions to existing checkout, blocks Send when binding is missing without hiding Transcript, and refreshes after Step & Turn end',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-s-wt-live-'))),
        (root) =>
          Effect.gen(function* () {
            const storeDir = path.join(root, 'store');
            const projectDir = path.join(root, 'repo');
            const linkedDir = path.join(root, 'repo-linked');
            yield* Effect.promise(() => mkdir(projectDir, { recursive: true }));
            yield* Effect.promise(() => git(projectDir, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(projectDir, 'a.txt'), 'a\n'));
            yield* Effect.promise(() => git(projectDir, 'add', 'a.txt'));
            yield* Effect.promise(() => git(projectDir, 'commit', '-m', 'init'));
            yield* Effect.promise(() =>
              git(projectDir, 'worktree', 'add', '-b', 'feat/x', linkedDir),
            );

            // Part 1: test with real Worktrees over linkedDir
            const realHarness = yield* makeProjectHarness({
              projectDir: linkedDir,
              storeDir,
            });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const worktrees = yield* Worktrees;
              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');

              const sessionId = yield* sessions.create(project.id);
              const initialSnap = yield* snapshotEvents(sessionId);
              expect(initialSnap.live.worktreeBinding?.state).toBe('resolved');
              expect(initialSnap.live.worktreeBinding?.worktreeId).toBeDefined();
              expect(initialSnap.live.worktreeInventory?.currentWorktreeId).toBe(
                initialSnap.live.worktreeBinding?.worktreeId,
              );

              // Send a real message and get a reply in Transcript
              yield* promptAndWait(sessionId, 'echo:worktree bound');

              // Now replace linkedDir with an unrelated plain folder!
              yield* Effect.promise(() => rm(linkedDir, { recursive: true, force: true }));
              yield* Effect.promise(() => mkdir(linkedDir, { recursive: true }));

              // Refresh triggers missing binding state cleanly
              yield* worktrees.refresh(linkedDir, project.id);
              const updatedLive = yield* waitLiveMatching(
                sessionId,
                (state) => state.worktreeBinding?.state === 'missing',
              );
              expect(updatedLive.worktreeBinding?.reason).toBe('ReplacedFolder');

              const afterMissing = yield* snapshotEvents(
                sessionId,
                (item) => item._tag === 'Transcript' && item.event.item._tag === 'TurnEnded',
              );
              expect(afterMissing.live.worktreeBinding?.state).toBe('missing');
              // Transcript remains intact and readable!
              const replyText = afterMissing.transcript
                .map((item) => {
                  if (item._tag === 'MessageDelta') return item.text;
                  if (item._tag === 'Message' && item.role === 'agent') {
                    return item.parts.map((p) => (p._tag === 'text' ? p.text : '')).join('');
                  }
                  return '';
                })
                .join('');
              expect(replyText).toContain('worktree bound');

              // Sending while Worktree binding is missing is refused!
              const sendErr = yield* sessions
                .prompt(sessionId, [{ _tag: 'text', text: 'blocked' }])
                .pipe(Effect.flip);
              expect(sendErr._tag).toBe('SessionError');
            }).pipe(Effect.provide(realHarness));

            // Part 2: test post-Step & Turn-end Worktree refresh invocation counts
            const storeDir2 = path.join(root, 'store2');
            const projectDir2 = path.join(root, 'plain');
            yield* Effect.promise(() => mkdir(projectDir2, { recursive: true }));
            let refreshCalls = 0;
            const customUpdates = yield* PubSub.unbounded<WorktreeInventory>();
            const spyWorktrees = Layer.succeed(Worktrees, {
              platform: process.platform,
              inventory: (targetPath, pid) =>
                Effect.succeed({
                  ...(pid === undefined ? {} : { projectId: pid }),
                  cwd: targetPath,
                  capability: {
                    _tag: 'NonGit',
                    path: targetPath,
                    detail: 'Not a git repository',
                  },
                  worktrees: [],
                  refreshedAt: Date.now(),
                }),
              refresh: (targetPath, pid) =>
                Effect.gen(function* () {
                  refreshCalls += 1;
                  const inv: WorktreeInventory = {
                    ...(pid === undefined ? {} : { projectId: pid }),
                    cwd: targetPath,
                    capability: {
                      _tag: 'NonGit',
                      path: targetPath,
                      detail: 'Not a git repository',
                    },
                    worktrees: [],
                    refreshedAt: Date.now(),
                  };
                  yield* PubSub.publish(customUpdates, inv);
                  return inv;
                }),
              locate: ({ targetPath }) =>
                Effect.succeed({
                  _tag: 'RequiresRebind',
                  mismatchReason: 'NonGit',
                  candidatePath: targetPath,
                  detail: 'Not a git repository',
                }),
              reconcileBinding: reconcileWorktreeBinding,
              updates: Stream.fromPubSub(customUpdates),
            });
            const spyHarness = yield* makeProjectHarness({
              projectDir: projectDir2,
              storeDir: storeDir2,
              customWorktreesLayer: spyWorktrees,
            });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');
              const sessionId = yield* sessions.create(project.id);
              refreshCalls = 0;

              // "work" script runs completed Steps (read + edit) and TurnEnded
              yield* promptAndWait(sessionId, 'work');
              // At least 1 completed Step refresh + 1 Turn-end refresh
              expect(refreshCalls).toBeGreaterThanOrEqual(2);
            }).pipe(Effect.provide(spyHarness));
          }).pipe(Effect.scoped),
        (root) =>
          Effect.promise(() =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      ),
    TIMEOUT,
  );

  it.live(
    'switches only the selected idle Session via Summary handoff, runs concurrent Turns on shared Worktrees, keeps Fork defaults, and leaves source intact on handoff failure',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-wt-switch-'))),
        (rawRoot) =>
          Effect.gen(function* () {
            const root = yield* Effect.promise(() => realpath(rawRoot));
            const mainRepo = path.join(root, 'repo');
            const wtFeature = path.join(root, 'wt-feature');
            const storeDir = path.join(root, 'store');
            const failStoreDir = path.join(root, 'store-fail');

            yield* Effect.promise(() => mkdir(mainRepo, { recursive: true }));
            yield* Effect.promise(() => git(mainRepo, 'init', '-b', 'main'));
            yield* Effect.promise(() =>
              writeFile(path.join(mainRepo, 'index.ts'), 'export const x = 1;\n'),
            );
            yield* Effect.promise(() => git(mainRepo, 'add', 'index.ts'));
            yield* Effect.promise(() => git(mainRepo, 'commit', '-m', 'init'));
            yield* Effect.promise(() =>
              git(mainRepo, 'worktree', 'add', '-b', 'feat/branch', wtFeature),
            );

            const harness = yield* makeProjectHarness({ projectDir: mainRepo, storeDir });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const store = yield* SessionStore;
              const worktrees = yield* Worktrees;

              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');

              const s1 = yield* sessions.create(project.id);
              const s2 = yield* sessions.create(project.id);

              const inv = yield* worktrees.refresh(mainRepo, project.id);
              const mainWt = inv.worktrees.find((w) => w.isPrimary);
              const featWt = inv.worktrees.find((w) => w.path === wtFeature);
              if (!mainWt || !featWt) return yield* Effect.die('missing worktrees');

              // Both Sessions share mainWt; verify worktreeSessionCounts shows 2 on mainWt.
              const s1SnapBefore = yield* snapshotEvents(s1);
              expect(s1SnapBefore.live.worktreeSessionCounts?.[mainWt.id]).toBe(2);

              // Run concurrent Turns in BOTH Sessions sharing mainWt: start s2 holding, finish s1 while s2 runs.
              yield* promptAndWait(s1, 'echo:initial context');
              const s2HoldFiber = yield* promptAndWait(s2, 'hold').pipe(Effect.forkChild);
              yield* waitLiveMatching(s2, (state) => state.runningTurn !== undefined);
              yield* promptAndWait(s1, 'echo:concurrent reply');

              // Switching the BUSY session s2 must fail Busy.
              const busyErr = yield* sessions
                .prepareHandoff({
                  sessionId: s2,
                  kind: 'worktreeSwitch',
                  targetWorktreeId: featWt.id,
                })
                .pipe(Effect.flip);
              expect(busyErr.reason).toBe('Busy');

              // Switching the IDLE session s1 succeeds EVEN WHILE s2 is still running in mainWt!
              const prep = yield* sessions.prepareHandoff({
                sessionId: s1,
                kind: 'worktreeSwitch',
                targetWorktreeId: featWt.id,
              });
              expect(prep.kind).toBe('worktreeSwitch');
              expect(prep.targetWorktree?.id).toBe(featWt.id);

              const reval = yield* sessions.revalidateHandoff({
                sessionId: s1,
                endpoint: prep.endpoint,
                targetAgentId: prep.defaultDestinationAgentId,
                targetWorktreeId: featWt.id,
                summary: prep.summary,
                selectedImageIds: [],
              });
              expect(reval.endpointAdvanced).toBe(false);
              expect(reval.worktreeUnavailable).toBeUndefined();

              const metaBeforeSwitch = yield* store.meta(s1);
              const switchResult = yield* sessions.executeHandoff({
                sessionId: s1,
                kind: 'worktreeSwitch',
                endpoint: prep.endpoint,
                targetAgentId: prep.defaultDestinationAgentId,
                targetWorktreeId: featWt.id,
                summary: prep.summary,
                selectedImageIds: [],
              });
              expect(switchResult._tag).toBe('committed');

              // Cancel s2's concurrent hold Turn cleanly and await its completion.
              yield* sessions.cancel(s2);
              yield* Fiber.await(s2HoldFiber);

              // Verify ONLY s1 switched to featWt with fresh Agent context & preserved Transcript.
              const metaAfterSwitch = yield* store.meta(s1);
              const s2MetaAfter = yield* store.meta(s2);
              expect(metaAfterSwitch.cwd).toBe(wtFeature);
              expect(metaAfterSwitch.worktreeBinding).toMatchObject({
                state: 'resolved',
                worktreeId: featWt.id,
                expectedPath: wtFeature,
                lastKnownBranch: 'feat/branch',
              });
              expect(metaAfterSwitch.activeContextId).not.toBe(metaBeforeSwitch.activeContextId);
              expect(s2MetaAfter.cwd).toBe(mainWt.path);
              expect(s2MetaAfter.worktreeBinding?.worktreeId).toBe(mainWt.id);

              const s1LiveAfter = yield* waitLiveMatching(
                s1,
                (state) => state.worktreeBinding?.worktreeId === featWt.id,
              );
              expect(s1LiveAfter.worktreeSessionCounts?.[mainWt.id]).toBe(1);
              expect(s1LiveAfter.worktreeSessionCounts?.[featWt.id]).toBe(1);

              // Verify HandoffBoundary metadata and prompt working on switched Worktree.
              const eventsSnap = yield* snapshotEvents(
                s1,
                (item) => item._tag === 'Transcript' && item.event.item._tag === 'HandoffBoundary',
              );
              const boundary = eventsSnap.transcript.find((i) => i._tag === 'HandoffBoundary');
              expect(boundary).toMatchObject({
                _tag: 'HandoffBoundary',
                kind: 'worktreeSwitch',
                fromWorktreePath: mainWt.path,
                toWorktreePath: wtFeature,
                fromWorktreeBranch: 'main',
                toWorktreeBranch: 'feat/branch',
              });
              yield* promptAndWait(s1, 'echo:in feature');

              // Leave uncommitted dirty file in wtFeature and Fork s1 -> defaults to wtFeature without restoring files!
              const dirtyMarker = path.join(wtFeature, 'dirty-note.txt');
              yield* Effect.promise(() => writeFile(dirtyMarker, 'keep untracked\n'));
              const forkPrep = yield* sessions.prepareHandoff({ sessionId: s1, kind: 'fork' });
              const forkRes = yield* sessions.executeHandoff({
                sessionId: s1,
                kind: 'fork',
                endpoint: forkPrep.endpoint,
                targetAgentId: forkPrep.defaultDestinationAgentId,
                summary: forkPrep.summary,
                selectedImageIds: [],
              });
              expect(forkRes._tag).toBe('committed');
              if (forkRes._tag === 'committed' && forkRes.forkSessionId !== undefined) {
                const forkMeta = yield* store.meta(forkRes.forkSessionId);
                expect(forkMeta.cwd).toBe(wtFeature);
                expect(forkMeta.worktreeBinding?.worktreeId).toBe(featWt.id);
              }
              expect(yield* Effect.promise(() => readFile(dirtyMarker, 'utf8'))).toBe(
                'keep untracked\n',
              );
            }).pipe(Effect.provide(harness));

            // Now test failed Worktree switch handoff leaves source binding, cwd, context, and Transcript untouched!
            const failHarness = yield* makeProjectHarness({
              projectDir: mainRepo,
              storeDir: failStoreDir,
              agentArgs: ['--handoff-unexpected-tool'],
            });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const store = yield* SessionStore;
              const worktrees = yield* Worktrees;

              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');
              const sFail = yield* sessions.create(project.id);
              yield* promptAndWait(sFail, 'echo:stable state');

              const inv = yield* worktrees.refresh(mainRepo, project.id);
              const mainWt = inv.worktrees.find((w) => w.isPrimary);
              const featWt = inv.worktrees.find((w) => w.path === wtFeature);
              if (!mainWt || !featWt) return yield* Effect.die('missing worktrees');

              const beforeMeta = yield* store.meta(sFail);
              const prep = yield* sessions.prepareHandoff({
                sessionId: sFail,
                kind: 'worktreeSwitch',
                targetWorktreeId: featWt.id,
              });
              const failedRes = yield* sessions.executeHandoff({
                sessionId: sFail,
                kind: 'worktreeSwitch',
                endpoint: prep.endpoint,
                targetAgentId: prep.defaultDestinationAgentId,
                targetWorktreeId: featWt.id,
                summary: prep.summary,
                selectedImageIds: [],
              });
              expect(failedRes._tag).toBe('failed');
              if (failedRes._tag === 'failed') {
                expect(failedRes.attempt.targetWorktreeId).toBe(featWt.id);
              }
              const afterMeta = yield* store.meta(sFail);
              expect(afterMeta.cwd).toBe(beforeMeta.cwd);
              expect(afterMeta.worktreeBinding).toEqual(beforeMeta.worktreeBinding);
              expect(afterMeta.activeContextId).toBe(beforeMeta.activeContextId);
            }).pipe(Effect.provide(failHarness));
          }).pipe(Effect.scoped),
        (root) =>
          Effect.promise(() =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      ),
    TIMEOUT,
  );

  it.live(
    'validates identity on Session.locateWorktree, requires explicit rebind on mismatch, and preserves readable Transcripts',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sessions-wt-locate-'))),
        (rawRoot) =>
          Effect.gen(function* () {
            const root = yield* Effect.promise(() => realpath(rawRoot));
            const mainRepo = path.join(root, 'repo');
            const wtFeature = path.join(root, 'wt-feature');
            const wtMoved = path.join(root, 'wt-moved');
            const otherRepo = path.join(root, 'other-repo');
            const storeDir = path.join(root, 'store');

            yield* Effect.promise(() => mkdir(mainRepo, { recursive: true }));
            yield* Effect.promise(() => git(mainRepo, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(mainRepo, 'README.md'), 'hi\n'));
            yield* Effect.promise(() => git(mainRepo, 'add', 'README.md'));
            yield* Effect.promise(() => git(mainRepo, 'commit', '-m', 'init'));
            yield* Effect.promise(() =>
              git(mainRepo, 'worktree', 'add', '-b', 'feat/move', wtFeature),
            );

            yield* Effect.promise(() => mkdir(otherRepo, { recursive: true }));
            yield* Effect.promise(() => git(otherRepo, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(otherRepo, 'other.md'), 'o\n'));
            yield* Effect.promise(() => git(otherRepo, 'add', 'other.md'));
            yield* Effect.promise(() => git(otherRepo, 'commit', '-m', 'other'));

            const harness = yield* makeProjectHarness({ projectDir: wtFeature, storeDir });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const store = yield* SessionStore;
              const worktrees = yield* Worktrees;

              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');
              const sessionId = yield* sessions.create(project.id);
              const initSnap = yield* snapshotEvents(sessionId);
              const originalWtId = initSnap.live.worktreeBinding?.worktreeId;
              expect(originalWtId).toBeTruthy();

              yield* promptAndWait(sessionId, 'echo:keep transcript');
              // On Windows, stop the idle fake-agent child process holding an open cwd handle in wtFeature
              // and wait briefly for post-turn git refresh to exit before moving the checkout directory.
              yield* sessions.stopAgent(sessionId, true);
              yield* Effect.promise(async () => {
                for (let attempt = 0; attempt < 8; attempt++) {
                  try {
                    await git(mainRepo, 'worktree', 'move', wtFeature, wtMoved);
                    return;
                  } catch (err) {
                    const msg = String(err);
                    if (attempt === 7 || !msg.includes('Permission denied')) throw err;
                    await new Promise((r) => setTimeout(r, 100));
                  }
                }
              });
              yield* worktrees.refresh(wtFeature, project.id);
              const missingLive = yield* waitLiveMatching(
                sessionId,
                (state) => state.worktreeBinding?.state === 'missing',
              );
              expect(missingLive.worktreeBinding?.state).toBe('missing');

              // Wrong repo must require explicit rebinding without altering Session binding.
              const mismatch = yield* sessions.locateWorktree({
                sessionId,
                targetPath: otherRepo,
              });
              expect(mismatch._tag).toBe('RequiresRebind');
              expect((yield* store.meta(sessionId)).worktreeBinding?.state).toBe('missing');

              // Validated moved checkout updates binding & cwd, preserves WorktreeId, and unblocks Send.
              const verified = yield* sessions.locateWorktree({
                sessionId,
                targetPath: wtMoved,
              });
              expect(verified._tag).toBe('Located');
              const resolvedLive = yield* waitLiveMatching(
                sessionId,
                (state) => state.worktreeBinding?.state === 'resolved',
              );
              expect(resolvedLive.worktreeBinding?.worktreeId).toBe(originalWtId);
              expect(resolvedLive.worktreeBinding?.expectedPath).toBe(wtMoved);
              yield* promptAndWait(sessionId, 'echo:after locate');

              // Explicit rebind to another repository switches Session's binding deliberately.
              const rebound = yield* sessions.locateWorktree({
                sessionId,
                targetPath: otherRepo,
                confirmRebind: true,
              });
              expect(rebound._tag).toBe('Rebound');
              const afterRebind = yield* store.meta(sessionId);
              expect(afterRebind.cwd).toBe(otherRepo);
              expect(afterRebind.worktreeBinding?.worktreeId).not.toBe(originalWtId);
            }).pipe(Effect.provide(harness));
          }).pipe(Effect.scoped),
        (root) =>
          Effect.promise(() =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      ),
    TIMEOUT,
  );
});
