import { utilityProcess } from 'electron';
import { Context, Deferred, Duration, Effect, Layer, Option } from 'effect';
import path from 'node:path';
import { WorktreesError } from '../../src/shared/worktrees/worktrees.rpc';
import { MergedPath, PathSources } from '../agents/merged-path';
import { resolveExecutable } from '../agents/resolve';
import { handleWorkerRequest } from '../worker/git-worker-core';
import type { GitProbeResult, WorkerRequest, WorkerResponse } from '../worker/worker-protocol';

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

  const call = Effect.fnUntraced(function* (
    buildRequest: (id: number) => WorkerRequest,
  ): Effect.fn.Return<WorkerResponse['ok'] extends true ? never : unknown, WorktreesError> {
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

    const response = yield* Deferred.await(deferred).pipe(
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
    if (!response.ok) {
      return yield* new WorktreesError({
        reason: 'WorkerFailed',
        detail: response.detail,
      });
    }
    return response.result;
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      failPending('Source control worker shut down.');
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
      const pathEnv = yield* mergedPath.get;
      const resolved = yield* resolveExecutable('git', pathEnv, pathSources.platform);
      const gitExecutable = Option.isSome(resolved) ? resolved.value : null;
      return (yield* call((id) => ({
        id,
        method: 'git.probe',
        folder,
        gitExecutable,
        pathEnv,
      }))) as GitProbeResult;
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
