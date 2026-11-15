import { utilityProcess, type UtilityProcess } from 'electron';
import { Context, Deferred, Duration, Effect, Layer, Option, Semaphore } from 'effect';
import path from 'node:path';
import { WorktreesError } from '../../src/shared/worktrees/worktrees.rpc';
import { MergedPath, PathSources } from '../agents/merged-path';
import { resolveExecutable } from '../agents/resolve';
import { handleWorkerRequest } from '../worker/git-worker-core';
import type {
  GitCreateContextResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitPostWorktreeCreateInspection,
  GitProbeResult,
  WorkerRequest,
  WorkerResponse,
  WorkerResponseErrorReason,
  WorkerFilesErrorReason,
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
  readonly onExit?: (listener: (code: number) => void) => () => void;
  readonly postRequest: (request: WorkerRequest) => void;
  readonly shutdown: () => Effect.Effect<void>;
}

export interface GitWorkerShape {
  readonly ping: () => Effect.Effect<{ readonly pid: number }, WorktreesError>;
  readonly probe: (folder: string) => Effect.Effect<GitProbeResult, WorktreesError>;
  readonly inspectCreateContext: (
    folder: string,
    options?: { readonly destinationPath?: string; readonly branch?: string },
  ) => Effect.Effect<GitCreateContextResult, WorktreesError>;
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, WorktreesError>;
  readonly inspectPostWorktreeCreate: (
    folder: string,
    destinationPath: string,
    branch: string,
  ) => Effect.Effect<GitPostWorktreeCreateInspection, WorktreesError>;
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

const mapWorkerErrorReason = (
  reason: WorkerResponseErrorReason | WorkerFilesErrorReason,
): WorktreesError['reason'] => {
  switch (reason) {
    case 'InvalidInput':
      return 'InvalidInput';
    case 'UntrustedPath':
      return 'UntrustedPath';
    case 'Conflict':
      return 'Conflict';
    case 'MissingGit':
      return 'MissingGit';
    case 'UnsupportedRequest':
    case 'ExecutionFailed':
    case 'NotFound':
    case 'OutsideRoot':
    case 'UnsupportedFile':
    case 'IoFailed':
      return 'WorkerFailed';
  }
};

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

  const failPending = (detail: string, keepClosed: boolean): void => {
    if (keepClosed) {
      closed = true;
    }
    for (const [id, deferred] of pending) {
      pending.delete(id);
      Deferred.doneUnsafe(
        deferred,
        Effect.fail(new WorktreesError({ reason: 'WorkerFailed', detail })),
      );
    }
  };

  const unsubscribeExit =
    transport.onExit?.((code) => {
      failPending(`Source control worker exited unexpectedly (code ${code}).`, false);
    }) ?? (() => {});

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
    try {
      transport.postRequest(buildRequest(id));
    } catch (error) {
      pending.delete(id);
      return yield* new WorktreesError({
        reason: 'WorkerFailed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

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
        reason: mapWorkerErrorReason(response.reason),
        detail: response.detail,
      });
    }
    return response.result;
  });

  const resolveGit = Effect.fnUntraced(function* () {
    const pathEnv = yield* mergedPath.get;
    const resolved = yield* resolveExecutable('git', pathEnv, pathSources.platform);
    const gitExecutable = Option.isSome(resolved) ? resolved.value : null;
    return { gitExecutable, pathEnv };
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
      case 'InvalidInput':
      case 'UntrustedPath':
      case 'Conflict':
      case 'MissingGit':
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
      failPending('Source control worker shut down.', true);
      unsubscribeExit();
      unsubscribe();
    }).pipe(Effect.andThen(transport.shutdown())),
  );

  return {
    ping: () =>
      call((id) => ({ id, method: 'ping' })) as Effect.Effect<
        { readonly pid: number },
        WorktreesError
      >,
    probe: Effect.fn('GitWorker.probe')(function* (folder: string) {
      const { gitExecutable, pathEnv } = yield* resolveGit();
      return (yield* call((id) => ({
        id,
        method: 'git.probe',
        folder,
        gitExecutable,
        pathEnv,
      }))) as GitProbeResult;
    }),
    inspectCreateContext: Effect.fn('GitWorker.inspectCreateContext')(function* (
      folder: string,
      options?: { readonly destinationPath?: string; readonly branch?: string },
    ) {
      const { gitExecutable, pathEnv } = yield* resolveGit();
      return (yield* call((id) => ({
        id,
        method: 'git.inspectCreateContext',
        folder,
        ...(options?.destinationPath === undefined
          ? {}
          : { destinationPath: options.destinationPath }),
        ...(options?.branch === undefined ? {} : { branch: options.branch }),
        gitExecutable,
        pathEnv,
      }))) as GitCreateContextResult;
    }),
    createWorktree: Effect.fn('GitWorker.createWorktree')(function* (
      input: GitCreateWorktreeInput,
    ) {
      const { gitExecutable, pathEnv } = yield* resolveGit();
      return (yield* call((id) => ({
        id,
        method: 'git.createWorktree',
        ...input,
        gitExecutable,
        pathEnv,
      }))) as GitCreateWorktreeResult;
    }),
    inspectPostWorktreeCreate: Effect.fn('GitWorker.inspectPostWorktreeCreate')(function* (
      folder: string,
      destinationPath: string,
      branch: string,
    ) {
      const { gitExecutable, pathEnv } = yield* resolveGit();
      return (yield* call((id) => ({
        id,
        method: 'git.inspectPostWorktreeCreate',
        folder,
        destinationPath,
        branch,
        gitExecutable,
        pathEnv,
      }))) as GitPostWorktreeCreateInspection;
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
      const listeners = new Set<(response: WorkerResponse) => void>();
      const exitListeners = new Set<(code: number) => void>();
      let disposed = false;
      let currentChild: UtilityProcess | null = null;
      let detachCurrent = () => {};

      const attachChild = (proc: UtilityProcess): void => {
        const onMessage = (message: unknown): void => {
          const response = message as WorkerResponse;
          for (const listener of listeners) {
            listener(response);
          }
        };
        const onExit = (code: number): void => {
          if (currentChild === proc) {
            currentChild = null;
            detachCurrent();
          }
          for (const listener of exitListeners) {
            listener(code);
          }
        };
        proc.on('message', onMessage);
        proc.on('exit', onExit);
        detachCurrent = () => {
          proc.off('message', onMessage);
          proc.off('exit', onExit);
        };
      };

      const ensureChild = (): UtilityProcess | null => {
        if (disposed) return null;
        if (currentChild !== null) return currentChild;
        const proc = utilityProcess.fork(workerPath, [], {
          stdio: 'pipe',
          serviceName: 'Spence Source Control Worker',
        });
        currentChild = proc;
        attachChild(proc);
        return proc;
      };

      // Eagerly fork on startup just like before so startup latency stays upfront.
      ensureChild();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          disposed = true;
          const proc = currentChild;
          currentChild = null;
          detachCurrent();
          if (proc !== null) {
            try {
              proc.postMessage({ id: 0, method: 'shutdown' } satisfies WorkerRequest);
            } catch {
              // Ignore if already exiting.
            }
            proc.kill();
          }
        }),
      );

      const transport: WorkerClientTransport = {
        onResponse: (listener) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        onExit: (listener) => {
          exitListeners.add(listener);
          return () => void exitListeners.delete(listener);
        },
        postRequest: (request) => {
          const proc = ensureChild();
          if (proc !== null) {
            proc.postMessage(request);
          }
        },
        shutdown: () => Effect.void,
      };

      return yield* makeGitWorker(transport, pathSources, mergedPath);
    }),
  );
