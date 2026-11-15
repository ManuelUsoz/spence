import { Schema } from 'effect';
import { RpcGroup } from 'effect/rpc';

/** Identifies a recorded workspace observation entry in Spence's History Store. */
export const ObservationId = Schema.String.pipe(Schema.brand('ObservationId')).annotate({
  identifier: 'ObservationId',
});
export type ObservationId = typeof ObservationId.Type;

/** Identifies a restore-point Checkpoint associated with a Session/Worktree. */
export const CheckpointId = Schema.String.pipe(Schema.brand('CheckpointId')).annotate({
  identifier: 'CheckpointId',
});
export type CheckpointId = typeof CheckpointId.Type;

/** Tagged error reserved for the Wave 2 History RPC domain. */
export class HistoryError extends Schema.TaggedError<HistoryError>()('HistoryError', {
  reason: Schema.Literals(['NotFound', 'StoreError', 'NewerVersion']),
  detail: Schema.String,
}) {}

/** Placeholder RPC group merged into `DesktopRpcs` for Wave 2 History & Checkpoints. */
export class HistoryRpcs extends RpcGroup.make() {}
