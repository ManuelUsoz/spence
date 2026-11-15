import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MergedPath, PathSources, layerMergedPath, layerPathSources } from '../agents/merged-path';
import {
  GitWorker,
  type WorkerClientTransport,
  layerGitWorkerDirect,
  layerGitWorkerWithPort,
  type WorkerPortLike,
} from '../worktrees/git-client';
import { connectWorkerPort } from './source-control-worker';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

const execFile = promisify(execFileCb);
const TIMEOUT = 20_000;

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

const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-git-worker-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

const gitEff = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => (await git(cwd, ...args)).stdout);

describe('SourceControlWorker & GitWorker', () => {
  it.effect('reports MissingGit when MergedPath cannot resolve git', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const worker = yield* GitWorker;
        const probe = yield* worker.probe(dir);
        expect(probe._tag).toBe('MissingGit');
      }).pipe(
        Effect.provide(
          layerGitWorkerDirect.pipe(
            Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed('') })),
            Layer.provide(
              Layer.succeed(PathSources, {
                platform: process.platform,
                env: {},
                readRegistryPath: () => Effect.succeedNone,
                readLoginShellPath: Effect.succeedNone,
              }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect('reports MissingPath and NonGit accurately', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const worker = yield* GitWorker;
        const missing = yield* worker.probe(path.join(dir, 'does-not-exist'));
        expect(missing._tag).toBe('MissingPath');

        const nonGit = yield* worker.probe(dir);
        expect(nonGit._tag).toBe('NonGit');
      }).pipe(
        Effect.provide(
          layerGitWorkerDirect.pipe(
            Layer.provideMerge(layerMergedPath),
            Layer.provideMerge(layerPathSources),
          ),
        ),
      ),
    ),
  );

  it.effect(
    'probes real repository and worktrees over worker port protocol with shell: false',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const mainRepo = path.join(dir, 'main-repo');
          const extraWorktree = path.join(dir, 'wt-feature');
          const detachedWorktree = path.join(dir, 'wt-detached');
          yield* Effect.promise(() => mkdir(mainRepo, { recursive: true }));
          yield* Effect.promise(() => git(mainRepo, 'init', '-b', 'main'));
          yield* Effect.promise(() => writeFile(path.join(mainRepo, 'README.md'), 'hello\n'));
          yield* Effect.promise(() => git(mainRepo, 'add', 'README.md'));
          yield* Effect.promise(() => git(mainRepo, 'commit', '-m', 'init'));
          yield* Effect.promise(() =>
            git(mainRepo, 'worktree', 'add', '-b', 'feature/auth', extraWorktree),
          );
          yield* Effect.promise(() =>
            git(mainRepo, 'worktree', 'add', '--detach', detachedWorktree),
          );

          const clientListeners = new Set<(response: WorkerResponse) => void>();
          const serverListeners = new Set<(request: WorkerRequest) => void>();
          const workerPort: WorkerPortLike = {
            onMessage: (listener) => {
              serverListeners.add(listener);
            },
            postMessage: (response) => {
              for (const listener of clientListeners) {
                listener(response as WorkerResponse);
              }
            },
          };
          const hostPort = {
            onResponse: (listener: (response: WorkerResponse) => void) => {
              clientListeners.add(listener);
              return () => void clientListeners.delete(listener);
            },
            postRequest: (request: WorkerRequest) => {
              for (const listener of serverListeners) {
                listener(request);
              }
            },
            shutdown: () => Effect.void,
          };
          const disconnect = connectWorkerPort(workerPort);
          yield* Effect.addFinalizer(() => Effect.sync(() => disconnect()));

          const workerLayer = layerGitWorkerWithPort(hostPort).pipe(
            Layer.provideMerge(layerMergedPath),
            Layer.provideMerge(layerPathSources),
          );

          const result = yield* Effect.gen(function* () {
            const worker = yield* GitWorker;
            const ping = yield* worker.ping();
            expect(ping.pid).toBeGreaterThan(0);
            return yield* worker.probe(extraWorktree);
          }).pipe(Effect.provide(workerLayer));

          expect(result._tag).toBe('Available');
          if (result._tag === 'Available') {
            expect(result.gitVersion.length).toBeGreaterThan(0);
            expect(result.worktrees).toHaveLength(3);
            const branches = result.worktrees.map((entry) =>
              entry.branch !== undefined ? entry.branch : entry.detached ? 'detached' : 'unknown',
            );
            expect(branches).toContain('main');
            expect(branches).toContain('feature/auth');
            expect(branches).toContain('detached');
          }
        }).pipe(Effect.scoped),
      ),
    TIMEOUT,
  );

  it.effect(
    'reports UnsupportedRepo for unsupported repository format or corrupt index',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const unsupportedRepo = path.join(dir, 'unsupported-repo');
          yield* Effect.promise(() => mkdir(unsupportedRepo, { recursive: true }));
          yield* Effect.promise(() => git(unsupportedRepo, 'init', '-b', 'main'));
          yield* Effect.promise(() =>
            writeFile(
              path.join(unsupportedRepo, '.git', 'config'),
              '[core]\n\trepositoryformatversion = 99\n\tfilemode = false\n',
            ),
          );

          const badIndexRepo = path.join(dir, 'bad-index-repo');
          yield* Effect.promise(() => mkdir(badIndexRepo, { recursive: true }));
          yield* Effect.promise(() => git(badIndexRepo, 'init', '-b', 'main'));
          yield* Effect.promise(() =>
            writeFile(
              path.join(badIndexRepo, '.git', 'index'),
              Buffer.from('DIRC\x00\x00\x00\x63'),
            ),
          );

          const worker = yield* GitWorker;
          const first = yield* worker.probe(unsupportedRepo);
          expect(first._tag).toBe('UnsupportedRepo');

          const second = yield* worker.probe(badIndexRepo);
          expect(second._tag).toBe('UnsupportedRepo');
        }).pipe(
          Effect.provide(
            layerGitWorkerDirect.pipe(
              Layer.provideMerge(layerMergedPath),
              Layer.provideMerge(layerPathSources),
            ),
          ),
        ),
      ),
    TIMEOUT,
  );

  it.effect(
    'inspectCreateContext reports head commit, dirty count, eligible branches, target checks, and active merge',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const repo = path.join(dir, 'repo');
          const destSibling = path.join(dir, 'repo-feat');
          const destInside = path.join(repo, 'nested-wt');
          const checkedOutWt = path.join(dir, 'wt-existing');

          yield* Effect.tryPromise(() => mkdir(repo, { recursive: true }));
          yield* gitEff(repo, 'init', '-b', 'main');
          yield* gitEff(repo, 'config', 'user.email', 'test@spence.local');
          yield* gitEff(repo, 'config', 'user.name', 'Spence Test');
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'README.md'), 'init\n'));
          yield* gitEff(repo, 'add', '.');
          yield* gitEff(repo, 'commit', '-m', 'init');
          const headSha = (yield* gitEff(repo, 'rev-parse', 'HEAD')).trim();

          yield* gitEff(repo, 'branch', 'eligible-branch');
          yield* gitEff(repo, 'branch', 'checked-out-branch');
          yield* gitEff(repo, 'worktree', 'add', checkedOutWt, 'checked-out-branch');
          // Dirty tracked + untracked files in source checkout.
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'README.md'), 'dirty\n'));
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'scratch.txt'), 'untracked\n'));

          const worker = yield* GitWorker;
          const ctx = yield* worker.inspectCreateContext(repo, {
            destinationPath: destSibling,
            branch: 'feat/new-wt',
          });
          expect(ctx._tag).toBe('Available');
          if (ctx._tag !== 'Available') return;

          expect(ctx.head).toEqual({ _tag: 'Branch', branch: 'main', commit: headSha });
          expect(ctx.dirtyCount).toBe(2);
          expect(ctx.integrationActive).toBeNull();
          expect(ctx.branches).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ name: 'eligible-branch', checkedOut: false }),
              expect.objectContaining({ name: 'checked-out-branch', checkedOut: true }),
              expect.objectContaining({ name: 'main', checkedOut: true }),
            ]),
          );
          expect(ctx.destinationCheck).toMatchObject({
            destinationExists: false,
            insideSourceOrRepo: false,
            touchesGitAdmin: false,
          });
          expect(ctx.branchCheck).toEqual({
            branch: 'feat/new-wt',
            validName: true,
            exists: false,
            existingCommit: null,
            checkedOutElsewhere: false,
          });

          const insideCheck = yield* worker.inspectCreateContext(repo, {
            destinationPath: destInside,
            branch: '--bad-branch',
          });
          expect(insideCheck._tag).toBe('Available');
          if (insideCheck._tag !== 'Available') return;
          expect(insideCheck.destinationCheck?.insideSourceOrRepo).toBe(true);
          expect(insideCheck.branchCheck?.validName).toBe(false);

          // Simulate active merge state in .git/MERGE_HEAD.
          yield* Effect.tryPromise(() =>
            writeFile(path.join(repo, '.git', 'MERGE_HEAD'), `${headSha}\n`),
          );
          const mergeCtx = yield* worker.inspectCreateContext(repo);
          expect(mergeCtx._tag).toBe('Available');
          if (mergeCtx._tag === 'Available') {
            expect(mergeCtx.integrationActive).toBe('merge');
          }
        }).pipe(
          Effect.provide(
            layerGitWorkerDirect.pipe(
              Layer.provideMerge(layerMergedPath),
              Layer.provideMerge(layerPathSources),
            ),
          ),
        ),
      ),
    TIMEOUT,
  );

  it.effect(
    'createWorktree creates new branch and existing branch worktrees cleanly while preserving dirty source files',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const repo = path.join(dir, 'repo');
          const destNew = path.join(dir, 'repo-new');
          const destExisting = path.join(dir, 'repo-existing');

          yield* Effect.tryPromise(() => mkdir(repo, { recursive: true }));
          yield* gitEff(repo, 'init', '-b', 'main');
          yield* gitEff(repo, 'config', 'user.email', 'test@spence.local');
          yield* gitEff(repo, 'config', 'user.name', 'Spence Test');
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'tracked.txt'), 'v1\n'));
          yield* gitEff(repo, 'add', '.');
          yield* gitEff(repo, 'commit', '-m', 'init');
          const headSha = (yield* gitEff(repo, 'rev-parse', 'HEAD')).trim();
          yield* gitEff(repo, 'branch', 'ready-branch');

          // Uncommitted source changes must stay untouched in `repo`.
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'tracked.txt'), 'v1-dirty\n'));
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'untracked.txt'), 'keep me\n'));

          const worker = yield* GitWorker;
          const ctx = yield* worker.inspectCreateContext(repo);
          expect(ctx._tag).toBe('Available');
          if (ctx._tag !== 'Available') return;

          const createdNew = yield* worker.createWorktree({
            folder: repo,
            destinationPath: destNew,
            expectedCommonDirRealPath: ctx.commonDirRealPath,
            expectedCommonDirIdentity: ctx.commonDirIdentity,
            mode: 'NewBranch',
            branch: 'feat/from-head',
            startPoint: headSha,
          });
          expect(createdNew.branch).toBe('feat/from-head');
          expect(createdNew.commit).toBe(headSha);

          // Dirty source files are retained in source; new worktree has clean committed content.
          expect(
            yield* Effect.tryPromise(() => readFile(path.join(repo, 'tracked.txt'), 'utf8')),
          ).toBe('v1-dirty\n');
          expect(
            yield* Effect.tryPromise(() => readFile(path.join(repo, 'untracked.txt'), 'utf8')),
          ).toBe('keep me\n');
          expect(
            (yield* Effect.tryPromise(() =>
              readFile(path.join(destNew, 'tracked.txt'), 'utf8'),
            )).replace(/\r\n/g, '\n'),
          ).toBe('v1\n');

          const postNew = yield* worker.inspectPostWorktreeCreate(repo, destNew, 'feat/from-head');
          expect(postNew).toMatchObject({
            folderExists: true,
            registeredInGit: true,
            registeredBranch: 'feat/from-head',
            branchExists: true,
            clean: true,
            headCommit: headSha,
          });

          const createdExisting = yield* worker.createWorktree({
            folder: repo,
            destinationPath: destExisting,
            expectedCommonDirRealPath: ctx.commonDirRealPath,
            expectedCommonDirIdentity: ctx.commonDirIdentity,
            mode: 'ExistingBranch',
            branch: 'ready-branch',
            startPoint: headSha,
          });
          expect(createdExisting.branch).toBe('ready-branch');
          const postExisting = yield* worker.inspectPostWorktreeCreate(
            repo,
            destExisting,
            'ready-branch',
          );
          expect(postExisting.registeredInGit).toBe(true);
          expect(postExisting.registeredBranch).toBe('ready-branch');
        }).pipe(
          Effect.provide(
            layerGitWorkerDirect.pipe(
              Layer.provideMerge(layerMergedPath),
              Layer.provideMerge(layerPathSources),
            ),
          ),
        ),
      ),
    TIMEOUT,
  );

  it.effect(
    'createWorktree rejects untrusted destinations, symlink/junction escapes, invalid branches, and repo mismatches',
    () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const repo = path.join(dir, 'repo');
          yield* Effect.tryPromise(() => mkdir(repo, { recursive: true }));
          yield* gitEff(repo, 'init', '-b', 'main');
          yield* gitEff(repo, 'config', 'user.email', 'test@spence.local');
          yield* gitEff(repo, 'config', 'user.name', 'Spence Test');
          yield* Effect.tryPromise(() => writeFile(path.join(repo, 'a.txt'), 'a\n'));
          yield* gitEff(repo, 'add', '.');
          yield* gitEff(repo, 'commit', '-m', 'init');
          const headSha = (yield* gitEff(repo, 'rev-parse', 'HEAD')).trim();

          const worker = yield* GitWorker;
          const ctx = yield* worker.inspectCreateContext(repo);
          expect(ctx._tag).toBe('Available');
          if (ctx._tag !== 'Available') return;

          // 1. Flag-like branch injection attempt
          const badFlagBranch = yield* worker
            .createWorktree({
              folder: repo,
              destinationPath: path.join(dir, 'wt-flag'),
              expectedCommonDirRealPath: ctx.commonDirRealPath,
              expectedCommonDirIdentity: ctx.commonDirIdentity,
              mode: 'NewBranch',
              branch: '--upload-pack=evil',
              startPoint: headSha,
            })
            .pipe(Effect.result);
          expect(badFlagBranch._tag).toBe('Failure');

          // 2. Inside source worktree
          const insideSource = yield* worker
            .createWorktree({
              folder: repo,
              destinationPath: path.join(repo, 'inside-wt'),
              expectedCommonDirRealPath: ctx.commonDirRealPath,
              expectedCommonDirIdentity: ctx.commonDirIdentity,
              mode: 'NewBranch',
              branch: 'feat/inside',
              startPoint: headSha,
            })
            .pipe(Effect.result);
          expect(insideSource._tag).toBe('Failure');

          // 3. Targeting .git admin directory
          const insideGit = yield* worker
            .createWorktree({
              folder: repo,
              destinationPath: path.join(repo, '.git', 'evil-wt'),
              expectedCommonDirRealPath: ctx.commonDirRealPath,
              expectedCommonDirIdentity: ctx.commonDirIdentity,
              mode: 'NewBranch',
              branch: 'feat/gitdir',
              startPoint: headSha,
            })
            .pipe(Effect.result);
          expect(insideGit._tag).toBe('Failure');

          // 4. Junction / symlink escaping into source repository
          const linkIntoRepo = path.join(dir, 'link-to-repo');
          const symlinkOk = yield* Effect.tryPromise(() =>
            symlink(repo, linkIntoRepo, process.platform === 'win32' ? 'junction' : 'dir'),
          ).pipe(
            Effect.as(true),
            Effect.catch(() => Effect.succeed(false)),
          );
          if (symlinkOk) {
            const escaped = yield* worker
              .createWorktree({
                folder: repo,
                destinationPath: path.join(linkIntoRepo, 'escaped-wt'),
                expectedCommonDirRealPath: ctx.commonDirRealPath,
                expectedCommonDirIdentity: ctx.commonDirIdentity,
                mode: 'NewBranch',
                branch: 'feat/escaped',
                startPoint: headSha,
              })
              .pipe(Effect.result);
            expect(escaped._tag).toBe('Failure');
          }

          // 5. Existing non-empty directory
          const nonEmpty = path.join(dir, 'existing-non-empty');
          yield* Effect.tryPromise(() => mkdir(nonEmpty, { recursive: true }));
          yield* Effect.tryPromise(() => writeFile(path.join(nonEmpty, 'keep.txt'), 'data'));
          const nonEmptyRes = yield* worker
            .createWorktree({
              folder: repo,
              destinationPath: nonEmpty,
              expectedCommonDirRealPath: ctx.commonDirRealPath,
              expectedCommonDirIdentity: ctx.commonDirIdentity,
              mode: 'NewBranch',
              branch: 'feat/nonempty',
              startPoint: headSha,
            })
            .pipe(Effect.result);
          expect(nonEmptyRes._tag).toBe('Failure');

          // 6. Mismatched expectedCommonDirRealPath
          const wrongRepo = yield* worker
            .createWorktree({
              folder: repo,
              destinationPath: path.join(dir, 'wt-mismatch'),
              expectedCommonDirRealPath: path.join(dir, 'other-repo', '.git'),
              expectedCommonDirIdentity: ctx.commonDirIdentity,
              mode: 'NewBranch',
              branch: 'feat/mismatch',
              startPoint: headSha,
            })
            .pipe(Effect.result);
          expect(wrongRepo._tag).toBe('Failure');
        }).pipe(
          Effect.provide(
            layerGitWorkerDirect.pipe(
              Layer.provideMerge(layerMergedPath),
              Layer.provideMerge(layerPathSources),
            ),
          ),
        ),
      ),
    TIMEOUT,
  );

  it.effect(
    'fails in-flight requests cleanly when worker exits unexpectedly mid-call',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const exitListeners = new Set<(code: number) => void>();
          const responseListeners = new Set<(response: WorkerResponse) => void>();

          const transport: WorkerClientTransport = {
            onResponse: (listener) => {
              responseListeners.add(listener);
              return () => void responseListeners.delete(listener);
            },
            onExit: (listener) => {
              exitListeners.add(listener);
              return () => void exitListeners.delete(listener);
            },
            postRequest: () => {
              // Simulate abrupt worker crash before any response arrives.
              queueMicrotask(() => {
                for (const listener of exitListeners) listener(137);
              });
            },
            shutdown: () => Effect.void,
          };

          const workerLayer = layerGitWorkerWithPort(transport).pipe(
            Layer.provideMerge(layerMergedPath),
            Layer.provideMerge(layerPathSources),
          );

          const res = yield* Effect.gen(function* () {
            const worker = yield* GitWorker;
            return yield* worker.ping();
          }).pipe(Effect.provide(workerLayer), Effect.result);

          expect(res._tag).toBe('Failure');
          if (res._tag === 'Failure') {
            expect(res.failure.reason).toBe('WorkerFailed');
          }
        }),
      ),
    TIMEOUT,
  );
});
