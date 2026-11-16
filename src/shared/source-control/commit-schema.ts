import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId } from '../sessions/sessions.rpc';
import { WorktreeHeadState, WorktreeId, RepositoryId } from '../worktrees/worktrees.rpc';
import { OperationId, ReviewId } from './operation-schema';

/** Whole-file selection; paths are repository-relative and validated by the server. */
export const CommitSelection = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('All') }),
  Schema.Struct({ _tag: Schema.Literal('Selected'), paths: Schema.Array(Schema.String) }),
]);
export type CommitSelection = typeof CommitSelection.Type;

export const CommitReviewInput = Schema.Struct({
  sessionId: SessionId,
  selection: CommitSelection,
});
export type CommitReviewInput = typeof CommitReviewInput.Type;

/** A whole-file candidate and its index and saved working-tree state. */
export const CommitReviewEntry = Schema.Struct({
  path: Schema.String,
  selected: Schema.Boolean,
  change: Schema.Literals(['Added', 'Modified', 'Deleted', 'Untracked']),
  eligible: Schema.Boolean,
  staged: Schema.Boolean,
  workingTreeChanged: Schema.Boolean,
  hasNewerWorkingContent: Schema.Boolean,
  preservesUnselectedStaging: Schema.Boolean,
});
export type CommitReviewEntry = typeof CommitReviewEntry.Type;

export const CommitReview = Schema.Struct({
  reviewId: ReviewId,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number,
  repositoryId: RepositoryId,
  worktreeId: WorktreeId,
  head: WorktreeHeadState,
  selection: CommitSelection,
  paths: Schema.Array(Schema.String),
  entries: Schema.Array(CommitReviewEntry),
  warnings: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.Struct({ code: Schema.String, detail: Schema.String })),
});
export type CommitReview = typeof CommitReview.Type;

/** The operation identity makes retries idempotent; fingerprints remain server-held. */
export const CommitExecuteInput = Schema.Struct({
  reviewId: ReviewId,
  operationId: OperationId,
  message: Schema.String,
});
export type CommitExecuteInput = typeof CommitExecuteInput.Type;

export const CommitExecuteResult = Schema.Struct({ operationId: OperationId });
export type CommitExecuteResult = typeof CommitExecuteResult.Type;

export class CommitError extends Schema.TaggedError<CommitError>()('CommitError', {
  reason: Schema.Literals([
    'InvalidInput',
    'StaleReview',
    'ReviewExpired',
    'Conflict',
    'Busy',
    'MissingIdentity',
    'UnsupportedRepo',
    'HookFailed',
    'HookModifiedContent',
    'RecoveryRequired',
    'WorkerFailed',
    'OperationFailed',
    'Unavailable',
  ]),
  detail: Schema.String,
  hookOutput: Schema.optionalKey(Schema.String),
}) {}

/** Reserved contract; deliberately not merged into DesktopRpcs until implemented safely. */
export class CommitRpcs extends RpcGroup.make(
  Rpc.make('SourceControl.reviewCommit', {
    payload: CommitReviewInput,
    success: CommitReview,
    error: CommitError,
  }),
  Rpc.make('SourceControl.executeCommit', {
    payload: CommitExecuteInput,
    success: CommitExecuteResult,
    error: CommitError,
  }),
) {}
