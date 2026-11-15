import { describe, expect, it } from '@effect/vitest';
import { Duration, Effect } from 'effect';
import { TestClock } from 'effect/testing';
import { OperationId, ReviewId } from '../../src/shared/source-control/source-control.rpc';
import { ReviewRegistry, layerReviewRegistry } from './review-registry';

describe('ReviewRegistry', () => {
  it.effect(
    'issues expiring reviews, rejects drift, rejects expiry under TestClock, and prevents cross-operation reuse',
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_000_000);
        const registry = yield* ReviewRegistry;

        const issued = yield* registry.issue({
          kind: 'Worktree.create',
          fingerprint: 'fp-v1',
          payload: { repoId: 'repo-1', head: 'abc' },
          ttlMs: 60_000,
        });
        expect(issued.issuedAt).toBe(1_000_000);
        expect(issued.expiresAt).toBe(1_060_000);

        // Unknown ReviewId fails cleanly with StaleReview.
        const missing = yield* registry
          .verifyAndConsume({
            reviewId: ReviewId.make('missing-review'),
            kind: 'Worktree.create',
            operationId: OperationId.make('op-1'),
            checkFingerprint: () => Effect.void,
          })
          .pipe(Effect.result);
        expect(missing._tag).toBe('Failure');
        if (missing._tag === 'Failure') {
          expect(missing.failure.reason).toBe('StaleReview');
        }

        // Fingerprint drift fails without consuming the review.
        const drifted = yield* registry
          .verifyAndConsume({
            reviewId: issued.reviewId,
            kind: 'Worktree.create',
            operationId: OperationId.make('op-1'),
            checkFingerprint: (record) =>
              record.fingerprint === 'fp-v2'
                ? Effect.void
                : Effect.fail({ _tag: 'Drifted', detail: 'HEAD moved since review.' }),
          })
          .pipe(Effect.result);
        expect(drifted._tag).toBe('Failure');
        if (drifted._tag === 'Failure') {
          expect(drifted.failure.reason).toBe('StaleReview');
        }

        // Exact match consumes for op-1.
        const consumed = yield* registry.verifyAndConsume({
          reviewId: issued.reviewId,
          kind: 'Worktree.create',
          operationId: OperationId.make('op-1'),
          checkFingerprint: () => Effect.void,
        });
        expect(consumed.fingerprint).toBe('fp-v1');

        // Reusing same ReviewId with a DIFFERENT OperationId fails with StaleReview.
        const reused = yield* registry
          .verifyAndConsume({
            reviewId: issued.reviewId,
            kind: 'Worktree.create',
            operationId: OperationId.make('op-2'),
            checkFingerprint: () => Effect.void,
          })
          .pipe(Effect.result);
        expect(reused._tag).toBe('Failure');
        if (reused._tag === 'Failure') {
          expect(reused.failure.reason).toBe('StaleReview');
        }

        // Expiry under TestClock returns ReviewExpired.
        const second = yield* registry.issue({
          kind: 'Worktree.create',
          fingerprint: 'fp-v2',
          payload: { repoId: 'repo-1', head: 'def' },
          ttlMs: 10_000,
        });
        yield* TestClock.adjust(Duration.millis(11_000));
        const expired = yield* registry
          .verifyAndConsume({
            reviewId: second.reviewId,
            kind: 'Worktree.create',
            operationId: OperationId.make('op-3'),
            checkFingerprint: () => Effect.void,
          })
          .pipe(Effect.result);
        expect(expired._tag).toBe('Failure');
        if (expired._tag === 'Failure') {
          expect(expired.failure.reason).toBe('ReviewExpired');
        }
      }).pipe(Effect.provide(layerReviewRegistry)),
  );
});
