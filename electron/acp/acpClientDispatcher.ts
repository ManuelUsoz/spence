import {
  client,
  type ClientApp,
  type PromptResponse,
  type RequestError,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import { type Cause, Deferred, Effect, type Exit, FiberSet, Queue, Result } from 'effect';
import { AcpError } from './acpErrors';
import { AcpSessionId } from './acpSession';
import {
  makeTerminalRegistry,
  type TerminalHostEnv,
  type TerminalStreamEvent,
} from './acpTerminals';

/** A Permission request waiting for the caller: completing `answer` replies to the Agent. */
export interface PendingPermission {
  readonly request: RequestPermissionRequest;
  readonly answer: Deferred.Deferred<RequestPermissionOutcome>;
}

/** What an ACP session tells its caller, in arrival order. Raw ACP types: this never leaves `electron/acp`. */
export type AcpSessionEvent =
  | { readonly _tag: 'Update'; readonly update: SessionUpdate }
  | ({ readonly _tag: 'PermissionRequest' } & PendingPermission)
  | TerminalStreamEvent
  /**
   * How a `session/prompt` ended, posted by the session once the Agent answered (or the prompt failed). It comes
   * after every update the Agent sent for that prompt, so a consumer can end the Turn in order.
   */
  | { readonly _tag: 'PromptEnded'; readonly result: Exit.Exit<PromptResponse, AcpError> }
  /**
   * How a standalone `session/compact` ended, posted after every compaction/usage update the Agent emitted for it.
   */
  | { readonly _tag: 'CompactionEnded'; readonly result: Exit.Exit<void, AcpError> }
  | {
      readonly _tag: 'WorkerState';
      readonly state: string | null;
      readonly stopReason: string | null;
    };

export type AcpSessionQueue = Queue.Queue<AcpSessionEvent, AcpError | Cause.Done>;

/** Our side of the connection: routes `session/update`, Permission requests, and client terminals to their ACP session. */
export interface ClientDispatcher {
  readonly app: ClientApp;
  /**
   * Starts routing a session's events into a fresh queue. Events that arrived before (an Agent may send updates
   * before `session/new` returns) are delivered first.
   */
  readonly attach: (sessionId: AcpSessionId, cwd?: string) => Effect.Effect<AcpSessionQueue>;
  readonly attachWorker: (
    parentId: AcpSessionId,
    childId: AcpSessionId,
  ) => Effect.Effect<AcpSessionQueue, AcpError>;
  /**
   * Stops routing and ends the session's event stream. Events buffered for it are dropped, unreleased terminal
   * process trees are killed and released, and what the Agent still sends for it is ignored until attached again.
   */
  readonly detach: (sessionId: AcpSessionId) => Effect.Effect<void>;
  /** Answers every Permission request still pending in the session `cancelled`. */
  readonly cancelPermissions: (sessionId: AcpSessionId) => Effect.Effect<void>;
  /** Flushes any throttled terminal output deltas for the session immediately. */
  readonly flushTerminals: (sessionId: AcpSessionId) => Effect.Effect<void>;
  /** Terminates and releases any unreleased terminal process trees owned by the session. */
  readonly cancelTerminals: (sessionId: AcpSessionId) => Effect.Effect<void>;
  /** Fails every attached session's event stream and releases all remaining terminals, e.g. when the Agent exits. */
  readonly failAll: (error: AcpError) => Effect.Effect<void>;
}

const CANCELLED: RequestPermissionOutcome = { outcome: 'cancelled' };

/**
 * Builds our `acp.Client`. Spence offers `terminal/*` handlers (keeping `fs` disabled), `session/update`, and
 * `session/request_permission`. Permission requests wait on a `Deferred`, and terminals live within the Scope.
 */
export const makeClientDispatcher = Effect.fnUntraced(function* (host?: TerminalHostEnv) {
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const queues = new Map<AcpSessionId, AcpSessionQueue>();
  /** Events for sessions not attached yet. */
  const early = new Map<AcpSessionId, Array<AcpSessionEvent>>();
  /** Sessions detached and not attached again: what the Agent still sends for them is dropped. */
  const detached = new Set<AcpSessionId>();
  const pending = new Map<AcpSessionId, Set<PendingPermission>>();
  const parents = new Map<AcpSessionId, AcpSessionId>();
  const roots = new Map<AcpSessionId, string>();

  const route = (sessionId: AcpSessionId, event: AcpSessionEvent): void => {
    if (detached.has(sessionId)) return;
    const queue = queues.get(sessionId);
    if (queue !== undefined) {
      Queue.offerUnsafe(queue, event);
      return;
    }
    early.set(sessionId, [...(early.get(sessionId) ?? []), event]);
  };

  const terminals = makeTerminalRegistry(
    (sessionId) => roots.get(sessionId),
    (sessionId) => detached.has(sessionId),
    route,
    host,
  );
  yield* Effect.addFinalizer(() => terminals.releaseAll);

  const runRequest = <A>(effect: Effect.Effect<A, RequestError>): Promise<A> =>
    runPromise(Effect.result(effect)).then((result) =>
      Result.isSuccess(result) ? result.success : Promise.reject(result.failure),
    );

  const app = client({ name: 'spence' })
    .onNotification('session/update', ({ params }) => {
      const sessionId = AcpSessionId.make(params.sessionId);
      if (params.update.sessionUpdate === 'subagent_update') {
        const child = AcpSessionId.make(params.update.sessionId);
        if (!parents.has(child)) parents.set(child, sessionId);
        if (!roots.has(child)) {
          const childRoot = params.update.cwd ?? roots.get(sessionId);
          if (childRoot !== undefined) roots.set(child, childRoot);
        }
      }
      route(sessionId, { _tag: 'Update', update: params.update });
      if (params.update.sessionUpdate === 'subagent_update' && params.update.state !== undefined) {
        route(AcpSessionId.make(params.update.sessionId), {
          _tag: 'WorkerState',
          state: params.update.state?.state ?? null,
          stopReason:
            params.update.state?.state === 'idle' &&
            typeof params.update.state.stopReason === 'string'
              ? params.update.state.stopReason
              : null,
        });
      }
    })
    .onRequest('session/request_permission', async ({ params }) => {
      const sessionId = AcpSessionId.make(params.sessionId);
      // Nobody listens to a detached session, so nobody would answer.
      if (detached.has(sessionId)) return { outcome: CANCELLED };
      const permission: PendingPermission = {
        request: params,
        answer: Deferred.makeUnsafe<RequestPermissionOutcome>(),
      };
      const waiting = pending.get(sessionId) ?? new Set();
      pending.set(sessionId, waiting.add(permission));
      route(sessionId, { _tag: 'PermissionRequest', ...permission });
      try {
        return { outcome: await runPromise(Deferred.await(permission.answer)) };
      } finally {
        waiting.delete(permission);
      }
    })
    .onRequest('terminal/create', ({ params }) => runRequest(terminals.create(params)))
    .onRequest('terminal/output', ({ params }) => runRequest(terminals.output(params)))
    .onRequest('terminal/wait_for_exit', ({ params }) => runRequest(terminals.waitForExit(params)))
    .onRequest('terminal/kill', ({ params }) => runRequest(terminals.kill(params)))
    .onRequest('terminal/release', ({ params }) => runRequest(terminals.release(params)));

  const attach = Effect.fnUntraced(function* (sessionId: AcpSessionId, cwd?: string) {
    if (cwd !== undefined) roots.set(sessionId, cwd);
    const queue = yield* Queue.unbounded<AcpSessionEvent, AcpError | Cause.Done>();
    yield* Queue.offerAll(queue, early.get(sessionId) ?? []);
    early.delete(sessionId);
    detached.delete(sessionId);
    queues.set(sessionId, queue);
    return queue;
  });

  const attachWorker = (parentId: AcpSessionId, childId: AcpSessionId) =>
    Effect.suspend(() => {
      if (parents.get(childId) !== parentId) {
        return Effect.fail(
          new AcpError({
            reason: 'Unsupported',
            detail: 'Worker was not announced by this Session',
          }),
        );
      }
      const existing = queues.get(childId);
      const childRoot = roots.get(childId) ?? roots.get(parentId);
      return existing === undefined
        ? attach(childId, childRoot)
        : Effect.fail(new AcpError({ reason: 'Refused', detail: 'Worker is already attached' }));
    });

  const cancelPermissions = (sessionId: AcpSessionId) =>
    // Suspended: the pending set is read when the effect runs, not when it is built.
    Effect.suspend(() =>
      Effect.forEach(
        [...(pending.get(sessionId) ?? [])],
        ({ answer }) => Deferred.succeed(answer, CANCELLED),
        { discard: true },
      ),
    );

  const flushTerminals = (sessionId: AcpSessionId) => terminals.flushSession(sessionId);
  const cancelTerminals = (sessionId: AcpSessionId) => terminals.releaseSession(sessionId);

  const detach = Effect.fnUntraced(function* (sessionId: AcpSessionId) {
    yield* cancelPermissions(sessionId);
    yield* cancelTerminals(sessionId);
    const queue = queues.get(sessionId);
    queues.delete(sessionId);
    pending.delete(sessionId);
    early.delete(sessionId);
    roots.delete(sessionId);
    detached.add(sessionId);
    if (queue !== undefined) yield* Queue.end(queue);
  });

  const failAll = (error: AcpError) =>
    Effect.suspend(() =>
      terminals.releaseAll.pipe(
        Effect.andThen(
          Effect.forEach([...queues.values()], (queue) => Queue.fail(queue, error), {
            discard: true,
          }),
        ),
      ),
    );

  return {
    app,
    attach,
    attachWorker,
    detach,
    cancelPermissions,
    flushTerminals,
    cancelTerminals,
    failAll,
  } satisfies ClientDispatcher;
});
