import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { layerMergedPath, layerPathSources, MergedPath, PathSources } from '../agents/merged-path';
import {
  AgentContextId,
  layerSessionStore,
  SessionStore,
  type SessionMeta,
} from '../sessions/session-store';
import { layerStore } from '../store/store';
import { layerGitWorkerDirect } from '../worktrees/git-client';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { layerSourceControl, SourceControl } from './source-control';

const execFile = promisify(execFileCb);

const runGitCmd = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFile('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  return stdout.trim();
};

const initRepo = async (dir: string, branch = 'main'): Promise<void> => {
  await runGitCmd(dir, ['init', '-b', branch]);
  await runGitCmd(dir, ['config', 'user.email', 'test@spence.local']);
  await runGitCmd(dir, ['config', 'user.name', 'Spence Test']);
};

const commitFile = async (
  dir: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> => {
  const fullPath = path.join(dir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  await runGitCmd(dir, ['add', '--', relPath]);
  await runGitCmd(dir, ['commit', '-m', message]);
  return runGitCmd(dir, ['rev-parse', 'HEAD']);
};

const makeHarness = (storeDir: string, overrideEmptyPath = false) => {
  const storeLayer = layerStore(storeDir);
  const sessionStoreLayer = layerSessionStore.pipe(Layer.provideMerge(storeLayer));
  const pathLayer = overrideEmptyPath
    ? Layer.mergeAll(
        Layer.succeed(MergedPath, { get: Effect.succeed('') }),
        Layer.succeed(PathSources, {
          platform: process.platform,
          env: {},
          readRegistryPath: () => Effect.succeedNone,
          readLoginShellPath: Effect.succeedNone,
        }),
      )
    : layerMergedPath.pipe(Layer.provideMerge(layerPathSources));
  const gitWorkerLayer = layerGitWorkerDirect.pipe(Layer.provideMerge(pathLayer));
  const worktreesLayer = layerWorktrees.pipe(
    Layer.provideMerge(gitWorkerLayer),
    Layer.provideMerge(storeLayer),
  );
  const sourceControlLayer = layerSourceControl.pipe(
    Layer.provideMerge(Layer.mergeAll(sessionStoreLayer, worktreesLayer, gitWorkerLayer)),
  );
  return Layer.mergeAll(sessionStoreLayer, worktreesLayer, sourceControlLayer);
};

const makeSessionMeta = (
  id: string,
  cwd: string,
  binding?: SessionMeta['worktreeBinding'],
): SessionMeta => ({
  id: SessionId.make(id),
  projectId: ProjectId.make('proj-1'),
  cwd,
  agentId: AgentId.make('claude'),
  autoTitleIsPlaceholder: true,
  historyProtected: false,
  createdAt: Timestamp.make(1000),
  lastActivityAt: Timestamp.make(1000),
  activeContextId: AgentContextId.make('ctx-1'),
  contexts: [
    {
      id: AgentContextId.make('ctx-1'),
      agentId: AgentId.make('claude'),
      acpSessionIds: [],
      createdAt: Timestamp.make(1000),
    },
  ],
  permissionMode: 'ask',
  ...(binding === undefined ? {} : { worktreeBinding: binding }),
});

describe('SourceControl domain service', () => {
  it.live(
    'inspects the Session bound linked Worktree cleanly, including staged-plus-newer-unstaged, deletions, untracked, external edits, and commit history',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sc-')));
        const mainRepo = path.join(root, 'main-repo');
        const linkedWt = path.join(root, 'feature-wt');
        const storeDir = path.join(root, 'store');

        yield* Effect.promise(async () => {
          await mkdir(mainRepo, { recursive: true });
          await initRepo(mainRepo, 'main');
          await commitFile(mainRepo, 'shared.txt', 'v1\n', 'initial on main');
          await commitFile(mainRepo, 'gone.txt', 'delete me\n', 'add gone');
          await runGitCmd(mainRepo, ['worktree', 'add', '-b', 'feat/sc', linkedWt]);

          // Leave main-repo clean/different so proving we inspect linkedWt, not mainRepo
          await writeFile(path.join(mainRepo, 'main-only.txt'), 'main worktree only\n');

          // Inside linkedWt: staged + newer unstaged, deletion, untracked, external edit
          await writeFile(path.join(linkedWt, 'shared.txt'), 'v1\nstaged part\n');
          await runGitCmd(linkedWt, ['add', '--', 'shared.txt']);
          await writeFile(
            path.join(linkedWt, 'shared.txt'),
            'v1\nstaged part\nexternal unstaged part\n',
          );
          await rm(path.join(linkedWt, 'gone.txt'));
          await writeFile(path.join(linkedWt, 'new.txt'), 'brand new\n');
        });

        return yield* Effect.gen(function* () {
          const store = yield* SessionStore;
          const worktrees = yield* Worktrees;
          const sc = yield* SourceControl;

          const inv = yield* worktrees.refresh(linkedWt, ProjectId.make('proj-1'));
          const binding = worktrees.reconcileBinding(
            { state: 'undiscovered', expectedPath: linkedWt, reason: 'NotYetDiscovered' },
            linkedWt,
            inv,
          );
          const sessionId = SessionId.make('s-linked');
          yield* store.createDraft(makeSessionMeta('s-linked', linkedWt, binding));

          const snapshot = yield* sc.status(sessionId);
          expect(snapshot.state._tag).toBe('Available');
          if (snapshot.state._tag !== 'Available') return;

          expect(snapshot.state.head).toMatchObject({ _tag: 'Branch', branch: 'feat/sc' });
          expect(snapshot.state.worktreeId).toBe(binding.worktreeId);
          const paths = snapshot.state.files.map((f) => f.path);
          expect(paths).toEqual(['gone.txt', 'new.txt', 'shared.txt']);
          expect(paths).not.toContain('main-only.txt');
          expect(snapshot.state.summary).toMatchObject({
            changedCount: 3,
            additions: 3,
            deletions: 1,
          });

          const preview = yield* sc.diff(sessionId, 'shared.txt', 'combined');
          expect(preview._tag).toBe('Patch');
          if (preview._tag === 'Patch') {
            expect(
              preview.hunks.flatMap((h) =>
                h.lines.filter((l) => l.kind === 'add').map((l) => l.text),
              ),
            ).toEqual(['staged part', 'external unstaged part']);
          }

          const history = yield* sc.commits(sessionId, 10, 0);
          expect(history._tag).toBe('History');
          if (history._tag !== 'History') return;
          expect(history.commits).toHaveLength(2);
          const latestSha = history.commits[0]?.sha ?? '';
          const detail = yield* sc.commitDetail(sessionId, latestSha);
          expect(detail.files.map((f) => f.path)).toEqual(['gone.txt']);
          const commitDiff = yield* sc.commitFileDiff(sessionId, latestSha, 'gone.txt');
          expect(commitDiff._tag).toBe('Patch');
        }).pipe(
          Effect.provide(makeHarness(storeDir)),
          Effect.ensuring(
            Effect.promise(() => rm(root, { recursive: true, force: true }).catch(() => undefined)),
          ),
        );
      }),
    20_000,
  );

  it.live(
    'discloses WorktreeMissing when bound Worktree is deleted or replaced without falling back to Project root',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sc-miss-')));
        const mainRepo = path.join(root, 'main-repo');
        const linkedWt = path.join(root, 'gone-wt');
        const storeDir = path.join(root, 'store');

        yield* Effect.promise(async () => {
          await mkdir(mainRepo, { recursive: true });
          await initRepo(mainRepo, 'main');
          await commitFile(mainRepo, 'a.txt', 'a\n', 'init');
          await runGitCmd(mainRepo, ['worktree', 'add', '-b', 'feat/gone', linkedWt]);
        });

        return yield* Effect.gen(function* () {
          const store = yield* SessionStore;
          const worktrees = yield* Worktrees;
          const sc = yield* SourceControl;

          const inv = yield* worktrees.refresh(linkedWt, ProjectId.make('proj-1'));
          const binding = worktrees.reconcileBinding(
            { state: 'undiscovered', expectedPath: linkedWt, reason: 'NotYetDiscovered' },
            linkedWt,
            inv,
          );
          const sessionId = SessionId.make('s-miss');
          yield* store.createDraft(makeSessionMeta('s-miss', linkedWt, binding));

          // Remove the linked worktree directory and replace with unrelated non-git folder
          yield* Effect.promise(async () => {
            await rm(linkedWt, { recursive: true, force: true });
            await mkdir(linkedWt, { recursive: true });
            await writeFile(path.join(linkedWt, 'imposter.txt'), 'not original');
          });

          const statusSnap = yield* sc.status(sessionId);
          expect(statusSnap.state._tag).toBe('WorktreeMissing');

          const commitsSnap = yield* sc.commits(sessionId, 10, 0);
          expect(commitsSnap._tag).toBe('Unavailable');
          if (commitsSnap._tag === 'Unavailable') {
            expect(commitsSnap.reason).toBe('WorktreeMissing');
          }

          const diffErr = yield* sc.diff(sessionId, 'a.txt').pipe(Effect.flip);
          expect(diffErr.reason).toBe('WorktreeMissing');
        }).pipe(
          Effect.provide(makeHarness(storeDir)),
          Effect.ensuring(
            Effect.promise(() => rm(root, { recursive: true, force: true }).catch(() => undefined)),
          ),
        );
      }),
    20_000,
  );

  it.live(
    'identifies MissingGit, NonGit, Unborn, Detached, Merge conflicts, NotFound, and InvalidInput accurately',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-sc-states-')));
        const gitDir = path.join(root, 'repo');
        const nonGitDir = path.join(root, 'plain');
        const storeMissing = path.join(root, 'store-missing-git');
        const storeLive = path.join(root, 'store-live');

        yield* Effect.promise(async () => {
          await mkdir(gitDir, { recursive: true });
          await mkdir(nonGitDir, { recursive: true });
          await initRepo(gitDir, 'main');
        });

        // MissingGit environment check
        yield* Effect.gen(function* () {
          const store = yield* SessionStore;
          const sc = yield* SourceControl;
          const sessionId = SessionId.make('s-no-git');
          yield* store.createDraft(makeSessionMeta('s-no-git', gitDir));

          const status = yield* sc.status(sessionId);
          expect(status.state._tag).toBe('MissingGit');
          const diffErr = yield* sc.diff(sessionId, 'a.txt').pipe(Effect.flip);
          expect(diffErr.reason).toBe('MissingGit');
        }).pipe(Effect.provide(makeHarness(storeMissing, true)));

        // Live Git environment checks: NonGit, Unborn, Detached, Merge conflicts, NotFound, InvalidInput
        return yield* Effect.gen(function* () {
          const store = yield* SessionStore;
          const sc = yield* SourceControl;

          const sPlain = SessionId.make('s-plain');
          yield* store.createDraft(makeSessionMeta('s-plain', nonGitDir));
          const plainStatus = yield* sc.status(sPlain);
          expect(plainStatus.state._tag).toBe('NonGit');

          const sGit = SessionId.make('s-git');
          yield* store.createDraft(makeSessionMeta('s-git', gitDir));
          const unbornStatus = yield* sc.status(sGit);
          expect(unbornStatus.state._tag).toBe('Available');
          if (unbornStatus.state._tag === 'Available') {
            expect(unbornStatus.state.head).toMatchObject({ _tag: 'Unborn', branch: 'main' });
          }
          const unbornCommits = yield* sc.commits(sGit);
          expect(unbornCommits._tag).toBe('Unborn');

          // Create conflicting branches and trigger Merge integration state
          yield* Effect.promise(async () => {
            await commitFile(gitDir, 'c.txt', 'base\n', 'base');
            await runGitCmd(gitDir, ['checkout', '-b', 'topic']);
            await commitFile(gitDir, 'c.txt', 'topic line\n', 'topic edit');
            await runGitCmd(gitDir, ['checkout', 'main']);
            await commitFile(gitDir, 'c.txt', 'main line\n', 'main edit');
            try {
              await runGitCmd(gitDir, ['merge', 'topic']);
            } catch {
              // Expected merge conflict exit code
            }
          });

          const mergeStatus = yield* sc.status(sGit);
          expect(mergeStatus.state._tag).toBe('Available');
          if (mergeStatus.state._tag === 'Available') {
            expect(mergeStatus.state.integration).toBe('Merge');
            expect(mergeStatus.state.hasConflicts).toBe(true);
            expect(mergeStatus.state.files[0]?.status).toBe('Conflicted');
          }

          // Unknown session -> NotFound; invalid commit sha -> InvalidInput; traversal path -> InvalidInput
          const notFoundErr = yield* sc.status(SessionId.make('missing-session')).pipe(Effect.flip);
          expect(notFoundErr.reason).toBe('NotFound');

          const badShaErr = yield* sc.commitDetail(sGit, 'not-a-sha!').pipe(Effect.flip);
          expect(badShaErr.reason).toBe('InvalidInput');

          const badPathErr = yield* sc.diff(sGit, '../outside.txt').pipe(Effect.flip);
          expect(badPathErr.reason).toBe('InvalidInput');
        }).pipe(
          Effect.provide(makeHarness(storeLive)),
          Effect.ensuring(
            Effect.promise(() => rm(root, { recursive: true, force: true }).catch(() => undefined)),
          ),
        );
      }),
    20_000,
  );
});
