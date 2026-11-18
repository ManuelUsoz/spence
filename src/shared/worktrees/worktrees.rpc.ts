import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { GitUnavailableReason } from '../source-control/source-control.rpc';
import { SessionId } from '../sessions/sessions.rpc';

/** One Git Worktree of the Session's repository. */
export const WorktreeEntry = Schema.Struct({
  path: Schema.String,
  folderName: Schema.String,
  /** `null` while HEAD is detached. */
  branch: Schema.NullOr(Schema.String),
  detached: Schema.Boolean,
  isPrimary: Schema.Boolean,
  /** The Worktree the Session works in. */
  isCurrent: Schema.Boolean,
  /** Git still lists it but its folder is gone. */
  missing: Schema.Boolean,
  locked: Schema.Boolean,
}).annotate({ identifier: 'WorktreeEntry' });
export type WorktreeEntry = typeof WorktreeEntry.Type;

const Unavailable = Schema.TaggedStruct('Unavailable', {
  reason: GitUnavailableReason,
  detail: Schema.String,
});

export const WorktreesResult = Schema.Union([
  /** Primary Worktree first. */
  Schema.TaggedStruct('Available', { entries: Schema.Array(WorktreeEntry) }),
  Unavailable,
]).annotate({ identifier: 'WorktreesResult' });
export type WorktreesResult = typeof WorktreesResult.Type;

export const CreateWorktreeResult = Schema.Union([
  Schema.TaggedStruct('Created', { entry: WorktreeEntry }),
  /** Nothing was changed: the branch name or folder cannot be used. */
  Schema.TaggedStruct('Rejected', {
    reason: Schema.Literals(['InvalidBranch', 'BranchExists', 'DestinationExists']),
    detail: Schema.String,
  }),
  Unavailable,
]).annotate({ identifier: 'CreateWorktreeResult' });
export type CreateWorktreeResult = typeof CreateWorktreeResult.Type;

export const SelectWorktreeResult = Schema.Union([
  Schema.TaggedStruct('Selected', {}),
  /** `Busy`: the Session already ran a Turn. `Unknown`: not a Worktree of this repository. `Missing`: folder is gone. */
  Schema.TaggedStruct('Rejected', {
    reason: Schema.Literals(['Busy', 'Unknown', 'Missing']),
    detail: Schema.String,
  }),
  Unavailable,
]).annotate({ identifier: 'SelectWorktreeResult' });
export type SelectWorktreeResult = typeof SelectWorktreeResult.Type;

export class WorktreesError extends Schema.TaggedError<WorktreesError>()('WorktreesError', {
  reason: Schema.Literals(['SessionNotFound']),
  detail: Schema.String,
}) {}

const BySession = { sessionId: SessionId };

export const WorktreesRpcs = RpcGroup.make(
  /** The Worktrees of the Session's repository, and which one the Session works in. */
  Rpc.make('Worktrees.list', {
    payload: BySession,
    success: WorktreesResult,
    error: WorktreesError,
  }),
  /** Adds a Worktree on a new branch, started from the Session's HEAD, beside the repository. */
  Rpc.make('Worktrees.create', {
    payload: { ...BySession, branch: Schema.String },
    success: CreateWorktreeResult,
    error: WorktreesError,
  }),
  /** Moves an unsent draft Session into another Worktree of its repository. */
  Rpc.make('Worktrees.select', {
    payload: { ...BySession, path: Schema.String },
    success: SelectWorktreeResult,
    error: WorktreesError,
  }),
);
