import { HistoryStore, layerHistoryStore } from '../history/history-store';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option, PubSub, Stream } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
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
import { OperationId } from '../../src/shared/source-control/source-control.rpc';
import {
  ReservationCoordinator,
  layerReservationCoordinator,
  reservationKeys,
} from '../source-control/reservation-coordinator';
import { layerOperations } from '../source-control/operations';
import { layerReviewRegistry } from '../source-control/review-registry';
import { folderKey } from '../projects/folder-key';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { WorktreeCreate, layerWorktreeCreate } from '../worktrees/worktree-create';
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
}) =>
  Effect.gen(function* () {
    const install = yield* installFakeAgent;
    const store = layerStore(options.storeDir);
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
        Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(options.projectDir)) }),
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
    const entry = fakeEntry();
    const catalog = Layer.succeed(AgentCatalog, makeAgentCatalog([entry], entry.id));
    const deleteQueue = layerDeleteQueue.pipe(
      Layer.provide(store),
      Layer.provide(acpClient),
      Layer.provide(catalog),
    );
    const pathLayer = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
    const coordinatorLayer = layerReservationCoordinator;
    const reviewLayer = layerReviewRegistry;
    const opsLayer = layerOperations.pipe(
      Layer.provideMerge(coordinatorLayer),
      Layer.provideMerge(store),
    );
    const worktrees =
      options.customWorktreesLayer ??
      layerWorktrees.pipe(
        Layer.provide(layerGitWorkerDirect.pipe(Layer.provide(pathLayer))),
        Layer.provide(Layer.mergeAll(store, pathLayer)),
      );
    const wtCreate = layerWorktreeCreate.pipe(
      Layer.provideMerge(worktrees),
      Layer.provideMerge(layerGitWorkerDirect.pipe(Layer.provide(pathLayer))),
      Layer.provideMerge(pathLayer),
      Layer.provideMerge(reviewLayer),
      Layer.provideMerge(opsLayer),
      Layer.provideMerge(coordinatorLayer),
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
      Layer.provide(coordinatorLayer),
    );
    return Layer.mergeAll(
      sessions,
      projects.pipe(Layer.provide(worktrees)),
      acpClient,
      sessionStore,
      settings,
      remembered,
      catalog,
      worktrees,
      wtCreate,
      coordinatorLayer,
      opsLayer,
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
              const worktreeId = initialSnap.live.worktreeBinding?.worktreeId;
              if (worktreeId === undefined) return yield* Effect.die('missing worktree id');
              const history = yield* HistoryStore.use((store) =>
                store.list(sessionId, worktreeId),
              ).pipe(Effect.provide(layerHistoryStore.pipe(Layer.provide(layerStore(storeDir)))));
              expect(history).toHaveLength(1);
              expect(history[0]).toMatchObject({
                sessionId,
                worktreeId,
                before: { status: 'Missing' },
                after: { status: 'Missing' },
              });

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
    'creates a Worktree from a Session retaining dirty files, without switching Sessions, and preserves it after closing draft Sessions (#100)',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-s-wt-create-'))),
        (root) =>
          Effect.gen(function* () {
            const storeDir = path.join(root, 'store');
            const repoDir = path.join(root, 'repo');
            const newWorktreeDir = path.join(root, 'repo-feat-isolated');
            yield* Effect.promise(() => mkdir(repoDir, { recursive: true }));
            yield* Effect.promise(() => git(repoDir, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(repoDir, 'tracked.txt'), 'clean-v1\n'));
            yield* Effect.promise(() => git(repoDir, 'add', 'tracked.txt'));
            yield* Effect.promise(() => git(repoDir, 'commit', '-m', 'init'));

            // Uncommitted modifications and untracked file in source Worktree
            yield* Effect.promise(() => writeFile(path.join(repoDir, 'tracked.txt'), 'dirty-v2\n'));
            yield* Effect.promise(() =>
              writeFile(path.join(repoDir, 'scratch.txt'), 'untracked\n'),
            );

            const harness = yield* makeProjectHarness({
              projectDir: repoDir,
              storeDir,
            });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const wtCreate = yield* WorktreeCreate;
              const worktrees = yield* Worktrees;

              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');

              const activeSession = yield* sessions.create(project.id);
              const draftSession = yield* sessions.create(project.id);
              yield* sessions.setTabs([activeSession, draftSession], activeSession);
              yield* promptAndWait(activeSession, 'echo:stay on main');

              const beforeActive = yield* snapshotEvents(activeSession);
              const beforeDraft = yield* snapshotEvents(draftSession);

              const review = yield* wtCreate.prepareCreate({
                path: repoDir,
                projectId: project.id,
              });
              expect(review.sourceDirtyCount).toBe(2);

              const result = yield* wtCreate.executeCreate({
                reviewId: review.reviewId,
                operationId: OperationId.make('op-session-create-1'),
                sourcePath: review.sourcePath,
                destinationPath: newWorktreeDir,
                branch: 'feat/isolated',
                startFrom: { mode: 'Head' },
                projectId: project.id,
              });
              expect(result.operation.phase).toBe('Completed');
              expect(result.operation.outcome).toBe('Succeeded');
              expect(result.worktree?.head._tag).toBe('Branch');

              // Dirty source files remain intact in the original Worktree; created Worktree starts clean
              expect(
                yield* Effect.promise(() => readFile(path.join(repoDir, 'tracked.txt'), 'utf8')),
              ).toBe('dirty-v2\n');
              expect(
                yield* Effect.promise(() => readFile(path.join(repoDir, 'scratch.txt'), 'utf8')),
              ).toBe('untracked\n');
              const newTracked = yield* Effect.promise(() =>
                readFile(path.join(newWorktreeDir, 'tracked.txt'), 'utf8'),
              );
              expect(newTracked.replaceAll('\r\n', '\n')).toBe('clean-v1\n');

              // Existing Sessions NEVER switch implicitly to the new Worktree
              const afterActive = yield* snapshotEvents(activeSession);
              const afterDraft = yield* snapshotEvents(draftSession);
              expect(afterActive.live.worktreeBinding?.worktreeId).toBe(
                beforeActive.live.worktreeBinding?.worktreeId,
              );
              expect(afterActive.live.worktreeBinding?.worktreeId).not.toBe(result.worktree?.id);
              expect(afterDraft.live.worktreeBinding?.worktreeId).toBe(
                beforeDraft.live.worktreeBinding?.worktreeId,
              );
              expect(afterActive.live.worktreeInventory?.worktrees.map((w) => w.id)).toContain(
                result.worktree?.id,
              );

              // Closing and removing the draft Session keeps the created Worktree intact on disk and in inventory
              yield* sessions.setTabs([activeSession], activeSession);
              yield* sessions.remove(draftSession);
              const destStat = yield* Effect.promise(() => stat(newWorktreeDir));
              expect(destStat.isDirectory()).toBe(true);
              const invAfterDraftRemoved = yield* worktrees.inventory(repoDir, project.id);
              expect(invAfterDraftRemoved.worktrees.map((w) => w.id)).toContain(
                result.worktree?.id,
              );
            }).pipe(Effect.provide(harness));
          }).pipe(Effect.scoped),
        (root) =>
          Effect.promise(() =>
            rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          ),
      ),
    TIMEOUT,
  );

  it.live(
    'blocks starting a Turn when an unresolved recovery lock targets the Session worktree and unblocks after release (#100)',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-s-wt-rec-'))),
        (root) =>
          Effect.gen(function* () {
            const storeDir = path.join(root, 'store');
            const repoDir = path.join(root, 'repo');
            yield* Effect.promise(() => mkdir(repoDir, { recursive: true }));
            yield* Effect.promise(() => git(repoDir, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(repoDir, 'a.txt'), 'a\n'));
            yield* Effect.promise(() => git(repoDir, 'add', 'a.txt'));
            yield* Effect.promise(() => git(repoDir, 'commit', '-m', 'init'));
            const repoReal = yield* Effect.promise(() => realpath(repoDir));

            const harness = yield* makeProjectHarness({
              projectDir: repoDir,
              storeDir,
            });
            yield* Effect.gen(function* () {
              const projects = yield* Projects;
              const sessions = yield* Sessions;
              const coordinator = yield* ReservationCoordinator;

              const project = yield* projects.add;
              if (project === null) return yield* Effect.die('no project');
              const sessionId = yield* sessions.create(project.id);

              const opId = OperationId.make('op-unresolved-turn');
              const lockKey = reservationKeys.folder(folderKey(repoReal, process.platform));
              yield* coordinator.setUnresolvedTargets(
                opId,
                [lockKey],
                'Pending worktree recovery blocks new Turn',
              );

              const err = yield* sessions
                .prompt(sessionId, [{ _tag: 'text', text: 'blocked' }])
                .pipe(Effect.flip);
              expect(err._tag).toBe('SessionError');
              if (err._tag === 'SessionError') {
                expect(err.reason).toBe('Busy');
                expect(err.detail).toContain('Pending worktree recovery');
              }

              yield* coordinator.clearUnresolvedTargets(opId);
              yield* promptAndWait(sessionId, 'echo:unblocked after recovery');
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
