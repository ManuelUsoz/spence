import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MergedPath, PathSources, layerMergedPath, layerPathSources } from '../agents/merged-path';
import {
  GitWorker,
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
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

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
});
