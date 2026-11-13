import { Clock, Context, Effect, Layer, Schema, Semaphore, Stream } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import { layerAcpClientMain } from '../acp/acpMain';
import { AcpSessionId } from '../acp/acpSession';
import { AcpClient, type AcpSessionManager } from '../acp/acpSessionManager';
import { layerStoreUserData, Store, type VersionedFile } from '../store/store';

export const AGENT_DELETES_FILE = 'agent-deletes.json';
const MAX_ATTEMPTS = 3;

const QueuedDelete = Schema.Struct({
  agentId: AgentId,
  acpSessionId: AcpSessionId,
  queuedAt: Timestamp,
  attempts: Schema.Number,
});
type QueuedDelete = typeof QueuedDelete.Type;

const AgentDeletes = Schema.Struct({
  items: Schema.Array(QueuedDelete),
});
type AgentDeletes = typeof AgentDeletes.Type;

const AgentDeletesFile: VersionedFile<AgentDeletes> = {
  file: AGENT_DELETES_FILE,
  version: 1,
  migrations: [],
  schema: AgentDeletes,
  initial: () => ({ items: [] }),
};

export interface DeleteQueueShape {
  /**
   * Sends ACP `session/delete` for every `acpSessionId` at once if the Agent is running and advertises
   * `sessionCapabilities.delete`; otherwise queues them in `agent-deletes.json` to drain after its next `initialize`.
   */
  readonly deleteOrQueue: (
    agentId: AgentId,
    acpSessionIds: ReadonlyArray<AcpSessionId>,
  ) => Effect.Effect<void>;
}

/** Queues ACP `session/delete` calls when an Agent cannot take them now and drains them after its next `initialize`. */
export class DeleteQueue extends Context.Service<DeleteQueue, DeleteQueueShape>()(
  'sessions/DeleteQueue',
) {}

const keyOf = (agentId: AgentId, acpSessionId: AcpSessionId) => `${agentId}\0${acpSessionId}`;

export const layerDeleteQueue = Layer.effect(
  DeleteQueue,
  Effect.gen(function* () {
    const store = yield* Store;
    const acpClient = yield* AcpClient;
    const scope = yield* Effect.scope;
    const lock = (yield* Semaphore.make(1)).withPermit;

    const readQueue = store
      .readVersioned(AgentDeletesFile)
      .pipe(
        Effect.catchTag('StoreError', (error) =>
          Effect.logWarning(`Skipping ${AGENT_DELETES_FILE}: ${error.detail}`).pipe(
            Effect.as<AgentDeletes | undefined>(undefined),
          ),
        ),
      );

    const enqueue = (agentId: AgentId, acpSessionIds: ReadonlyArray<AcpSessionId>) =>
      acpSessionIds.length === 0
        ? Effect.void
        : lock(
            Effect.gen(function* () {
              const file = yield* readQueue;
              if (file === undefined) return;
              const seen = new Set(
                file.items.map((item) => keyOf(item.agentId, item.acpSessionId)),
              );
              const now = Timestamp.make(yield* Clock.currentTimeMillis);
              const added: Array<QueuedDelete> = [];
              for (const acpSessionId of acpSessionIds) {
                const key = keyOf(agentId, acpSessionId);
                if (seen.has(key)) continue;
                seen.add(key);
                added.push({ agentId, acpSessionId, queuedAt: now, attempts: 0 });
              }
              if (added.length === 0) return;
              yield* store.writeVersioned(AgentDeletesFile, {
                items: [...file.items, ...added],
              });
            }),
          );

    /** Returns `'done'` on success or Agent error (`Refused`, `Unsupported`, ...); `'retry'` on `Exited`. */
    const tryDelete = (manager: AcpSessionManager, acpSessionId: AcpSessionId) =>
      manager.deleteSession(acpSessionId).pipe(
        Effect.as<'done' | 'retry'>('done'),
        Effect.catchTag('AcpError', (error) =>
          Effect.succeed(error.reason === 'Exited' ? ('retry' as const) : ('done' as const)),
        ),
      );

    const drain = Effect.fnUntraced(function* (manager: AcpSessionManager) {
      const snapshot = yield* lock(readQueue);
      if (snapshot === undefined) return;
      const matching = snapshot.items.filter((item) => item.agentId === manager.agentId);
      if (matching.length === 0) return;

      const outcomes = new Map<string, 'done' | 'retry'>();
      for (const item of matching) {
        const outcome = yield* tryDelete(manager, item.acpSessionId);
        outcomes.set(keyOf(item.agentId, item.acpSessionId), outcome);
        if (outcome === 'retry') break;
      }

      yield* lock(
        Effect.gen(function* () {
          const current = yield* readQueue;
          if (current === undefined) return;
          const nextItems: Array<QueuedDelete> = [];
          for (const item of current.items) {
            const outcome = outcomes.get(keyOf(item.agentId, item.acpSessionId));
            if (outcome === undefined) {
              nextItems.push(item);
              continue;
            }
            if (outcome === 'done') continue;
            const attempts = item.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
              yield* Effect.logWarning(
                `Dropping ACP session/delete for ${item.acpSessionId} (${item.agentId}) after ${attempts} transport failures`,
              );
              continue;
            }
            nextItems.push({ ...item, attempts });
          }
          yield* store.writeVersioned(AgentDeletesFile, { items: nextItems });
        }),
      );
    });

    const deleteOrQueue = Effect.fn('DeleteQueue.deleteOrQueue')(function* (
      agentId: AgentId,
      acpSessionIds: ReadonlyArray<AcpSessionId>,
    ) {
      if (acpSessionIds.length === 0) return;
      const manager = yield* acpClient.connected(agentId);
      if (manager !== undefined && Boolean(manager.agentCapabilities.sessionCapabilities?.delete)) {
        const toQueue: Array<AcpSessionId> = [];
        for (const id of acpSessionIds) {
          if ((yield* tryDelete(manager, id)) === 'retry') toQueue.push(id);
        }
        yield* enqueue(agentId, toQueue);
        return;
      }
      yield* enqueue(agentId, acpSessionIds);
    });

    const initialized = yield* acpClient.subscribeInitialized;
    yield* Stream.runForEach(initialized, (manager) =>
      drain(manager).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`Could not drain ${AGENT_DELETES_FILE}: ${String(cause)}`),
        ),
      ),
    ).pipe(Effect.forkIn(scope));

    return DeleteQueue.of({ deleteOrQueue });
  }),
);

export const layerDeleteQueueLive = layerDeleteQueue.pipe(
  Layer.provide(Layer.mergeAll(layerStoreUserData, layerAcpClientMain)),
);
