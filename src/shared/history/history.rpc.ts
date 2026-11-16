import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId, TurnId } from '../sessions/sessions.rpc';
import { WorktreeId } from '../worktrees/worktrees.rpc';
import { HistoryComparison } from './comparison';
export { ObservationId } from './observation-id';

/** Identifies a recorded workspace observation entry in Spence's History Store. */

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
export class HistoryRpcs extends RpcGroup.make(
  Rpc.make('History.findByTurn', {
    payload: { sessionId: SessionId, turnId: TurnId },
    success: Schema.UndefinedOr(HistoryComparison),
    error: HistoryError,
  }),
  Rpc.make('History.list', {
    payload: { sessionId: SessionId, worktreeId: WorktreeId },
    success: Schema.Array(HistoryComparison),
    error: HistoryError,
  }),
) {}
