import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId, Timestamp } from '../projects/projects.rpc';

/** Supported external Git host kinds. */
export const GitHostKind = Schema.Literals(['github']).annotate({
  identifier: 'GitHostKind',
});
export type GitHostKind = typeof GitHostKind.Type;

/** Identifies an in-progress OAuth Device Flow ceremony. */
export const DeviceFlowId = Schema.String.pipe(Schema.brand('DeviceFlowId')).annotate({
  identifier: 'DeviceFlowId',
});
export type DeviceFlowId = typeof DeviceFlowId.Type;

/** Positive integer identifying a Pull request within a remote repository. */
export const PullRequestNumber = Schema.Int.pipe(Schema.brand('PullRequestNumber')).annotate({
  identifier: 'PullRequestNumber',
});
export type PullRequestNumber = typeof PullRequestNumber.Type;

/** Normalized remote repository identity (e.g. lowercase `owner/repo` on GitHub). */
export const RemoteRepoRef = Schema.Struct({
  host: GitHostKind,
  canonicalPath: Schema.String,
}).annotate({ identifier: 'RemoteRepoRef' });
export type RemoteRepoRef = typeof RemoteRepoRef.Type;

/** Canonical reference to a Pull request on a remote repository. */
export const PullRequestRef = Schema.Struct({
  repo: RemoteRepoRef,
  number: PullRequestNumber,
}).annotate({ identifier: 'PullRequestRef' });
export type PullRequestRef = typeof PullRequestRef.Type;

/** Identifies a Review on a Pull request. */
export const ReviewId = Schema.String.pipe(Schema.brand('ReviewId')).annotate({
  identifier: 'ReviewId',
});
export type ReviewId = typeof ReviewId.Type;

/** Identifies an inline Review thread on a Pull request. */
export const ReviewThreadId = Schema.String.pipe(Schema.brand('ReviewThreadId')).annotate({
  identifier: 'ReviewThreadId',
});
export type ReviewThreadId = typeof ReviewThreadId.Type;

/** Identifies a Pull request conversation or review comment. */
export const CommentId = Schema.String.pipe(Schema.brand('CommentId')).annotate({
  identifier: 'CommentId',
});
export type CommentId = typeof CommentId.Type;

/** Identifies a Check run or legacy commit status context. */
export const CheckRunId = Schema.String.pipe(Schema.brand('CheckRunId')).annotate({
  identifier: 'CheckRunId',
});
export type CheckRunId = typeof CheckRunId.Type;

/** How a Host account was authenticated. */
export const HostAuthMethod = Schema.Literals(['device-flow', 'pat', 'gh-cli']).annotate({
  identifier: 'HostAuthMethod',
});
export type HostAuthMethod = typeof HostAuthMethod.Type;

/** Connection health of a configured Host account. */
export const HostAccountStatus = Schema.Literals(['connected', 'needs-reconnect']).annotate({
  identifier: 'HostAccountStatus',
});
export type HostAccountStatus = typeof HostAccountStatus.Type;

/** Where the Host credential is kept: OS keyring (`secure`) or process memory only (`session-only`). */
export const HostPersistMode = Schema.Literals(['secure', 'session-only']).annotate({
  identifier: 'HostPersistMode',
});
export type HostPersistMode = typeof HostPersistMode.Type;

/** Required OAuth scopes for GitHub Host operations in Spence. */
export const GITHUB_REQUIRED_SCOPES: ReadonlyArray<string> = ['repo', 'read:org'];

/** Public metadata for a connected (or reconnect-needed) Git host account. Never contains a raw token. */
export const HostAccount = Schema.Struct({
  host: GitHostKind,
  handle: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  authMethod: HostAuthMethod,
  scopes: Schema.Array(Schema.String),
  status: HostAccountStatus,
  statusDetail: Schema.NullOr(Schema.String),
  persistMode: HostPersistMode,
  updatedAt: Timestamp,
}).annotate({ identifier: 'HostAccount' });
export type HostAccount = typeof HostAccount.Type;

/** Current Host accounts and whether OS secure storage is available on this machine. */
export const HostAccountsState = Schema.Struct({
  accounts: Schema.Array(HostAccount),
  secretStorageAvailable: Schema.Boolean,
}).annotate({ identifier: 'HostAccountsState' });
export type HostAccountsState = typeof HostAccountsState.Type;

/** User-facing OAuth Device Flow prompt returned when starting sign-in. */
export const DeviceFlowPrompt = Schema.Struct({
  flowId: DeviceFlowId,
  host: GitHostKind,
  userCode: Schema.String,
  verificationUri: Schema.String,
  expiresAt: Timestamp,
  intervalSeconds: Schema.Int,
}).annotate({ identifier: 'DeviceFlowPrompt' });
export type DeviceFlowPrompt = typeof DeviceFlowPrompt.Type;

/** One poll step of an OAuth Device Flow ceremony. */
export const DeviceFlowPollResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('pending'),
    intervalSeconds: Schema.Int,
  }),
  Schema.Struct({
    status: Schema.Literal('complete'),
    account: HostAccount,
  }),
]).annotate({ identifier: 'DeviceFlowPollResult' });
export type DeviceFlowPollResult = typeof DeviceFlowPollResult.Type;

/** Availability of the `gh` CLI on Merged PATH for one-time token import. */
export const GhCliStatus = Schema.Struct({
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  handle: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'GhCliStatus' });
export type GhCliStatus = typeof GhCliStatus.Type;

/** Supported merge strategies on a Git host. */
export const MergeMethod = Schema.Literals(['merge', 'squash', 'rebase']).annotate({
  identifier: 'MergeMethod',
});
export type MergeMethod = typeof MergeMethod.Type;

/** Static capability flags advertised by a `GitHost` adapter. */
export const HostCapabilities = Schema.Struct({
  supportsDraft: Schema.Boolean,
  supportsThreadResolution: Schema.Boolean,
  supportsAutoMerge: Schema.Boolean,
  supportsPendingReviews: Schema.Boolean,
  supportsMilestones: Schema.Boolean,
  supportedMergeMethods: Schema.Array(MergeMethod),
}).annotate({ identifier: 'HostCapabilities' });
export type HostCapabilities = typeof HostCapabilities.Type;

/** Lifecycle state of a Pull request. */
export const PullRequestState = Schema.Literals(['open', 'draft', 'merged', 'closed']).annotate({
  identifier: 'PullRequestState',
});
export type PullRequestState = typeof PullRequestState.Type;

/** Rolled-up CI check state for a Pull request's head commit. */
export const CheckRollupStatus = Schema.Literals([
  'pending',
  'passing',
  'failing',
  'none',
]).annotate({ identifier: 'CheckRollupStatus' });
export type CheckRollupStatus = typeof CheckRollupStatus.Type;

/** Review decision on a Pull request. */
export const ReviewDecision = Schema.Literals([
  'approved',
  'changesRequested',
  'reviewRequired',
  'none',
]).annotate({ identifier: 'ReviewDecision' });
export type ReviewDecision = typeof ReviewDecision.Type;

/** Viewer's relationship to a Pull request. */
export const ViewerRole = Schema.Literals(['author', 'reviewer', 'assignee']).annotate({
  identifier: 'ViewerRole',
});
export type ViewerRole = typeof ViewerRole.Type;

/** Public Git host user/bot identity. */
export const HostActor = Schema.Struct({
  login: Schema.String,
  displayName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'HostActor' });
export type HostActor = typeof HostActor.Type;

/** Label attached to a Pull request or available in the repository. */
export const PullRequestLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.String,
  description: Schema.NullOr(Schema.String),
}).annotate({ identifier: 'PullRequestLabel' });
export type PullRequestLabel = typeof PullRequestLabel.Type;

/** Repository milestone. */
export const PullRequestMilestone = Schema.Struct({
  id: Schema.String,
  number: Schema.optionalKey(Schema.Int),
  title: Schema.String,
  dueOn: Schema.NullOr(Timestamp),
}).annotate({ identifier: 'PullRequestMilestone' });
export type PullRequestMilestone = typeof PullRequestMilestone.Type;

/** Normalized Check run or legacy commit status entry. */
export const CheckRun = Schema.Struct({
  id: CheckRunId,
  name: Schema.String,
  status: Schema.Literals(['queued', 'inProgress', 'completed']),
  conclusion: Schema.NullOr(
    Schema.Literals([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timedOut',
      'actionRequired',
      'stale',
      'startupFailure',
    ]),
  ),
  url: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  isRequired: Schema.Boolean,
}).annotate({ identifier: 'CheckRun' });
export type CheckRun = typeof CheckRun.Type;

/** State of a Review on a Pull request. */
export const ReviewState = Schema.Literals([
  'pending',
  'commented',
  'approved',
  'changesRequested',
  'dismissed',
]).annotate({ identifier: 'ReviewState' });
export type ReviewState = typeof ReviewState.Type;

/** A submitted or pending Review. */
export const Review = Schema.Struct({
  id: ReviewId,
  author: HostActor,
  state: ReviewState,
  body: Schema.String,
  submittedAt: Schema.NullOr(Timestamp),
}).annotate({ identifier: 'Review' });
export type Review = typeof Review.Type;

/** A comment inside an inline Review thread. */
export const ReviewComment = Schema.Struct({
  id: CommentId,
  reviewId: Schema.optionalKey(ReviewId),
  author: HostActor,
  body: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  url: Schema.String,
}).annotate({ identifier: 'ReviewComment' });
export type ReviewComment = typeof ReviewComment.Type;

/** An inline diff Review thread. */
export const ReviewThread = Schema.Struct({
  id: ReviewThreadId,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  startLine: Schema.NullOr(Schema.Int),
  side: Schema.Literals(['LEFT', 'RIGHT']),
  isResolved: Schema.Boolean,
  isOutdated: Schema.Boolean,
  comments: Schema.Array(ReviewComment),
}).annotate({ identifier: 'ReviewThread' });
export type ReviewThread = typeof ReviewThread.Type;

/** A general conversation comment on a Pull request. */
export const PullRequestComment = Schema.Struct({
  id: CommentId,
  author: HostActor,
  body: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  url: Schema.String,
}).annotate({ identifier: 'PullRequestComment' });
export type PullRequestComment = typeof PullRequestComment.Type;

/** Mergeability status of a Pull request. */
export const MergeStateStatus = Schema.Literals([
  'clean',
  'blocked',
  'behind',
  'dirty',
  'unstable',
  'draft',
  'unknown',
]).annotate({ identifier: 'MergeStateStatus' });
export type MergeStateStatus = typeof MergeStateStatus.Type;

/** Viewer permissions for mutating a Pull request. */
export const PullRequestActions = Schema.Struct({
  canUpdate: Schema.Boolean,
  canMerge: Schema.Boolean,
  canReview: Schema.Boolean,
  canApproveOrRequestChanges: Schema.Boolean,
  canResolveThreads: Schema.Boolean,
  allowedMergeMethods: Schema.Array(MergeMethod),
}).annotate({ identifier: 'PullRequestActions' });
export type PullRequestActions = typeof PullRequestActions.Type;

/** Revision token used for field-level conflict detection on edits. */
export const PullRequestRevision = Schema.Struct({
  headSha: Schema.String,
  updatedAt: Timestamp,
}).annotate({ identifier: 'PullRequestRevision' });
export type PullRequestRevision = typeof PullRequestRevision.Type;

/** Tier 1 listing summary of a Pull request. */
export const PullRequestSummary = Schema.Struct({
  ref: PullRequestRef,
  title: Schema.String,
  state: PullRequestState,
  author: HostActor,
  headRef: Schema.String,
  headSha: Schema.String,
  headRepo: Schema.NullOr(RemoteRepoRef),
  baseRef: Schema.String,
  updatedAt: Timestamp,
  url: Schema.String,
  checkRollup: CheckRollupStatus,
  reviewDecision: ReviewDecision,
  commentCount: Schema.Int,
  unresolvedThreadCount: Schema.NullOr(Schema.Int),
  viewerRoles: Schema.Array(ViewerRole),
  isCrossRepo: Schema.Boolean,
  isPinned: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'PullRequestSummary' });
export type PullRequestSummary = typeof PullRequestSummary.Type;

/** Tier 2 full detail of a Pull request. */
export const PullRequestDetail = Schema.Struct({
  ...PullRequestSummary.fields,
  body: Schema.String,
  mergeState: MergeStateStatus,
  mergeStateReason: Schema.optionalKey(Schema.String),
  autoMergeEnabled: Schema.Boolean,
  labels: Schema.Array(PullRequestLabel),
  reviewers: Schema.Array(HostActor),
  assignees: Schema.Array(HostActor),
  milestone: Schema.NullOr(PullRequestMilestone),
  repoLabels: Schema.Array(PullRequestLabel),
  repoMilestones: Schema.Array(PullRequestMilestone),
  collaborators: Schema.Array(HostActor),
  checks: Schema.Array(CheckRun),
  reviews: Schema.Array(Review),
  reviewThreads: Schema.Array(ReviewThread),
  comments: Schema.Array(PullRequestComment),
  actions: PullRequestActions,
  revision: PullRequestRevision,
  viewerLogin: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: 'PullRequestDetail' });
export type PullRequestDetail = typeof PullRequestDetail.Type;

/** Normalized failure across all Git host auth, transport, and API boundaries. */
export class GitHostError extends Schema.TaggedError<GitHostError>()('GitHostError', {
  reason: Schema.Literals([
    'NotAuthenticated',
    'TokenExpired',
    'Forbidden',
    'NotFound',
    'ValidationFailed',
    'Conflict',
    'RateLimited',
    'UnsupportedCapability',
    'NetworkUnavailable',
    'HostError',
  ]),
  detail: Schema.String,
  retryAfterSeconds: Schema.optionalKey(Schema.Number),
  resetAt: Schema.optionalKey(Timestamp),
  conflictingFields: Schema.optionalKey(Schema.Array(Schema.String)),
  latestDetail: Schema.optionalKey(PullRequestDetail),
}) {}

/** Editable metadata fields for `PullRequests.update`. */
export const PullRequestUpdatePatch = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  baseRef: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.Boolean),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  labels: Schema.optionalKey(Schema.Array(Schema.String)),
  milestoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
}).annotate({ identifier: 'PullRequestUpdatePatch' });
export type PullRequestUpdatePatch = typeof PullRequestUpdatePatch.Type;

/** Target for `PullRequests.addComment` (general conversation, thread reply, or diff line/range). */
export const AddCommentTarget = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('General'),
  }),
  Schema.Struct({
    _tag: Schema.Literal('ThreadReply'),
    threadId: ReviewThreadId,
  }),
  Schema.Struct({
    _tag: Schema.Literal('DiffLine'),
    path: Schema.String,
    line: Schema.Int,
    side: Schema.Literals(['LEFT', 'RIGHT']),
    startLine: Schema.optionalKey(Schema.Int),
    startSide: Schema.optionalKey(Schema.Literals(['LEFT', 'RIGHT'])),
    pending: Schema.Boolean,
  }),
]).annotate({ identifier: 'AddCommentTarget' });
export type AddCommentTarget = typeof AddCommentTarget.Type;

/** Kind of comment for edit/delete operations. */
export const PullRequestCommentKind = Schema.Literals(['issue', 'review']).annotate({
  identifier: 'PullRequestCommentKind',
});
export type PullRequestCommentKind = typeof PullRequestCommentKind.Type;

/** Verdict event when submitting a Pull request Review. */
export const ReviewSubmitEvent = Schema.Literals(['comment', 'approve', 'requestChanges']).annotate(
  {
    identifier: 'ReviewSubmitEvent',
  },
);
export type ReviewSubmitEvent = typeof ReviewSubmitEvent.Type;

/** One line in a parsed PR unified diff hunk. */
export const PrDiffLine = Schema.Struct({
  kind: Schema.Literals(['context', 'added', 'removed']),
  content: Schema.String,
  oldLine: Schema.NullOr(Schema.Int),
  newLine: Schema.NullOr(Schema.Int),
}).annotate({ identifier: 'PrDiffLine' });
export type PrDiffLine = typeof PrDiffLine.Type;

/** One hunk in a parsed PR file diff. */
export const PrDiffHunk = Schema.Struct({
  header: Schema.String,
  oldStart: Schema.Int,
  oldLines: Schema.Int,
  newStart: Schema.Int,
  newLines: Schema.Int,
  lines: Schema.Array(PrDiffLine),
}).annotate({ identifier: 'PrDiffHunk' });
export type PrDiffHunk = typeof PrDiffHunk.Type;

/** Parsed diff entry for a single file in a Pull request. */
export const PullRequestDiffFile = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.optionalKey(Schema.String),
  status: Schema.Literals(['added', 'modified', 'removed', 'renamed']),
  additions: Schema.Int,
  deletions: Schema.Int,
  hunks: Schema.Array(PrDiffHunk),
  truncated: Schema.Boolean,
  noPreviewReason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'PullRequestDiffFile' });
export type PullRequestDiffFile = typeof PullRequestDiffFile.Type;

/** Tier 3 parsed diff for a Pull request. Never persisted to disk. */
export const PullRequestDiff = Schema.Struct({
  ref: PullRequestRef,
  headSha: Schema.String,
  baseSha: Schema.String,
  files: Schema.Array(PullRequestDiffFile),
}).annotate({ identifier: 'PullRequestDiff' });
export type PullRequestDiff = typeof PullRequestDiff.Type;

/** Link between a local Worktree (by realpath/key) and its matching Pull request(s). */
export const WorktreePullRequestLink = Schema.Struct({
  primary: PullRequestSummary,
  openCount: Schema.Int,
  siblingRefs: Schema.Array(PullRequestRef),
}).annotate({ identifier: 'WorktreePullRequestLink' });
export type WorktreePullRequestLink = typeof WorktreePullRequestLink.Type;

/** Current sync / degraded status for a Project's Pull requests. */
export const SyncStatus = Schema.Struct({
  status: Schema.Literals(['idle', 'syncing', 'offline', 'rate-limited', 'needs-reconnect']),
  resetAt: Schema.optionalKey(Timestamp),
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'SyncStatus' });
export type SyncStatus = typeof SyncStatus.Type;

/** Pull requests state for a Project, returned by `getProjectState` and streamed on `changes`. */
export const ProjectPullRequestsState = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Unavailable'),
    projectId: ProjectId,
    reason: Schema.Literals(['NonGit', 'NoSupportedRemote', 'MissingGit', 'FolderMissing']),
    detail: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Available'),
    projectId: ProjectId,
    repo: RemoteRepoRef,
    targetRemoteName: Schema.String,
    headRemoteName: Schema.String,
    capabilities: HostCapabilities,
    accountStatus: Schema.Literals(['disconnected', 'connected', 'needs-reconnect']),
    syncStatus: SyncStatus,
    lastSyncedAt: Schema.NullOr(Timestamp),
    summaries: Schema.Array(PullRequestSummary),
    worktreeLinks: Schema.Record(Schema.String, WorktreePullRequestLink),
  }),
]).annotate({ identifier: 'ProjectPullRequestsState' });
export type ProjectPullRequestsState = typeof ProjectPullRequestsState.Type;

/** Hard blocker preventing Pull request creation until resolved. */
export const CreatePrBlockerReason = Schema.Literals([
  'DetachedHead',
  'ZeroCommitsAhead',
  'OpenPrExists',
  'NotAuthenticated',
  'NoRemote',
]).annotate({ identifier: 'CreatePrBlockerReason' });
export type CreatePrBlockerReason = typeof CreatePrBlockerReason.Type;

/** One explicit blocker for Pull request creation. */
export const CreatePrBlocker = Schema.Struct({
  reason: CreatePrBlockerReason,
  detail: Schema.String,
}).annotate({ identifier: 'CreatePrBlocker' });
export type CreatePrBlocker = typeof CreatePrBlocker.Type;

/** Inspected local + remote state for creating a Pull request from a Worktree. */
export const CreatePrPreparation = Schema.Struct({
  worktreePath: Schema.String,
  headRef: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  defaultBaseRef: Schema.String,
  baseRef: Schema.String,
  availableBaseRefs: Schema.Array(Schema.String),
  aheadCount: Schema.Int,
  behindCount: Schema.Int,
  needsPush: Schema.Boolean,
  headRemoteName: Schema.String,
  isFork: Schema.Boolean,
  isDirty: Schema.Boolean,
  templateBody: Schema.NullOr(Schema.String),
  supportsDraft: Schema.Boolean,
  blockers: Schema.Array(CreatePrBlocker),
  existingOpenPr: Schema.NullOr(PullRequestSummary),
}).annotate({ identifier: 'CreatePrPreparation' });
export type CreatePrPreparation = typeof CreatePrPreparation.Type;

/** AI-drafted title and body for a new Pull request. */
export const DraftPullRequestResult = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
}).annotate({ identifier: 'DraftPullRequestResult' });
export type DraftPullRequestResult = typeof DraftPullRequestResult.Type;

/**
 * Local-only RPC group for Git host authentication and Pull requests.
 * Merged into `DesktopRpcs` only; never exposed in `DeviceScopedRpcs` or `RemoteRpcs`.
 */
export const PullRequestsRpcs = RpcGroup.make(
  Rpc.make('HostAuth.getAccounts', {
    success: HostAccountsState,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.startDeviceFlow', {
    payload: { host: GitHostKind },
    success: DeviceFlowPrompt,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.pollDeviceFlow', {
    payload: { host: GitHostKind, flowId: DeviceFlowId, persistMode: HostPersistMode },
    success: DeviceFlowPollResult,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.cancelDeviceFlow', {
    payload: { host: GitHostKind, flowId: DeviceFlowId },
    success: Schema.Void,
  }),
  Rpc.make('HostAuth.connectPat', {
    payload: { host: GitHostKind, token: Schema.String, persistMode: HostPersistMode },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.checkGhCli', {
    payload: { host: GitHostKind },
    success: GhCliStatus,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.importGhCli', {
    payload: { host: GitHostKind, persistMode: HostPersistMode },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.verify', {
    payload: { host: GitHostKind },
    success: HostAccount,
    error: GitHostError,
  }),
  Rpc.make('HostAuth.disconnect', {
    payload: { host: GitHostKind },
    success: Schema.Void,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.changes', {
    stream: true,
    success: ProjectPullRequestsState,
  }),
  Rpc.make('PullRequests.setActiveView', {
    payload: {
      projectId: Schema.NullOr(ProjectId),
      prPageOpen: Schema.Boolean,
      activePrNumber: Schema.NullOr(PullRequestNumber),
    },
    success: Schema.Void,
  }),
  Rpc.make('PullRequests.getProjectState', {
    payload: { projectId: ProjectId },
    success: ProjectPullRequestsState,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.refreshProject', {
    payload: { projectId: ProjectId },
    success: ProjectPullRequestsState,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.lookupByNumber', {
    payload: { projectId: ProjectId, number: PullRequestNumber },
    success: PullRequestSummary,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.unpinNumber', {
    payload: { projectId: ProjectId, number: PullRequestNumber },
    success: Schema.Void,
  }),
  Rpc.make('PullRequests.getDetail', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      bypassEtag: Schema.optionalKey(Schema.Boolean),
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.getDiff', {
    payload: { projectId: ProjectId, number: PullRequestNumber },
    success: PullRequestDiff,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.prepareCreate', {
    payload: {
      projectId: ProjectId,
      worktreePath: Schema.optionalKey(Schema.String),
      baseRef: Schema.optionalKey(Schema.String),
    },
    success: CreatePrPreparation,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.draftCreate', {
    payload: {
      projectId: ProjectId,
      worktreePath: Schema.optionalKey(Schema.String),
      baseRef: Schema.String,
    },
    success: DraftPullRequestResult,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.create', {
    payload: {
      projectId: ProjectId,
      worktreePath: Schema.optionalKey(Schema.String),
      title: Schema.String,
      body: Schema.String,
      baseRef: Schema.String,
      headRef: Schema.String,
      draft: Schema.Boolean,
      pushFirst: Schema.Boolean,
    },
    success: PullRequestSummary,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.update', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      revision: PullRequestRevision,
      patch: PullRequestUpdatePatch,
      baseline: Schema.optionalKey(PullRequestUpdatePatch),
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.addComment', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      body: Schema.String,
      target: AddCommentTarget,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.editComment', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      commentId: CommentId,
      kind: PullRequestCommentKind,
      body: Schema.String,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.deleteComment', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      commentId: CommentId,
      kind: PullRequestCommentKind,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.submitReview', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      reviewId: Schema.optionalKey(ReviewId),
      event: ReviewSubmitEvent,
      body: Schema.String,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.deletePendingReview', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      reviewId: ReviewId,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.resolveThread', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      threadId: ReviewThreadId,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
  Rpc.make('PullRequests.unresolveThread', {
    payload: {
      projectId: ProjectId,
      number: PullRequestNumber,
      threadId: ReviewThreadId,
    },
    success: PullRequestDetail,
    error: GitHostError,
  }),
);
