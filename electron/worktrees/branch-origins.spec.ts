import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { layerStore } from '../store/store';
import { BranchOrigins, layerBranchOrigins } from './branch-origins';

describe('BranchOrigins', () => {
  it.effect(
    'persists and retrieves createdFromBranch keyed by normalized worktree path and branch',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          mkdtemp(path.join(os.tmpdir(), 'spence-origins-')),
        );
        try {
          const layer = layerBranchOrigins.pipe(Layer.provide(layerStore(root)));
          const program = Effect.gen(function* () {
            const origins = yield* BranchOrigins;
            yield* origins.record({
              worktreePath: path.join(root, 'repo.worktrees', 'feat-a') + path.sep,
              branch: 'feat/a',
              createdFromBranch: 'develop',
            });
            return yield* origins.get({
              worktreePath: path.join(root, 'repo.worktrees', 'feat-a'),
              branch: 'feat/a',
            });
          }).pipe(Effect.provide(layer));

          const result = yield* program;
          expect(result).toBe('develop');

          // Re-read with a fresh layer from disk to verify Store persistence
          const freshLayer = layerBranchOrigins.pipe(Layer.provide(layerStore(root)));
          const persisted = yield* Effect.gen(function* () {
            const origins = yield* BranchOrigins;
            return yield* origins.get({
              worktreePath: path.join(root, 'repo.worktrees', 'feat-a'),
              branch: 'feat/a',
            });
          }).pipe(Effect.provide(freshLayer));
          expect(persisted).toBe('develop');
        } finally {
          yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
        }
      }),
  );

  it.effect('returns null when no origin was recorded for the worktree/branch pair', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(os.tmpdir(), 'spence-origins-')));
      try {
        const layer = layerBranchOrigins.pipe(Layer.provide(layerStore(root)));
        const result = yield* Effect.gen(function* () {
          const origins = yield* BranchOrigins;
          return yield* origins.get({
            worktreePath: path.join(root, 'repo.worktrees', 'missing'),
            branch: 'feat/missing',
          });
        }).pipe(Effect.provide(layer));
        expect(result).toBeNull();
      } finally {
        yield* Effect.promise(() => rm(root, { recursive: true, force: true }));
      }
    }),
  );
});
