import { Effect, Layer } from 'effect';
import { HistoryError, HistoryRpcs } from '../../src/shared/history/history.rpc';
import { HistoryStore, layerHistoryStore } from '../history/history-store';
import { layerStoreUserData } from '../store/store';

/** Handler layer for Wave 2 history RPCs. */
export const layerHistoryHandlers = HistoryRpcs.toLayer({
  'History.list': ({ sessionId, worktreeId }) =>
    HistoryStore.use((store) => store.list(sessionId, worktreeId)).pipe(
      Effect.mapError((error) => new HistoryError({
        reason: error.reason === 'Invalid' ? 'StoreError' : error.reason,
        detail: error.detail,
      })),
    ),
}).pipe(Layer.provide(layerHistoryStore.pipe(Layer.provide(layerStoreUserData))));
