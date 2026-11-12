import {
  client,
  type ClientApp,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { type Cause, Deferred, Effect, FiberSet, Queue } from 'effect';
import type { AcpError } from './acpErrors';

/** A Permission request waiting for the caller: completing `answer` replies to the Agent. */
export interface PendingPermission {
  readonly request: RequestPermissionRequest;
  readonly answer: Deferred.Deferred<RequestPermissionOutcome>;
}

/** What an ACP session tells its caller, in arrival order. Raw ACP types: this never leaves `electron/acp`. */
export type AcpSessionEvent =
  | { readonly _tag: 'Update'; readonly update: SessionUpdate }
  | ({ readonly _tag: 'PermissionRequest' } & PendingPermission);

export type AcpSessionQueue = Queue.Queue<AcpSessionEvent, AcpError | Cause.Done>;

/** Our side of the connection: routes `session/update` and Permission requests to their ACP session. */
export interface ClientDispatcher {
  readonly app: ClientApp;
  /**
   * Starts routing a session's events into a fresh queue. Events that arrived before (an Agent may send updates
   * before `session/new` returns) are delivered first.
   */
  readonly attach: (sessionId: string) => Effect.Effect<AcpSessionQueue>;
  /** Stops routing and ends the session's event stream. */
  readonly detach: (sessionId: string) => Effect.Effect<void>;
  /** Answers every Permission request still pending in the session `cancelled`. */
  readonly cancelPermissions: (sessionId: string) => Effect.Effect<void>;
  /** Fails every attached session's event stream, e.g. when the Agent exits. */
  readonly failAll: (error: AcpError) => Effect.Effect<void>;
}

const CANCELLED: RequestPermissionOutcome = { outcome: 'cancelled' };

/**
 * Builds our `acp.Client`. Spence offers no file system or terminal, so only `session/update` and
 * `session/request_permission` are handled. Permission requests wait on a `Deferred` for as long as the scope lives.
 */
export const makeClientDispatcher = Effect.fnUntraced(function* () {
  const runPromise = yield* FiberSet.makeRuntimePromise();
  const queues = new Map<string, AcpSessionQueue>();
  /** Events for sessions not attached yet. */
  const early = new Map<string, Array<AcpSessionEvent>>();
  const pending = new Map<string, Set<PendingPermission>>();

  const route = (sessionId: string, event: AcpSessionEvent): void => {
    const queue = queues.get(sessionId);
    if (queue !== undefined) {
      Queue.offerUnsafe(queue, event);
      return;
    }
    early.set(sessionId, [...(early.get(sessionId) ?? []), event]);
  };

  const app = client({ name: 'spence' })
    .onNotification('session/update', ({ params }) => {
      route(params.sessionId, { _tag: 'Update', update: params.update });
    })
    .onRequest('session/request_permission', async ({ params }) => {
      const permission: PendingPermission = {
        request: params,
        answer: Deferred.makeUnsafe<RequestPermissionOutcome>(),
      };
      const waiting = pending.get(params.sessionId) ?? new Set();
      pending.set(params.sessionId, waiting.add(permission));
      route(params.sessionId, { _tag: 'PermissionRequest', ...permission });
      try {
        return { outcome: await runPromise(Deferred.await(permission.answer)) };
      } finally {
        waiting.delete(permission);
      }
    });

  const attach = Effect.fnUntraced(function* (sessionId: string) {
    const queue = yield* Queue.unbounded<AcpSessionEvent, AcpError | Cause.Done>();
    yield* Queue.offerAll(queue, early.get(sessionId) ?? []);
    early.delete(sessionId);
    queues.set(sessionId, queue);
    return queue;
  });

  const cancelPermissions = (sessionId: string) =>
    // Suspended: the pending set is read when the effect runs, not when it is built.
    Effect.suspend(() =>
      Effect.forEach(
        [...(pending.get(sessionId) ?? [])],
        ({ answer }) => Deferred.succeed(answer, CANCELLED),
        { discard: true },
      ),
    );

  const detach = Effect.fnUntraced(function* (sessionId: string) {
    yield* cancelPermissions(sessionId);
    const queue = queues.get(sessionId);
    queues.delete(sessionId);
    pending.delete(sessionId);
    if (queue !== undefined) yield* Queue.end(queue);
  });

  const failAll = (error: AcpError) =>
    Effect.suspend(() =>
      Effect.forEach([...queues.values()], (queue) => Queue.fail(queue, error), { discard: true }),
    );

  return { app, attach, detach, cancelPermissions, failAll } satisfies ClientDispatcher;
});
