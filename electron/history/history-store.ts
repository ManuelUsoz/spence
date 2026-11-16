import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import path from 'node:path';
import { HistoryComparison } from '../../src/shared/history/comparison';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { WorktreeId } from '../../src/shared/worktrees/worktrees.rpc';
import { readJsonDurable, writeJsonDurable } from '../store/durable';
import { Store, StoreError } from '../store/store';

const File = Schema.Struct({
  version: Schema.Literal(1),
  comparisons: Schema.Array(HistoryComparison),
});
export class HistoryStore extends Context.Service<
  HistoryStore,
  {
    readonly publish: (comparison: HistoryComparison) => Effect.Effect<void, StoreError>;
    readonly list: (
      sessionId: SessionId,
      worktreeId: WorktreeId,
    ) => Effect.Effect<ReadonlyArray<HistoryComparison>, StoreError>;
  }
>()('history/HistoryStore') {}

export const layerHistoryStore = Layer.effect(
  HistoryStore,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Semaphore.make(1);
    const file = path.join(store.root, 'history', 'comparisons.json');
    const read = readJsonDurable(file, File).pipe(Effect.map((value) => value?.comparisons ?? []));
    return HistoryStore.of({
      publish: (comparison) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const comparisons = yield* read;
            if (comparisons.some((item) => item.id === comparison.id)) {
              return yield* new StoreError({
                reason: 'Invalid',
                detail: 'Comparison already published',
              });
            }
            yield* writeJsonDurable(
              file,
              { version: 1, comparisons: [...comparisons, comparison] },
              File,
            );
          }),
        ),
      list: (sessionId, worktreeId) =>
        lock.withPermits(1)(
          read.pipe(
            Effect.map((items) =>
              items.filter(
                (item) => item.sessionId === sessionId && item.worktreeId === worktreeId,
              ),
            ),
          ),
        ),
    });
  }),
);
