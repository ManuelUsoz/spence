import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId } from '../sessions/sessions.rpc';
import {
  RepositoryId,
  WorktreeBinding,
  WorktreeBindingReason,
  WorktreeHeadState,
  WorktreeId,
} from '../worktrees/worktrees.rpc';

import { OperationId, OperationSnapshot } from './operation-schema';
export * from './operation-schema';

/** Active Git repository integration mode detected under `.git`. */
export const GitIntegrationState = Schema.Literals([
  'None',
  'Merge',
  'Rebase',
  'CherryPick',
  'Revert',
  'Bisect',
]).annotate({ identifier: 'GitIntegrationState' });
export type GitIntegrationState = typeof GitIntegrationState.Type;

/** Primary display status of a changed path in the active Worktree. */
export const FileChangeStatus = Schema.Literals([
  'Added',
  'Modified',
  'Deleted',
  'Renamed',
  'Copied',
  'TypeChanged',
  'Untracked',
  'Conflicted',
]).annotate({ identifier: 'FileChangeStatus' });
export type FileChangeStatus = typeof FileChangeStatus.Type;

/** Detailed index or working-tree status slot for a path. */
export const FileSlotStatus = Schema.Literals([
  'Unmodified',
  'Added',
  'Modified',
  'Deleted',
  'Renamed',
  'Copied',
  'TypeChanged',
  'Untracked',
  'Conflicted',
]).annotate({ identifier: 'FileSlotStatus' });
export type FileSlotStatus = typeof FileSlotStatus.Type;

/** File inspection classification in the working tree. */
export const ChangedFileKind = Schema.Literals([
  'Regular',
  'Binary',
  'Symlink',
  'Submodule',
  'TooLarge',
  'Special',
  'Unreadable',
  'Missing',
]).annotate({ identifier: 'ChangedFileKind' });
export type ChangedFileKind = typeof ChangedFileKind.Type;

/** Reason an entry inside the folder was excluded from normal change rows. */
export const ExcludedChangeReason = Schema.Literals([
  'NestedRepo',
  'SpecialFile',
  'Unreadable',
  'UnsafePath',
]).annotate({ identifier: 'ExcludedChangeReason' });
export type ExcludedChangeReason = typeof ExcludedChangeReason.Type;

/** Entry disclosed as excluded from current-change inspection. */
export const ExcludedChangeEntry = Schema.Struct({
  path: Schema.String,
  reason: ExcludedChangeReason,
  detail: Schema.String,
}).annotate({ identifier: 'ExcludedChangeEntry' });
export type ExcludedChangeEntry = typeof ExcludedChangeEntry.Type;

/** One current-change row in the Session's active Worktree. */
export const ChangedFileEntry = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
  status: FileChangeStatus,
  indexStatus: FileSlotStatus,
  workTreeStatus: FileSlotStatus,
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  hasStagedAndUnstaged: Schema.Boolean,
  stagedNetZeroWorking: Schema.Boolean,
  kind: ChangedFileKind,
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  byteSize: Schema.optionalKey(Schema.Number),
  unstable: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'ChangedFileEntry' });
export type ChangedFileEntry = typeof ChangedFileEntry.Type;

/** Aggregate line and file counts across current Worktree changes. */
export const CurrentChangesSummary = Schema.Struct({
  changedCount: Schema.Number,
  stagedCount: Schema.Number,
  unstagedCount: Schema.Number,
  untrackedCount: Schema.Number,
  conflictedCount: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
}).annotate({ identifier: 'CurrentChangesSummary' });
export type CurrentChangesSummary = typeof CurrentChangesSummary.Type;

/** Upstream ahead/behind counts reported by Git for the current branch. */
export const AheadBehindCount = Schema.Struct({
  upstream: Schema.String,
  ahead: Schema.Number,
  behind: Schema.Number,
}).annotate({ identifier: 'AheadBehindCount' });
export type AheadBehindCount = typeof AheadBehindCount.Type;

/** Capability and status state of the Session's bound Worktree. */
export const CurrentChangesState = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Available'),
    gitVersion: Schema.String,
    repositoryId: Schema.optionalKey(RepositoryId),
    worktreeId: Schema.optionalKey(WorktreeId),
    toplevelPath: Schema.String,
    head: WorktreeHeadState,
    aheadBehind: Schema.optionalKey(AheadBehindCount),
    integration: GitIntegrationState,
    hasConflicts: Schema.Boolean,
    unstablePaths: Schema.Array(Schema.String),
    instabilityDetail: Schema.optionalKey(Schema.String),
    excludedEntries: Schema.Array(ExcludedChangeEntry),
    incompleteDiffCounts: Schema.Boolean,
    summary: CurrentChangesSummary,
    files: Schema.Array(ChangedFileEntry),
  }),
  Schema.Struct({
    _tag: Schema.Literal('WorktreeMissing'),
    reason: WorktreeBindingReason,
    detail: Schema.String,
    expectedPath: Schema.optionalKey(Schema.String),
    lastKnownBranch: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('MissingGit'),
    detail: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('NonGit'),
    path: Schema.String,
    detail: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('MissingPath'),
    path: Schema.String,
    detail: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('UnsupportedRepo'),
    path: Schema.String,
    detail: Schema.String,
  }),
]).annotate({ identifier: 'CurrentChangesState' });
export type CurrentChangesState = typeof CurrentChangesState.Type;

/** Current-changes snapshot returned for a Session's bound Worktree. */
export const CurrentChangesSnapshot = Schema.Struct({
  sessionId: SessionId,
  cwd: Schema.String,
  binding: Schema.optionalKey(WorktreeBinding),
  inspectedAt: Schema.Number,
  state: CurrentChangesState,
}).annotate({ identifier: 'CurrentChangesSnapshot' });
export type CurrentChangesSnapshot = typeof CurrentChangesSnapshot.Type;

/** Diff comparison scope for inspecting current Worktree changes. */
export const DiffScope = Schema.Literals(['combined', 'staged', 'unstaged']).annotate({
  identifier: 'DiffScope',
});
export type DiffScope = typeof DiffScope.Type;

/** Kind of line inside a unified diff hunk. */
export const DiffLineKind = Schema.Literals(['context', 'add', 'delete']).annotate({
  identifier: 'DiffLineKind',
});
export type DiffLineKind = typeof DiffLineKind.Type;

/** One line inside a bounded inline diff hunk. */
export const DiffLine = Schema.Struct({
  kind: DiffLineKind,
  oldLine: Schema.optionalKey(Schema.Number),
  newLine: Schema.optionalKey(Schema.Number),
  text: Schema.String,
}).annotate({ identifier: 'DiffLine' });
export type DiffLine = typeof DiffLine.Type;

/** One unified diff hunk with bounded line entries. */
export const DiffHunk = Schema.Struct({
  header: Schema.String,
  oldStart: Schema.Number,
  oldLines: Schema.Number,
  newStart: Schema.Number,
  newLines: Schema.Number,
  lines: Schema.Array(DiffLine),
}).annotate({ identifier: 'DiffHunk' });
export type DiffHunk = typeof DiffHunk.Type;

/** Why an inline text diff preview cannot be rendered cleanly. */
export const UnavailableDiffReason = Schema.Literals([
  'Binary',
  'TooLarge',
  'Symlink',
  'Submodule',
  'SpecialFile',
  'Unreadable',
  'MissingFile',
  'NoDifference',
]).annotate({ identifier: 'UnavailableDiffReason' });
export type UnavailableDiffReason = typeof UnavailableDiffReason.Type;

/** Bounded inline diff preview (or explicit unavailable/binary/too-large disclosure). */
export const DiffPreview = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Patch'),
    path: Schema.String,
    previousPath: Schema.optionalKey(Schema.String),
    scope: DiffScope,
    hunks: Schema.Array(DiffHunk),
    additions: Schema.Number,
    deletions: Schema.Number,
    truncated: Schema.Boolean,
    truncationDetail: Schema.optionalKey(Schema.String),
    unstable: Schema.Boolean,
    instabilityDetail: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Unavailable'),
    path: Schema.String,
    scope: DiffScope,
    reason: UnavailableDiffReason,
    detail: Schema.String,
    byteSize: Schema.optionalKey(Schema.Number),
    limitBytes: Schema.optionalKey(Schema.Number),
    symlinkTarget: Schema.optionalKey(Schema.String),
    hasStagedChanges: Schema.optionalKey(Schema.Boolean),
    unstable: Schema.Boolean,
    instabilityDetail: Schema.optionalKey(Schema.String),
  }),
]).annotate({ identifier: 'DiffPreview' });
export type DiffPreview = typeof DiffPreview.Type;

/** One Git commit entry in secondary Git history. */
export const CommitSummary = Schema.Struct({
  sha: Schema.String,
  shortSha: Schema.String,
  parentShas: Schema.Array(Schema.String),
  isMerge: Schema.Boolean,
  subject: Schema.String,
  body: Schema.String,
  authorName: Schema.String,
  authorEmail: Schema.String,
  authoredAtSeconds: Schema.Number,
  refs: Schema.Array(Schema.String),
}).annotate({ identifier: 'CommitSummary' });
export type CommitSummary = typeof CommitSummary.Type;

/** Reason Git commit history is unavailable for a Session's Worktree. */
export const CommitHistoryUnavailableReason = Schema.Literals([
  'MissingGit',
  'NonGit',
  'MissingPath',
  'UnsupportedRepo',
  'WorktreeMissing',
]).annotate({ identifier: 'CommitHistoryUnavailableReason' });
export type CommitHistoryUnavailableReason = typeof CommitHistoryUnavailableReason.Type;

/** Paginated Git commit history for the Session's active Worktree. */
export const CommitHistorySnapshot = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('History'),
    sessionId: SessionId,
    cwd: Schema.String,
    head: WorktreeHeadState,
    commits: Schema.Array(CommitSummary),
    hasMore: Schema.Boolean,
    nextOffset: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Unborn'),
    sessionId: SessionId,
    cwd: Schema.String,
    branch: Schema.String,
    ref: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Unavailable'),
    sessionId: SessionId,
    cwd: Schema.String,
    reason: CommitHistoryUnavailableReason,
    detail: Schema.String,
  }),
]).annotate({ identifier: 'CommitHistorySnapshot' });
export type CommitHistorySnapshot = typeof CommitHistorySnapshot.Type;

/** Changed file status recorded on a Git commit. */
export const CommitFileChangeStatus = Schema.Literals([
  'Added',
  'Modified',
  'Deleted',
  'Renamed',
  'Copied',
  'TypeChanged',
]).annotate({ identifier: 'CommitFileChangeStatus' });
export type CommitFileChangeStatus = typeof CommitFileChangeStatus.Type;

/** One file modified inside a specific Git commit. */
export const CommitChangedFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
  status: CommitFileChangeStatus,
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  binary: Schema.Boolean,
}).annotate({ identifier: 'CommitChangedFile' });
export type CommitChangedFile = typeof CommitChangedFile.Type;

/** Full metadata and changed-file summary for a single Git commit. */
export const CommitDetail = Schema.Struct({
  sessionId: SessionId,
  cwd: Schema.String,
  commit: CommitSummary,
  files: Schema.Array(CommitChangedFile),
  truncatedFiles: Schema.Boolean,
}).annotate({ identifier: 'CommitDetail' });
export type CommitDetail = typeof CommitDetail.Type;

/** Tagged error raised by the Source Control RPC boundary. */
/** Tagged error reserved for the Wave 2 Source Control RPC domain. */
export class SourceControlError extends Schema.TaggedError<SourceControlError>()(
  'SourceControlError',
  {
    reason: Schema.Literals([
      'MissingGit',
      'NonGit',
      'MissingPath',
      'UnsupportedRepo',
      'WorktreeMissing',
      'NotFound',
      'InvalidInput',
      'Conflict',
      'Busy',
      'StaleReview',
      'ReviewExpired',
      'Conflict',
      'Busy',
      'UntrustedPath',
      'RecoveryRequired',
      'WorkerFailed',
      'OperationFailed',
    ]),
    detail: Schema.String,
  },
) {}

/** RPC contract for inspecting current Worktree changes and secondary Git commit history. */
export class SourceControlRpcs extends RpcGroup.make(
  Rpc.make('SourceControl.status', {
    payload: Schema.Struct({
      sessionId: SessionId,
    }),
    success: CurrentChangesSnapshot,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.diff', {
    payload: Schema.Struct({
      sessionId: SessionId,
      path: Schema.String,
      scope: Schema.optionalKey(DiffScope),
    }),
    success: DiffPreview,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.commits', {
    payload: Schema.Struct({
      sessionId: SessionId,
      limit: Schema.optionalKey(Schema.Number),
      offset: Schema.optionalKey(Schema.Number),
    }),
    success: CommitHistorySnapshot,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.commitDetail', {
    payload: Schema.Struct({
      sessionId: SessionId,
      sha: Schema.String,
    }),
    success: CommitDetail,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.commitFileDiff', {
    payload: Schema.Struct({
      sessionId: SessionId,
      sha: Schema.String,
      path: Schema.String,
    }),
    success: DiffPreview,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.listOperations', {
    payload: Schema.Struct({
      repositoryKey: Schema.optionalKey(Schema.String),
      sourcePath: Schema.optionalKey(Schema.String),
    }),
    success: Schema.Array(OperationSnapshot),
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.getOperation', {
    payload: Schema.Struct({
      operationId: OperationId,
    }),
    success: OperationSnapshot,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.operationEvents', {
    success: OperationSnapshot,
    error: SourceControlError,
    stream: true,
  }),
  Rpc.make('SourceControl.reconcileOperation', {
    payload: Schema.Struct({
      operationId: OperationId,
    }),
    success: OperationSnapshot,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.dismissOperation', {
    payload: Schema.Struct({
      operationId: OperationId,
    }),
    success: OperationSnapshot,
    error: SourceControlError,
  }),
  Rpc.make('SourceControl.cancelOperation', {
    payload: Schema.Struct({
      operationId: OperationId,
    }),
    success: OperationSnapshot,
    error: SourceControlError,
  }),
) {}
