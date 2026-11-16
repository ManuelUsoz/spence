import {
  client,
  type ClientApp,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type SessionUpdate,
} from '@agentclientprotocol/sdk/unstable';
import { type Cause, Deferred, Effect, type Exit, FiberSet, Queue } from 'effect';
import type { AcpError } from './acpErrors';
import { AcpSessionId } from './acpSession';

/** A Permission request waiting for the caller: completing `answer` replies to the Agent. */
export interface PendingPermission {
  readonly request: RequestPermissionRequest;
  readonly answer: Deferred.Deferred<RequestPermissionOutcome>;
}

/** What an ACP session tells its caller, in arrival order. Raw ACP types: this never leaves `electron/acp`. */
export type AcpSessionEvent =
  | { readonly _tag: 'Update'; readonly update: SessionUpdate }
  | ({ readonly _tag: 'PermissionRequest' } & PendingPermission)
  /**
   * How a `session/prompt` ended, posted by the session once the Agent answered (or the prompt failed). It comes
   * after every update the Agent sent for that prompt, so a consumer can end the Turn in order.
   */
  | { readonly _tag: 'PromptEnded'; readonly result: Exit.Exit<PromptResponse, AcpError> }
  /**
   * How a standalone `session/compact` ended, posted after every compaction/usage update the Agent emitted for it.
   */
  | { readonly _tag: 'CompactionEnded'; readonly result: Exit.Exit<void, AcpError> };

export type AcpSessionQueue = Queue.Queue<AcpSessionEvent, AcpError | Cause.Done>;

/** Our side of the connection: routes `session/update` and Permission requests to their ACP session. */
export interface ClientDispatcher {
  readonly app: ClientApp;
  /**
   * Starts routing a session's events into a fresh queue. Events that arrived before (an Agent may send updates
   * before `session/new` returns) are delivered first.
   */
  readonly attach: (sessionId: AcpSessionId) => Effect.Effect<AcpSessionQueue>;
  /**
   * Stops routing and ends the session's event stream. Events buffered for it are dropped, and what the Agent still
   * sends for it is ignored until it is attached again.
   */
  readonly detach: (sessionId: AcpSessionId) => Effect.Effect<void>;
  /** Answers every Permission request still pending in the session `cancelled`. */
  readonly cancelPermissions: (sessionId: AcpSessionId) => Effect.Effect<void>;
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
  const queues = new Map<AcpSessionId, AcpSessionQueue>();
  /** Events for sessions not attached yet. */
  const early = new Map<AcpSessionId, Array<AcpSessionEvent>>();
  /** Sessions detached and not attached again: what the Agent still sends for them is dropped. */
  const detached = new Set<AcpSessionId>();
  const pending = new Map<AcpSessionId, Set<PendingPermission>>();

  const route = (sessionId: AcpSessionId, event: AcpSessionEvent): void => {
    if (detached.has(sessionId)) return;
    const queue = queues.get(sessionId);
    if (queue !== undefined) {
      Queue.offerUnsafe(queue, event);
      return;
    }
    early.set(sessionId, [...(early.get(sessionId) ?? []), event]);
  };

  const app = client({ name: 'spence' })
    .onNotification('session/update', ({ params }) => {
      route(AcpSessionId.make(params.sessionId), { _tag: 'Update', update: params.update });
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
    });

  const attach = Effect.fnUntraced(function* (sessionId: AcpSessionId) {
    const queue = yield* Queue.unbounded<AcpSessionEvent, AcpError | Cause.Done>();
    yield* Queue.offerAll(queue, early.get(sessionId) ?? []);
    early.delete(sessionId);
    detached.delete(sessionId);
    queues.set(sessionId, queue);
    return queue;
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

  const detach = Effect.fnUntraced(function* (sessionId: AcpSessionId) {
    yield* cancelPermissions(sessionId);
    const queue = queues.get(sessionId);
    queues.delete(sessionId);
    pending.delete(sessionId);
    early.delete(sessionId);
    detached.add(sessionId);
    if (queue !== undefined) yield* Queue.end(queue);
  });

  const failAll = (error: AcpError) =>
    Effect.suspend(() =>
      Effect.forEach([...queues.values()], (queue) => Queue.fail(queue, error), { discard: true }),
    );

  return { app, attach, detach, cancelPermissions, failAll } satisfies ClientDispatcher;
});
