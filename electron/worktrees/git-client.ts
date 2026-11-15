import { utilityProcess } from 'electron';
import { Context, Deferred, Duration, Effect, Layer, Option, Semaphore } from 'effect';
import path from 'node:path';
import { WorktreesError } from '../../src/shared/worktrees/worktrees.rpc';
import { MergedPath, PathSources } from '../agents/merged-path';
import { resolveExecutable } from '../agents/resolve';
import { handleWorkerRequest } from '../worker/git-worker-core';
import type {
  GitProbeResult,
  WorkerCommitDetailResult,
  WorkerCommitFileDiffResult,
  WorkerCommitsResult,
  WorkerDiffResult,
  WorkerDiffScope,
  WorkerGitStatusResult,
  WorkerRequest,
  WorkerResponse,
} from '../worker/worker-protocol';
import type { FilesDirectoryPage, FilesPreview } from '../../src/shared/files/files.rpc';
import { FilesError } from '../../src/shared/files/files.rpc';

export interface WorkerPortLike {
  readonly onMessage: (listener: (message: unknown) => void) => void;
  readonly postMessage: (message: unknown) => void;
  readonly offMessage?: (listener: (message: unknown) => void) => void;
}

export interface WorkerClientTransport {
  readonly onResponse: (listener: (response: WorkerResponse) => void) => () => void;
  readonly postRequest: (request: WorkerRequest) => void;
  readonly shutdown: () => Effect.Effect<void>;
}

export interface GitWorkerShape {
  readonly ping: () => Effect.Effect<{ readonly pid: number }, WorktreesError>;
  readonly probe: (folder: string) => Effect.Effect<GitProbeResult, WorktreesError>;
  readonly status: (folder: string) => Effect.Effect<WorkerGitStatusResult, WorktreesError>;
  readonly diff: (
    folder: string,
    path: string,
    scope: WorkerDiffScope,
  ) => Effect.Effect<WorkerDiffResult, WorktreesError>;
  readonly commits: (
    folder: string,
    limit: number,
    offset: number,
  ) => Effect.Effect<WorkerCommitsResult, WorktreesError>;
  readonly commitDetail: (
    folder: string,
    sha: string,
  ) => Effect.Effect<WorkerCommitDetailResult, WorktreesError>;
  readonly commitFileDiff: (
    folder: string,
    sha: string,
    path: string,
  ) => Effect.Effect<WorkerCommitFileDiffResult, WorktreesError>;
  readonly listDir: (params: {
    readonly rootPath: string;
    readonly expectedRootIdentity: string | null;
    readonly dirPath: string;
    readonly cursor?: string;
    readonly limit: number;
    readonly showIgnoredFiles: boolean;
  }) => Effect.Effect<FilesDirectoryPage, FilesError>;
  readonly readPreview: (params: {
    readonly rootPath: string;
    readonly expectedRootIdentity: string | null;
    readonly relativePath: string;
    readonly maxBytes: number;
  }) => Effect.Effect<FilesPreview, FilesError>;
  readonly validateOpenTarget: (params: {
    readonly rootPath: string;
    readonly expectedRootIdentity: string | null;
    readonly relativePath: string;
  }) => Effect.Effect<{ readonly targetPath: string }, FilesError>;
}

/** Effect boundary around the packaged Electron utility process executing Git commands. */
export class GitWorker extends Context.Service<GitWorker, GitWorkerShape>()(
  'worktrees/GitWorker',
) {}

const WORKER_TIMEOUT = Duration.seconds(20);

const makeGitWorker = Effect.fnUntraced(function* (
  transport: WorkerClientTransport,
  pathSources: { readonly platform: NodeJS.Platform },
  mergedPath: { readonly get: Effect.Effect<string> },
) {
  let nextId = 1;
  const requestSlots = yield* Semaphore.make(4);
  const pending = new Map<number, Deferred.Deferred<WorkerResponse, WorktreesError>>();
  let closed = false;

  const unsubscribe = transport.onResponse((response) => {
    const deferred = pending.get(response.id);
    if (deferred === undefined) return;
    pending.delete(response.id);
    Deferred.doneUnsafe(deferred, Effect.succeed(response));
  });

  const failPending = (detail: string): void => {
    closed = true;
    for (const [id, deferred] of pending) {
      pending.delete(id);
      Deferred.doneUnsafe(
        deferred,
        Effect.fail(new WorktreesError({ reason: 'WorkerFailed', detail })),
      );
    }
  };

  const sendRequestRaw = Effect.fnUntraced(function* (
    buildRequest: (id: number) => WorkerRequest,
  ): Effect.fn.Return<WorkerResponse, WorktreesError> {
    if (closed) {
      return yield* new WorktreesError({
        reason: 'WorkerFailed',
        detail: 'Source control worker has stopped.',
      });
    }
    const id = nextId++;
    const deferred = Deferred.makeUnsafe<WorkerResponse, WorktreesError>();
    pending.set(id, deferred);
    transport.postRequest(buildRequest(id));

    return yield* Deferred.await(deferred).pipe(
      Effect.timeoutOrElse({
        duration: WORKER_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new WorktreesError({
              reason: 'WorkerFailed',
              detail: 'Timed out waiting for source control worker response.',
            }),
          ),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );
  });

  const sendRequest = (buildRequest: (id: number) => WorkerRequest) =>
    sendRequestRaw(buildRequest).pipe(Semaphore.withPermits(requestSlots, 1));

  const call = Effect.fnUntraced(function* (
    buildRequest: (id: number) => WorkerRequest,
  ): Effect.fn.Return<WorkerResponse['ok'] extends true ? never : unknown, WorktreesError> {
    const response = yield* sendRequest(buildRequest);
    if (!response.ok) {
      return yield* new WorktreesError({
        reason: 'WorkerFailed',
        detail: response.detail,
      });
    }
    return response.result;
  });

  const mapWorkerFilesFailure = (
    response: Extract<WorkerResponse, { readonly ok: false }>,
  ): FilesError => {
    switch (response.reason) {
      case 'NotFound':
      case 'OutsideRoot':
      case 'UnsupportedFile':
      case 'IoFailed':
        return new FilesError({ reason: response.reason, detail: response.detail });
      case 'UnsupportedRequest':
      case 'ExecutionFailed':
        return new FilesError({ reason: 'WorkerFailed', detail: response.detail });
    }
  };

  const callFiles = Effect.fnUntraced(function* <A>(
    buildRequest: (id: number) => WorkerRequest,
  ): Effect.fn.Return<A, FilesError> {
    const response = yield* sendRequest(buildRequest).pipe(
      Effect.catchTag('WorktreesError', (error) =>
        Effect.fail(new FilesError({ reason: 'WorkerFailed', detail: error.detail })),
      ),
    );
    if (!response.ok) {
      return yield* mapWorkerFilesFailure(response);
    }
    return response.result as A;
  });

  const resolveGitBinary = Effect.fnUntraced(function* () {
    const pathEnv = yield* mergedPath.get;
    const resolved = yield* resolveExecutable('git', pathEnv, pathSources.platform);
    return {
      pathEnv,
      gitExecutable: Option.isSome(resolved) ? resolved.value : null,
    };
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      failPending('Source control worker shut down.');
      unsubscribe();
    }).pipe(Effect.andThen(transport.shutdown())),
  );

  const callWithGitEnv = Effect.fnUntraced(function* <TResult>(
    buildRequest: (id: number, gitExecutable: string | null, pathEnv: string) => WorkerRequest,
  ) {
    const pathEnv = yield* mergedPath.get;
    const resolved = yield* resolveExecutable('git', pathEnv, pathSources.platform);
    const gitExecutable = Option.isSome(resolved) ? resolved.value : null;
    return (yield* call((id) => buildRequest(id, gitExecutable, pathEnv))) as TResult;
  });

  return {
    ping: () =>
      call((id) => ({ id, method: 'ping' })) as Effect.Effect<
        { readonly pid: number },
        WorktreesError
      >,
    probe: Effect.fn('GitWorker.probe')(function* (folder: string) {
      return yield* callWithGitEnv<GitProbeResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.probe',
        folder,
        gitExecutable,
        pathEnv,
      }));
    }),
    status: Effect.fn('GitWorker.status')(function* (folder: string) {
      return yield* callWithGitEnv<WorkerGitStatusResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.status',
        folder,
        gitExecutable,
        pathEnv,
      }));
    }),
    diff: Effect.fn('GitWorker.diff')(function* (
      folder: string,
      filePath: string,
      scope: WorkerDiffScope,
    ) {
      return yield* callWithGitEnv<WorkerDiffResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.diff',
        folder,
        path: filePath,
        scope,
        gitExecutable,
        pathEnv,
      }));
    }),
    commits: Effect.fn('GitWorker.commits')(function* (
      folder: string,
      limit: number,
      offset: number,
    ) {
      return yield* callWithGitEnv<WorkerCommitsResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.commits',
        folder,
        limit,
        offset,
        gitExecutable,
        pathEnv,
      }));
    }),
    commitDetail: Effect.fn('GitWorker.commitDetail')(function* (folder: string, sha: string) {
      return yield* callWithGitEnv<WorkerCommitDetailResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.commitDetail',
        folder,
        sha,
        gitExecutable,
        pathEnv,
      }));
    }),
    commitFileDiff: Effect.fn('GitWorker.commitFileDiff')(function* (
      folder: string,
      sha: string,
      filePath: string,
    ) {
      return yield* callWithGitEnv<WorkerCommitFileDiffResult>((id, gitExecutable, pathEnv) => ({
        id,
        method: 'git.commitFileDiff',
        folder,
        sha,
        path: filePath,
        gitExecutable,
        pathEnv,
      }));
    }),
    listDir: Effect.fn('GitWorker.listDir')(function* (params: {
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly dirPath: string;
      readonly cursor?: string;
      readonly limit: number;
      readonly showIgnoredFiles: boolean;
    }) {
      const { pathEnv, gitExecutable } = yield* resolveGitBinary();
      return yield* callFiles<FilesDirectoryPage>((id) => ({
        id,
        method: 'files.listDir',
        rootPath: params.rootPath,
        expectedRootIdentity: params.expectedRootIdentity,
        dirPath: params.dirPath,
        ...(params.cursor === undefined ? {} : { cursor: params.cursor }),
        limit: params.limit,
        showIgnoredFiles: params.showIgnoredFiles,
        gitExecutable,
        pathEnv,
      }));
    }),
    readPreview: Effect.fn('GitWorker.readPreview')(function* (params: {
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly relativePath: string;
      readonly maxBytes: number;
    }) {
      return yield* callFiles<FilesPreview>((id) => ({
        id,
        method: 'files.readPreview',
        rootPath: params.rootPath,
        expectedRootIdentity: params.expectedRootIdentity,
        relativePath: params.relativePath,
        maxBytes: params.maxBytes,
      }));
    }),
    validateOpenTarget: Effect.fn('GitWorker.validateOpenTarget')(function* (params: {
      readonly rootPath: string;
      readonly expectedRootIdentity: string | null;
      readonly relativePath: string;
    }) {
      return yield* callFiles<{ readonly targetPath: string }>((id) => ({
        id,
        method: 'files.validateOpenTarget',
        rootPath: params.rootPath,
        expectedRootIdentity: params.expectedRootIdentity,
        relativePath: params.relativePath,
      }));
    }),
  } satisfies GitWorkerShape;
});

/** Builds a `GitWorker` layer backed by a provided `WorkerClientTransport` (tests / custom ports). */
export const layerGitWorkerWithPort = (
  transport: WorkerClientTransport,
): Layer.Layer<GitWorker, never, MergedPath | PathSources> =>
  Layer.effect(
    GitWorker,
    Effect.gen(function* () {
      const mergedPath = yield* MergedPath;
      const pathSources = yield* PathSources;
      return yield* makeGitWorker(transport, pathSources, mergedPath);
    }),
  );

/** In-process `GitWorker` layer executing the pure-Node handler directly (for Electron domain unit tests). */
export const layerGitWorkerDirect: Layer.Layer<GitWorker, never, MergedPath | PathSources> =
  Layer.effect(
    GitWorker,
    Effect.gen(function* () {
      const mergedPath = yield* MergedPath;
      const pathSources = yield* PathSources;
      const listeners = new Set<(response: WorkerResponse) => void>();
      const transport: WorkerClientTransport = {
        onResponse: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        postRequest: (request) => {
          void handleWorkerRequest(request).then((response) => {
            for (const listener of listeners) {
              listener(response);
            }
          });
        },
        shutdown: () => Effect.void,
      };
      return yield* makeGitWorker(transport, pathSources, mergedPath);
    }),
  );

/** App-lifetime Electron `utilityProcess.fork` worker layer, torn down cleanly when `MainRuntime` disposes. */
export const makeLayerGitWorkerUtility = (
  workerPath = path.join(__dirname, 'source-control-worker.js'),
): Layer.Layer<GitWorker, never, MergedPath | PathSources> =>
  Layer.effect(
    GitWorker,
    Effect.gen(function* () {
      const mergedPath = yield* MergedPath;
      const pathSources = yield* PathSources;
      const child = yield* Effect.acquireRelease(
        Effect.sync(() =>
          utilityProcess.fork(workerPath, [], {
            stdio: 'pipe',
            serviceName: 'Spence Source Control Worker',
          }),
        ),
        (proc) =>
          Effect.sync(() => {
            try {
              proc.postMessage({ id: 0, method: 'shutdown' } satisfies WorkerRequest);
            } catch {
              // Ignore if already exiting.
            }
            proc.kill();
          }),
      );

      const listeners = new Set<(response: WorkerResponse) => void>();
      const onMessage = (message: unknown): void => {
        const response = message as WorkerResponse;
        for (const listener of listeners) {
          listener(response);
        }
      };
      child.on('message', onMessage);
      yield* Effect.addFinalizer(() => Effect.sync(() => child.off('message', onMessage)));

      const transport: WorkerClientTransport = {
        onResponse: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        postRequest: (request) => child.postMessage(request),
        shutdown: () => Effect.void,
      };

      return yield* makeGitWorker(transport, pathSources, mergedPath);
    }),
  );
