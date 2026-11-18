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
  Schema.TaggedStruct('Available', {
    entries: Schema.Array(WorktreeEntry),
    /** The Session has not run a Turn yet, so it can still move into a new Worktree. */
    canSelect: Schema.Boolean,
  }),
  Unavailable,
]).annotate({ identifier: 'WorktreesResult' });
export type WorktreesResult = typeof WorktreesResult.Type;

export const PrepareDraftResult = Schema.Union([
  /** The Worktree exists and the draft Session now works in it (its Agent restarts there). */
  Schema.TaggedStruct('Prepared', { entry: WorktreeEntry }),
  /**
   * Nothing was changed, except `StartFailed`: then the Worktree exists but the draft could not be moved into it.
   * `Busy`: the Session already ran a Turn.
   */
  Schema.TaggedStruct('Rejected', {
    reason: Schema.Literals([
      'InvalidBranch',
      'BranchExists',
      'DestinationExists',
      'UnknownBase',
      'Busy',
      'StartFailed',
    ]),
    detail: Schema.String,
  }),
  Unavailable,
]).annotate({ identifier: 'PrepareDraftResult' });
export type PrepareDraftResult = typeof PrepareDraftResult.Type;

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
  /**
   * Creates a Worktree on a new branch started from `base` (default: the Session's HEAD) and moves the unsent draft
   * Session into it. Called when the first Message is sent.
   */
  Rpc.make('Worktrees.prepareDraft', {
    payload: { ...BySession, branch: Schema.String, base: Schema.optionalKey(Schema.String) },
    success: PrepareDraftResult,
    error: WorktreesError,
  }),
);
