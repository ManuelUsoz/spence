import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import { CommitError, CommitExecuteInput, CommitSelection } from './commit-schema';
import { OperationId, OperationRecoveryState, ReviewId } from './operation-schema';

describe('commit contract', () => {
  it.effect('round trips commit recovery without worktree creation facts', () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const codec = serialization.codecFor(OperationRecoveryState);
      const recovery = {
        summary: 'Interrupted',
        detail: 'Inspect HEAD',
        observedHeadCommit: 'abc',
        canReconcile: true,
        canDismiss: false,
      };
      const encoded = yield* Schema.encodeEffect(codec)(recovery);
      expect(yield* Schema.decodeUnknownEffect(codec)(encoded)).toEqual(recovery);
    }).pipe(Effect.provide(layerPortSerialization)),
  );
  it.effect('preserves the operation identity and message over the port codec', () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const codec = serialization.codecFor(CommitExecuteInput);
      const input = {
        reviewId: ReviewId.make('review-1'),
        operationId: OperationId.make('op-1'),
        message: 'Fix issue\n\nDetails',
      };
      const encoded = yield* Schema.encodeEffect(codec)(input);
      expect(yield* Schema.decodeUnknownEffect(codec)(encoded)).toEqual(input);
    }).pipe(Effect.provide(layerPortSerialization)),
  );

  it.effect('transports actionable hook failure details', () =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization;
      const codec = serialization.codecFor(CommitError);
      const error = new CommitError({
        reason: 'HookFailed',
        detail: 'Commit rejected',
        hookOutput: 'pre-commit failed',
      });
      const encoded = yield* Schema.encodeEffect(codec)(error);
      const decoded = yield* Schema.decodeUnknownEffect(codec)(encoded);
      expect(decoded.reason).toBe('HookFailed');
      expect(decoded.hookOutput).toBe('pre-commit failed');
    }).pipe(Effect.provide(layerPortSerialization)),
  );

  it('rejects an unknown selection mode', () => {
    expect(Schema.decodeUnknownResult(CommitSelection)({ _tag: 'Hunks' })._tag).toBe('Failure');
  });
});
