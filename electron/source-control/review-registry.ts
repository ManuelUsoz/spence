import { Clock, Context, Effect, Layer } from 'effect';
import { randomUUID } from 'node:crypto';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  type OperationId,
  ReviewId,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';

const DEFAULT_REVIEW_TTL_MS = 10 * 60 * 1000;
const CONSUMED_RETENTION_GRACE_MS = 5 * 60 * 1000;

export interface StoredReviewRecord {
  readonly reviewId: ReviewId;
  readonly kind: string;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly fingerprint: string;
  readonly payload: unknown;
  consumedByOperationId?: OperationId;
}

export interface ReviewFingerprintDrift {
  readonly _tag: 'Drifted';
  readonly reason?: SourceControlError['reason'];
  readonly detail: string;
}

export interface VerifyReviewOptions {
  readonly reviewId: ReviewId;
  readonly kind: string;
  readonly operationId: OperationId;
  readonly checkFingerprint: (
    record: StoredReviewRecord,
  ) => Effect.Effect<void, ReviewFingerprintDrift | SourceControlError>;
}

export interface ReviewRegistryShape {
  readonly issue: (input: {
    readonly kind: string;
    readonly fingerprint: string;
    readonly payload: unknown;
    readonly ttlMs?: number;
  }) => Effect.Effect<{
    readonly reviewId: ReviewId;
    readonly issuedAt: Timestamp;
    readonly expiresAt: Timestamp;
  }>;
  readonly get: (reviewId: ReviewId) => Effect.Effect<StoredReviewRecord | undefined>;
  readonly verifyAndConsume: (
    options: VerifyReviewOptions,
  ) => Effect.Effect<StoredReviewRecord, SourceControlError>;
}

/** App-lifetime expiring registry holding Source Control review snapshots and fingerprints. */
export class ReviewRegistry extends Context.Service<ReviewRegistry, ReviewRegistryShape>()(
  'source-control/ReviewRegistry',
) {}

/** Creates a live `ReviewRegistry` backed by `Clock` so expiry responds deterministically to `TestClock`. */
export const layerReviewRegistry: Layer.Layer<ReviewRegistry> = Layer.sync(ReviewRegistry, () => {
  const entries = new Map<ReviewId, StoredReviewRecord>();

  const sweepExpired = (now: number): void => {
    for (const [id, record] of entries) {
      if (now > record.expiresAt + CONSUMED_RETENTION_GRACE_MS) {
        entries.delete(id);
      }
    }
  };

  return {
    issue: Effect.fn('ReviewRegistry.issue')(function* (input) {
      const now = yield* Clock.currentTimeMillis;
      sweepExpired(now);
      const ttl = input.ttlMs ?? DEFAULT_REVIEW_TTL_MS;
      const reviewId = ReviewId.make(`rev-${randomUUID()}`);
      const issuedAt = Timestamp.make(now);
      const expiresAt = Timestamp.make(now + ttl);
      entries.set(reviewId, {
        reviewId,
        kind: input.kind,
        issuedAt,
        expiresAt,
        fingerprint: input.fingerprint,
        payload: input.payload,
      });
      return { reviewId, issuedAt, expiresAt };
    }),

    get: (reviewId) => Effect.sync(() => entries.get(reviewId)),

    verifyAndConsume: Effect.fn('ReviewRegistry.verifyAndConsume')(function* (options) {
      const now = yield* Clock.currentTimeMillis;
      const record = entries.get(options.reviewId);
      if (record === undefined) {
        return yield* new SourceControlError({
          reason: 'StaleReview',
          detail: 'Review snapshot is no longer active. Refresh the review before continuing.',
        });
      }
      if (record.kind !== options.kind) {
        return yield* new SourceControlError({
          reason: 'Conflict',
          detail: `Review "${options.reviewId}" belongs to "${record.kind}", not "${options.kind}".`,
        });
      }
      if (
        record.consumedByOperationId !== undefined &&
        record.consumedByOperationId !== options.operationId
      ) {
        return yield* new SourceControlError({
          reason: 'StaleReview',
          detail:
            'This review was already consumed by a different operation. Re-review before retrying.',
        });
      }
      if (now > record.expiresAt) {
        return yield* new SourceControlError({
          reason: 'ReviewExpired',
          detail: 'Review expired before execution. Refresh the review and try again.',
        });
      }

      yield* options.checkFingerprint(record).pipe(
        Effect.catch((drift) =>
          drift instanceof SourceControlError
            ? Effect.fail(drift)
            : Effect.fail(
                new SourceControlError({
                  reason: drift.reason ?? 'StaleReview',
                  detail: drift.detail,
                }),
              ),
        ),
      );

      record.consumedByOperationId = options.operationId;
      return record;
    }),
  } satisfies ReviewRegistryShape;
});
