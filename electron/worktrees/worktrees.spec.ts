import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, type Scope, Stream } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MergedPath, PathSources, layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStore } from '../store/store';
import { layerGitWorkerDirect } from './git-client';
import { layerWorktrees, Worktrees } from './worktrees';

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

const withTempEnv = <A, E>(
  fn: (dirs: {
    readonly storeRoot: string;
    readonly workspace: string;
  }) => Effect.Effect<A, E, Worktrees | Scope.Scope>,
  options?: { readonly missingGit?: boolean },
) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const base = await mkdtemp(path.join(tmpdir(), 'spence-worktrees-'));
      const storeRoot = path.join(base, 'store');
      const workspace = path.join(base, 'workspace');
      await mkdir(storeRoot, { recursive: true });
      await mkdir(workspace, { recursive: true });
      return { base, storeRoot, workspace };
    }),
    ({ storeRoot, workspace }) => {
      const pathLayer = options?.missingGit
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
      const gitWorker = layerGitWorkerDirect.pipe(Layer.provide(pathLayer));
      const store = layerStore(storeRoot);
      const worktrees = layerWorktrees.pipe(
        Layer.provide(Layer.mergeAll(gitWorker, store, pathLayer)),
      );
      return fn({ storeRoot, workspace }).pipe(Effect.provide(worktrees), Effect.scoped);
    },
    ({ base }) =>
      Effect.promise(() =>
        rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
      ),
  );

describe('Worktrees discovery, identity, and reconciliation', () => {
  it.live(
    'discovers repository worktrees, unborn repos, nested subfolders, and preserves IDs',
    () =>
      withTempEnv(({ workspace }) =>
        Effect.gen(function* () {
          const worktrees = yield* Worktrees;

          // Unborn repo first
          const unbornRepo = path.join(workspace, 'unborn');
          yield* Effect.promise(() => mkdir(unbornRepo, { recursive: true }));
          yield* Effect.promise(() => git(unbornRepo, 'init', '-b', 'main'));
          const unbornInv = yield* worktrees.refresh(unbornRepo);
          expect(unbornInv.capability._tag).toBe('Available');
          expect(unbornInv.worktrees).toHaveLength(1);
          expect(unbornInv.worktrees[0]?.head).toEqual({ _tag: 'Unborn', branch: 'main' });

          // Committed repo with linked worktree + subfolder probe
          const repo = path.join(workspace, 'repo');
          const subDir = path.join(repo, 'packages', 'app');
          const linked = path.join(workspace, 'repo-auth');
          yield* Effect.promise(() => mkdir(subDir, { recursive: true }));
          yield* Effect.promise(() => git(repo, 'init', '-b', 'main'));
          yield* Effect.promise(() => writeFile(path.join(repo, 'README.md'), 'hi\n'));
          yield* Effect.promise(() => git(repo, 'add', 'README.md'));
          yield* Effect.promise(() => git(repo, 'commit', '-m', 'init'));
          yield* Effect.promise(() => git(repo, 'worktree', 'add', '-b', 'feature/auth', linked));

          const first = yield* worktrees.refresh(repo);
          expect(first.capability._tag).toBe('Available');
          expect(first.repositoryId).toBeDefined();
          expect(first.currentWorktreeId).toBeDefined();
          expect(first.worktrees).toHaveLength(2);
          const primary = first.worktrees.find((w) => w.isPrimary);
          const feature = first.worktrees.find((w) => !w.isPrimary);
          expect(primary?.head._tag).toBe('Branch');
          expect(feature?.head._tag).toBe('Branch');

          // Subfolder inside the linked/primary checkout resolves to the same WorktreeId and RepositoryId.
          const fromSub = yield* worktrees.refresh(subDir);
          expect(fromSub.repositoryId).toBe(first.repositoryId);
          expect(fromSub.currentWorktreeId).toBe(first.currentWorktreeId);

          // Live updates stream emits refresh results.
          const updatesFiber = yield* worktrees.updates.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          const second = yield* worktrees.refresh(linked);
          const collected = yield* Fiber.join(updatesFiber);
          expect([...collected][0]?.currentWorktreeId).toBe(feature?.id);
          expect(second.repositoryId).toBe(first.repositoryId);
        }),
      ),
    20_000,
  );

  it.live(
    'reconciles path aliases (case differences and junctions/symlinks) without duplicating IDs',
    () =>
      withTempEnv(({ workspace }) =>
        Effect.gen(function* () {
          const worktrees = yield* Worktrees;
          const repo = path.join(workspace, 'CaseRepo');
          const aliasLink = path.join(workspace, 'AliasLink');
          yield* Effect.promise(() => mkdir(repo, { recursive: true }));
          yield* Effect.promise(() => git(repo, 'init', '-b', 'main'));
          yield* Effect.promise(() => writeFile(path.join(repo, 'a.txt'), 'a\n'));
          yield* Effect.promise(() => git(repo, 'add', 'a.txt'));
          yield* Effect.promise(() => git(repo, 'commit', '-m', 'init'));
          yield* Effect.promise(() =>
            symlink(repo, aliasLink, process.platform === 'win32' ? 'junction' : 'dir'),
          );

          const canonical = yield* worktrees.refresh(repo);
          const viaLink = yield* worktrees.refresh(aliasLink);
          expect(viaLink.repositoryId).toBe(canonical.repositoryId);
          expect(viaLink.currentWorktreeId).toBe(canonical.currentWorktreeId);

          if (process.platform === 'win32') {
            const mixedCase = repo.replace('CaseRepo', 'caserepo');
            const viaCase = yield* worktrees.refresh(mixedCase);
            expect(viaCase.repositoryId).toBe(canonical.repositoryId);
            expect(viaCase.currentWorktreeId).toBe(canonical.currentWorktreeId);
          }
        }),
      ),
    20_000,
  );

  it.live(
    'does not silently adopt a replacement folder at the same path',
    () =>
      withTempEnv(({ workspace }) =>
        Effect.gen(function* () {
          const worktrees = yield* Worktrees;
          const repo = path.join(workspace, 'replaceable');
          yield* Effect.promise(() => mkdir(repo, { recursive: true }));
          yield* Effect.promise(() => git(repo, 'init', '-b', 'main'));
          yield* Effect.promise(() => writeFile(path.join(repo, 'a.txt'), 'a\n'));
          yield* Effect.promise(() => git(repo, 'add', 'a.txt'));
          yield* Effect.promise(() => git(repo, 'commit', '-m', 'init'));

          const initial = yield* worktrees.refresh(repo);
          const binding = worktrees.reconcileBinding({ state: 'undiscovered' }, repo, initial);
          expect(binding.state).toBe('resolved');
          expect(binding.repositoryId).toBe(initial.repositoryId);
          expect(binding.worktreeId).toBe(initial.currentWorktreeId);

          // Replace folder with a brand-new unrelated git repo at the exact same path!
          yield* Effect.promise(() =>
            rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          );
          yield* Effect.promise(() => mkdir(repo, { recursive: true }));
          yield* Effect.promise(() => git(repo, 'init', '-b', 'other'));
          yield* Effect.promise(() => writeFile(path.join(repo, 'b.txt'), 'b\n'));
          yield* Effect.promise(() => git(repo, 'add', 'b.txt'));
          yield* Effect.promise(() => git(repo, 'commit', '-m', 'other'));

          const afterNewRepo = yield* worktrees.refresh(repo);
          expect(afterNewRepo.repositoryId).not.toBe(initial.repositoryId);
          expect(afterNewRepo.currentWorktreeId).not.toBe(initial.currentWorktreeId);
          const reconciledRepoReplacement = worktrees.reconcileBinding(binding, repo, afterNewRepo);
          expect(reconciledRepoReplacement.state).toBe('missing');
          expect(reconciledRepoReplacement.reason).toBe('ReplacedFolder');
          expect(reconciledRepoReplacement.worktreeId).toBe(binding.worktreeId);

          // Replace folder with a plain non-Git directory at the exact same path!
          yield* Effect.promise(() =>
            rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          );
          yield* Effect.promise(() => mkdir(repo, { recursive: true }));
          const afterPlainDir = yield* worktrees.refresh(repo);
          const reconciledNonGitReplacement = worktrees.reconcileBinding(
            binding,
            repo,
            afterPlainDir,
          );
          expect(reconciledNonGitReplacement.state).toBe('missing');
          expect(reconciledNonGitReplacement.reason).toBe('ReplacedFolder');
        }),
      ),
    20_000,
  );

  it.live(
    'marks deleted linked worktree as missing without losing registered WorktreeId',
    () =>
      withTempEnv(({ workspace }) =>
        Effect.gen(function* () {
          const worktrees = yield* Worktrees;
          const repo = path.join(workspace, 'repo');
          const linked = path.join(workspace, 'linked-wt');
          yield* Effect.promise(() => mkdir(repo, { recursive: true }));
          yield* Effect.promise(() => git(repo, 'init', '-b', 'main'));
          yield* Effect.promise(() => writeFile(path.join(repo, 'a.txt'), 'a\n'));
          yield* Effect.promise(() => git(repo, 'add', 'a.txt'));
          yield* Effect.promise(() => git(repo, 'commit', '-m', 'init'));
          yield* Effect.promise(() => git(repo, 'worktree', 'add', '-b', 'feat', linked));

          const before = yield* worktrees.refresh(linked);
          const binding = worktrees.reconcileBinding({ state: 'undiscovered' }, linked, before);
          expect(binding.state).toBe('resolved');

          yield* Effect.promise(() =>
            rm(linked, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
          );
          const fromRepo = yield* worktrees.refresh(repo);
          const prunableEntry = fromRepo.worktrees.find((w) => w.id === binding.worktreeId);
          expect(prunableEntry?.missing).toBe(true);

          const fromDeletedPath = yield* worktrees.refresh(linked);
          expect(fromDeletedPath.capability._tag).toBe('MissingPath');
          const reconciledMissing = worktrees.reconcileBinding(binding, linked, fromDeletedPath);
          expect(reconciledMissing.state).toBe('missing');
          expect(reconciledMissing.reason).toBe('MissingPath');
        }),
      ),
    20_000,
  );

  it.live(
    'surfaces MissingGit capability and leaves newer-version registry untouched',
    () =>
      withTempEnv(
        ({ storeRoot, workspace }) =>
          Effect.gen(function* () {
            const worktrees = yield* Worktrees;
            const missingGitInv = yield* worktrees.refresh(workspace);
            expect(missingGitInv.capability._tag).toBe('MissingGit');

            const registryPath = path.join(storeRoot, 'worktrees', 'registry.json');
            const newerRaw = JSON.stringify({ version: 99, body: { future: true } });
            yield* Effect.promise(() => mkdir(path.dirname(registryPath), { recursive: true }));
            yield* Effect.promise(() => writeFile(registryPath, newerRaw));

            const err = yield* worktrees.inventory(workspace).pipe(Effect.flip);
            expect(err._tag).toBe('WorktreesError');
            if (err._tag === 'WorktreesError') {
              expect(err.reason).toBe('NewerVersion');
            }
            expect(yield* Effect.promise(() => readFile(registryPath, 'utf8'))).toBe(newerRaw);
          }),
        { missingGit: true },
      ),
    20_000,
  );

  it.live(
    'reports per-worktree change summary and validates identity on explicit Worktree locate/rebind',
    () =>
      withTempEnv(
        ({ workspace }) =>
          Effect.gen(function* () {
            const mainRepo = path.join(workspace, 'repo');
            const wtFeature = path.join(workspace, 'wt-feature');
            const wtMoved = path.join(workspace, 'wt-moved');
            const wtUnrepaired = path.join(workspace, 'wt-unrepaired');
            const otherRepo = path.join(workspace, 'other-repo');
            const plainDir = path.join(workspace, 'plain-dir');
            yield* Effect.promise(() => mkdir(mainRepo, { recursive: true }));
            yield* Effect.promise(() => git(mainRepo, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(mainRepo, 'app.txt'), 'v1\n'));
            yield* Effect.promise(() => git(mainRepo, 'add', 'app.txt'));
            yield* Effect.promise(() => git(mainRepo, 'commit', '-m', 'init'));
            yield* Effect.promise(() =>
              git(mainRepo, 'worktree', 'add', '-b', 'feat/locate', wtFeature),
            );
            yield* Effect.promise(() => writeFile(path.join(wtFeature, 'app.txt'), 'v2\nextra\n'));

            yield* Effect.promise(() => mkdir(otherRepo, { recursive: true }));
            yield* Effect.promise(() => git(otherRepo, 'init', '-b', 'main'));
            yield* Effect.promise(() => writeFile(path.join(otherRepo, 'other.txt'), 'o\n'));
            yield* Effect.promise(() => git(otherRepo, 'add', 'other.txt'));
            yield* Effect.promise(() => git(otherRepo, 'commit', '-m', 'other'));
            yield* Effect.promise(() => mkdir(plainDir, { recursive: true }));

            const worktrees = yield* Worktrees;
            const initial = yield* worktrees.refresh(wtFeature);
            const mainBefore = initial.worktrees.find((w) => w.isPrimary);
            const featBefore = initial.worktrees.find((w) => w.path === wtFeature || !w.isPrimary);
            expect(featBefore).toBeDefined();
            expect(mainBefore).toBeDefined();
            if (featBefore === undefined || mainBefore === undefined) return;
            expect(featBefore.changes).toEqual({
              changedFiles: 1,
              staged: 0,
              unstaged: 1,
              untracked: 0,
              additions: 2,
              deletions: 1,
            });

            const missingBinding = {
              state: 'missing' as const,
              repositoryId: featBefore.repositoryId,
              worktreeId: featBefore.id,
              expectedPath: wtFeature,
              reason: 'MissingPath' as const,
              lastKnownBranch: 'feat/locate',
            };

            // Move via git worktree move -> preserves repo + checkout identity + registration -> Verified!
            yield* Effect.promise(() => git(mainRepo, 'worktree', 'move', wtFeature, wtMoved));

            // 1. Different repo requires explicit rebind without changing registry.
            const wrongRepo = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: otherRepo,
            });
            expect(wrongRepo._tag).toBe('RequiresRebind');
            if (wrongRepo._tag === 'RequiresRebind') {
              expect(wrongRepo.mismatchReason).toBe('DifferentRepository');
            }

            // 2. Different checkout in the SAME repo requires explicit rebind.
            const wrongCheckout = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: mainRepo,
            });
            expect(wrongCheckout._tag).toBe('RequiresRebind');
            if (wrongCheckout._tag === 'RequiresRebind') {
              expect(wrongCheckout.mismatchReason).toBe('DifferentCheckout');
            }

            // 3. NonGit directory requires explicit rebind.
            const nonGit = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: plainDir,
            });
            expect(nonGit._tag).toBe('RequiresRebind');
            if (nonGit._tag === 'RequiresRebind') {
              expect(nonGit.mismatchReason).toBe('NonGit');
            }

            // 4. Verified moved checkout preserves WorktreeId + RepositoryId and updates registered path.
            const verified = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: wtMoved,
            });
            expect(verified._tag).toBe('Verified');
            if (verified._tag === 'Verified') {
              expect(verified.entry.id).toBe(featBefore.id);
              expect(verified.entry.repositoryId).toBe(featBefore.repositoryId);
              expect(verified.entry.missing).toBe(false);
              expect(verified.binding.state).toBe('resolved');
              expect(verified.binding.worktreeId).toBe(featBefore.id);
              expect(verified.binding.expectedPath).toBe(verified.entry.path);
            }

            // 5. Unrepaired fs rename makes Git registration missing -> RequiresRebind ('UnregisteredWorktree').
            yield* Effect.promise(() => rename(wtMoved, wtUnrepaired));
            const unregistered = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: wtUnrepaired,
            });
            expect(unregistered._tag).toBe('RequiresRebind');
            if (unregistered._tag === 'RequiresRebind') {
              expect(unregistered.mismatchReason).toBe('UnregisteredWorktree');
            }

            // 6. Explicit rebind to another repository establishes new resolved binding.
            const rebound = yield* worktrees.locate({
              expectedBinding: missingBinding,
              targetPath: otherRepo,
              allowRebind: true,
            });
            expect(rebound._tag).toBe('Rebound');
            if (rebound._tag === 'Rebound') {
              expect(rebound.binding.state).toBe('resolved');
              expect(rebound.binding.repositoryId).not.toBe(featBefore.repositoryId);
              expect(rebound.binding.expectedPath).toBe(rebound.inventory.worktrees[0]?.path);
            }
          }),
        undefined,
      ),
    20_000,
  );
});
