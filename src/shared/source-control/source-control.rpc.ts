import { Schema } from 'effect';
import { RpcGroup } from 'effect/rpc';

/** Identifies a Source Control diff/change review snapshot. */
export const ReviewId = Schema.String.pipe(Schema.brand('ReviewId')).annotate({
  identifier: 'ReviewId',
});
export type ReviewId = typeof ReviewId.Type;

/** Identifies a serialized Source Control operation on a Repository/Worktree. */
export const OperationId = Schema.String.pipe(Schema.brand('OperationId')).annotate({
  identifier: 'OperationId',
});
export type OperationId = typeof OperationId.Type;

/** Tagged error reserved for the Wave 2 Source Control RPC domain. */
export class SourceControlError extends Schema.TaggedError<SourceControlError>()(
  'SourceControlError',
  {
    reason: Schema.Literals(['MissingGit', 'NonGit', 'Conflict', 'Busy', 'OperationFailed']),
    detail: Schema.String,
  },
) {}

/** Placeholder RPC group merged into `DesktopRpcs` for Wave 2 Source Control workflows. */
export class SourceControlRpcs extends RpcGroup.make() {}
