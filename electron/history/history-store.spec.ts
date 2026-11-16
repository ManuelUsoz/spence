import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ComparisonId } from '../../src/shared/history/comparison';
import { ObservationId } from '../../src/shared/history/history.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { WorktreeId } from '../../src/shared/worktrees/worktrees.rpc';
import { layerStore } from '../store/store';
import { HistoryStore, layerHistoryStore } from './history-store';

describe('HistoryStore', () => {
  it.effect('retains ordered worktree comparisons across service reconstruction', () =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-history-'))),
      (dir) =>
        Effect.gen(function* () {
          const sessionId = SessionId.make('session');
          const worktreeId = WorktreeId.make('worktree');
          const first = {
            id: ComparisonId.make('one'),
            sessionId,
            worktreeId,
            recordedAt: 1,
            before: { status: 'Missing' as const, detail: 'No baseline' },
            after: { status: 'Complete' as const, observationId: ObservationId.make('after') },
          };
          const second = {
            ...first,
            id: ComparisonId.make('two'),
            recordedAt: 2,
            after: { status: 'Incomplete' as const, detail: 'Capture timed out' },
          };
          const layer = layerHistoryStore.pipe(Layer.provide(layerStore(dir)));
          yield* Effect.gen(function* () {
            const history = yield* HistoryStore;
            yield* history.publish(first);
            yield* history.publish(second);
            const duplicate = yield* Effect.exit(history.publish(first));
            expect(duplicate._tag).toBe('Failure');
          }).pipe(Effect.provide(layer));
          const result = yield* HistoryStore.use((history) =>
            history.list(sessionId, worktreeId),
          ).pipe(Effect.provide(layer));
          expect(result).toEqual([first, second]);
          const other = yield* HistoryStore.use((history) =>
            history.list(sessionId, WorktreeId.make('other')),
          ).pipe(Effect.provide(layer));
          expect(other).toEqual([]);
        }),
      (dir) =>
        Effect.promise(() =>
          rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
        ),
    ),
  );
});
