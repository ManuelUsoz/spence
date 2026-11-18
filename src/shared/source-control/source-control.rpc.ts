import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId } from '../sessions/sessions.rpc';

/** Primary display status of a changed path. */
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

/** How a changed file can be inspected in the working tree. */
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

/** One changed path: staged, unstaged and untracked changes from every writer. */
export const ChangedFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
  status: FileChangeStatus,
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  kind: ChangedFileKind,
  /** `null` when git cannot count lines (binary or too large). */
  additions: Schema.NullOr(Schema.Number),
  deletions: Schema.NullOr(Schema.Number),
  /** The file changed while it was being read; its counts may be stale. */
  unstable: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'ChangedFile' });
export type ChangedFile = typeof ChangedFile.Type;

export const HeadState = Schema.Union([
  Schema.TaggedStruct('Branch', { branch: Schema.String }),
  Schema.TaggedStruct('Detached', { commit: Schema.String }),
  Schema.TaggedStruct('Unborn', { branch: Schema.String }),
]).annotate({ identifier: 'HeadState' });
export type HeadState = typeof HeadState.Type;

/** Why the Session's folder has no Git view. Normal states, not errors. */
export const GitUnavailableReason = Schema.Literals([
  'MissingGit',
  'MissingPath',
  'NonGit',
  'UnsupportedRepo',
  /** Git ran but failed for a passing reason (a timeout, a lock, ownership); trying again may work. */
  'GitFailed',
]).annotate({ identifier: 'GitUnavailableReason' });
export type GitUnavailableReason = typeof GitUnavailableReason.Type;

const Unavailable = Schema.TaggedStruct('Unavailable', {
  reason: GitUnavailableReason,
  detail: Schema.String,
});

/** The current changes of the Session's folder. */
export const ChangesResult = Schema.Union([
  Schema.TaggedStruct('Available', {
    head: HeadState,
    upstream: Schema.optionalKey(
      Schema.Struct({ name: Schema.String, ahead: Schema.Number, behind: Schema.Number }),
    ),
    /** A merge, rebase or similar is in progress, so changes are in flux. */
    integration: Schema.Literals(['None', 'Merge', 'Rebase', 'CherryPick', 'Revert', 'Bisect']),
    files: Schema.Array(ChangedFile),
    /** Paths left out (nested repositories, special files, unreadable entries). */
    excludedCount: Schema.Number,
    /** The repository's remotes, listed only while the branch has no upstream (the one to push to is then a choice). */
    remotes: Schema.Array(Schema.String),
  }),
  Unavailable,
]).annotate({ identifier: 'ChangesResult' });
export type ChangesResult = typeof ChangesResult.Type;

export const DiffScope = Schema.Literals(['combined', 'staged', 'unstaged']).annotate({
  identifier: 'DiffScope',
});
export type DiffScope = typeof DiffScope.Type;

export const DiffLine = Schema.Struct({
  kind: Schema.Literals(['context', 'add', 'delete']),
  oldLine: Schema.optionalKey(Schema.Number),
  newLine: Schema.optionalKey(Schema.Number),
  text: Schema.String,
}).annotate({ identifier: 'DiffLine' });
export type DiffLine = typeof DiffLine.Type;

export const DiffHunk = Schema.Struct({
  header: Schema.String,
  lines: Schema.Array(DiffLine),
}).annotate({ identifier: 'DiffHunk' });
export type DiffHunk = typeof DiffHunk.Type;

/** The diff of one file, or the reason there is none to show. */
export const DiffResult = Schema.Union([
  Schema.TaggedStruct('Patch', {
    hunks: Schema.Array(DiffHunk),
    additions: Schema.Number,
    deletions: Schema.Number,
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct('NoPreview', {
    reason: Schema.Literals([
      'Binary',
      'TooLarge',
      'Symlink',
      'Submodule',
      'SpecialFile',
      'Unreadable',
      'MissingFile',
      'NoDifference',
    ]),
    detail: Schema.String,
  }),
  Schema.TaggedStruct('InvalidPath', { detail: Schema.String }),
  Unavailable,
]).annotate({ identifier: 'DiffResult' });
export type DiffResult = typeof DiffResult.Type;

export const CommitSummary = Schema.Struct({
  sha: Schema.String,
  shortSha: Schema.String,
  subject: Schema.String,
  authorName: Schema.String,
  /** Seconds since the epoch, as git reports it. */
  authoredAtSeconds: Schema.Number,
  isMerge: Schema.Boolean,
  refs: Schema.Array(Schema.String),
}).annotate({ identifier: 'CommitSummary' });
export type CommitSummary = typeof CommitSummary.Type;

export const CommitsResult = Schema.Union([
  Schema.TaggedStruct('History', {
    commits: Schema.Array(CommitSummary),
    hasMore: Schema.Boolean,
  }),
  /** The branch has no commits yet. */
  Schema.TaggedStruct('Unborn', { branch: Schema.String }),
  Unavailable,
]).annotate({ identifier: 'CommitsResult' });
export type CommitsResult = typeof CommitsResult.Type;

/** A file to commit; a renamed one carries its old path so the commit records a rename. */
export const CommitFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'CommitFile' });
export type CommitFile = typeof CommitFile.Type;

/** Why a push, pull or fetch was refused before or by the server; nothing was changed. */
export const RemoteRejection = Schema.Literals([
  'NoRemote',
  'NeedsRemote',
  'UnknownRemote',
  'NoUpstream',
  'DetachedHead',
  'Behind',
  'Diverged',
]).annotate({ identifier: 'RemoteRejection' });
export type RemoteRejection = typeof RemoteRejection.Type;

export const RemoteResult = Schema.Union([
  Schema.TaggedStruct('Done', { detail: Schema.String }),
  Schema.TaggedStruct('Rejected', { reason: RemoteRejection, detail: Schema.String }),
  /** Git ran and failed; the text is its own output. */
  Schema.TaggedStruct('Failed', { detail: Schema.String }),
  Unavailable,
]).annotate({ identifier: 'RemoteResult' });
export type RemoteResult = typeof RemoteResult.Type;

export const CommitResult = Schema.Union([
  Schema.TaggedStruct('Committed', {
    sha: Schema.String,
    shortSha: Schema.String,
    /** With Commit & push: whether the push went through; the commit is kept either way. */
    pushed: Schema.Literals(['NotRequested', 'Pushed', 'Failed']),
    pushDetail: Schema.optionalKey(Schema.String),
  }),
  /** Nothing was committed: the request cannot be carried out. */
  Schema.TaggedStruct('Rejected', {
    reason: Schema.Literals([
      'EmptyMessage',
      'NothingSelected',
      'IntegrationInProgress',
      'NoRemote',
      'NeedsRemote',
      'UnknownRemote',
      'DetachedHead',
    ]),
    detail: Schema.String,
  }),
  /** Git refused (a hook, a missing identity); the text is its own output. */
  Schema.TaggedStruct('Failed', { detail: Schema.String }),
  Unavailable,
]).annotate({ identifier: 'CommitResult' });
export type CommitResult = typeof CommitResult.Type;

export class SourceControlError extends Schema.TaggedError<SourceControlError>()(
  'SourceControlError',
  {
    /** `SessionNotFound`: no Session has the id. */
    reason: Schema.Literals(['SessionNotFound']),
    detail: Schema.String,
  },
) {}

const BySession = { sessionId: SessionId };

export const SourceControlRpcs = RpcGroup.make(
  /** Staged, unstaged and untracked changes in the Session's folder, from every writer. */
  Rpc.make('SourceControl.changes', {
    payload: BySession,
    success: ChangesResult,
    error: SourceControlError,
  }),
  /** The diff of one changed file. */
  Rpc.make('SourceControl.diff', {
    payload: {
      ...BySession,
      path: Schema.String,
      /** The path a renamed or copied file had before, so its diff pairs with the old one. */
      previousPath: Schema.optionalKey(Schema.String),
      scope: DiffScope,
    },
    success: DiffResult,
    error: SourceControlError,
  }),
  /** Recent commits of the Session's current branch, newest first. */
  Rpc.make('SourceControl.commits', {
    payload: { ...BySession, limit: Schema.Number, offset: Schema.Number },
    success: CommitsResult,
    error: SourceControlError,
  }),
  /** Commits exactly these files, leaving every other change as it was; optionally pushes right after. */
  Rpc.make('SourceControl.commit', {
    payload: {
      ...BySession,
      message: Schema.String,
      files: Schema.Array(CommitFile),
      push: Schema.Boolean,
      /** The remote to push to, needed only while the branch has no upstream. */
      remote: Schema.optionalKey(Schema.String),
    },
    success: CommitResult,
    error: SourceControlError,
  }),
  /** Downloads what the remote has, without touching the working folder. */
  Rpc.make('SourceControl.fetch', {
    payload: BySession,
    success: RemoteResult,
    error: SourceControlError,
  }),
  /** Brings the branch up to its upstream when that needs no merge. */
  Rpc.make('SourceControl.pull', {
    payload: BySession,
    success: RemoteResult,
    error: SourceControlError,
  }),
  /** Pushes the branch to its upstream, or to the given remote when it has none. */
  Rpc.make('SourceControl.push', {
    payload: { ...BySession, remote: Schema.optionalKey(Schema.String) },
    success: RemoteResult,
    error: SourceControlError,
  }),
);
