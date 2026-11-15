import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId, Timestamp } from '../projects/projects.rpc';
import { OperationId, OperationSnapshot, ReviewId } from '../source-control/source-control.rpc';

/** Identifies a Git repository by its canonical common administrative directory. */
export const RepositoryId = Schema.String.pipe(Schema.brand('RepositoryId')).annotate({
  identifier: 'RepositoryId',
});
export type RepositoryId = typeof RepositoryId.Type;

/** Identifies a registered Git Worktree entry in Spence's Store. */
export const WorktreeId = Schema.String.pipe(Schema.brand('WorktreeId')).annotate({
  identifier: 'WorktreeId',
});
export type WorktreeId = typeof WorktreeId.Type;

/** Whether Git and the target repository/checkout support Worktree discovery and Git operations. */
export const GitCapability = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Available'),
    gitVersion: Schema.String,
    executable: Schema.String,
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
]).annotate({ identifier: 'GitCapability' });
export type GitCapability = typeof GitCapability.Type;

/** HEAD checkout state reported by Git for a Worktree. */
export const WorktreeHeadState = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Branch'),
    branch: Schema.String,
    ref: Schema.String,
    commit: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Detached'),
    commit: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Unborn'),
    branch: Schema.String,
  }),
]).annotate({ identifier: 'WorktreeHeadState' });
export type WorktreeHeadState = typeof WorktreeHeadState.Type;

/** One discovered Git Worktree belonging to a Repository. */
export const WorktreeEntry = Schema.Struct({
  id: WorktreeId,
  repositoryId: RepositoryId,
  path: Schema.String,
  folderName: Schema.String,
  head: WorktreeHeadState,
  isPrimary: Schema.Boolean,
  bare: Schema.Boolean,
  missing: Schema.Boolean,
  lockedReason: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'WorktreeEntry' });
export type WorktreeEntry = typeof WorktreeEntry.Type;

/** Lifecycle state of a Session's binding to a Worktree. */
export const WorktreeBindingState = Schema.Literals([
  'undiscovered',
  'resolved',
  'missing',
]).annotate({ identifier: 'WorktreeBindingState' });
export type WorktreeBindingState = typeof WorktreeBindingState.Type;

/** Why a Session's Worktree binding is currently `undiscovered` or `missing`. */
export const WorktreeBindingReason = Schema.Literals([
  'NotYetDiscovered',
  'MissingPath',
  'ReplacedFolder',
  'UnregisteredWorktree',
  'MissingGit',
  'NonGit',
  'UnsupportedRepo',
]).annotate({ identifier: 'WorktreeBindingReason' });
export type WorktreeBindingReason = typeof WorktreeBindingReason.Type;

/** Persisted and live Session binding to its Git Worktree. */
export const WorktreeBinding = Schema.Struct({
  state: WorktreeBindingState,
  repositoryId: Schema.optionalKey(RepositoryId),
  worktreeId: Schema.optionalKey(WorktreeId),
  expectedPath: Schema.optionalKey(Schema.String),
  lastKnownBranch: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(WorktreeBindingReason),
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'WorktreeBinding' });
export type WorktreeBinding = typeof WorktreeBinding.Type;

/** Git capability and Worktree inventory discovered for a checkout path. */
export const WorktreeInventory = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
  cwd: Schema.String,
  capability: GitCapability,
  repositoryId: Schema.optionalKey(RepositoryId),
  commonDir: Schema.optionalKey(Schema.String),
  currentWorktreeId: Schema.optionalKey(WorktreeId),
  worktrees: Schema.Array(WorktreeEntry),
  refreshedAt: Schema.Number,
}).annotate({ identifier: 'WorktreeInventory' });
export type WorktreeInventory = typeof WorktreeInventory.Type;

/** Starting point selected when creating a new Git Worktree. */
export const WorktreeStartPoint = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal('Head'),
  }),
  Schema.Struct({
    mode: Schema.Literal('Branch'),
    branch: Schema.String,
  }),
]).annotate({ identifier: 'WorktreeStartPoint' });
export type WorktreeStartPoint = typeof WorktreeStartPoint.Type;

/** Existing local branch eligible for direct checkout in a new Worktree (not checked out elsewhere). */
export const WorktreeEligibleBranch = Schema.Struct({
  name: Schema.String,
  commit: Schema.String,
  checkedOut: Schema.Boolean,
}).annotate({ identifier: 'WorktreeEligibleBranch' });
export type WorktreeEligibleBranch = typeof WorktreeEligibleBranch.Type;

/** Machine-readable blocker codes preventing Worktree creation from proceeding safely. */
export const WorktreeCreateBlockerCode = Schema.Literals([
  'MissingGit',
  'NonGit',
  'MissingPath',
  'UnsupportedRepo',
  'BareRepoOnly',
  'UnbornHead',
  'ActiveIntegration',
  'RecoveryRequired',
  'DestinationExists',
  'DestinationInsideSource',
  'UntrustedPath',
  'InvalidBranch',
  'BranchAlreadyExists',
  'BranchCheckedOut',
  'TurnActive',
]).annotate({ identifier: 'WorktreeCreateBlockerCode' });
export type WorktreeCreateBlockerCode = typeof WorktreeCreateBlockerCode.Type;

/** Actionable blocker preventing Worktree creation before mutation starts. */
export const WorktreeCreateBlocker = Schema.Struct({
  code: WorktreeCreateBlockerCode,
  detail: Schema.String,
}).annotate({ identifier: 'WorktreeCreateBlocker' });
export type WorktreeCreateBlocker = typeof WorktreeCreateBlocker.Type;

/** Expiring server-held review snapshot for creating a Git Worktree. */
export const WorktreeCreateReview = Schema.Struct({
  reviewId: ReviewId,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  stale: Schema.Boolean,
  staleReason: Schema.optionalKey(Schema.String),
  repositoryId: RepositoryId,
  sourceWorktreeId: WorktreeId,
  sourcePath: Schema.String,
  sourceHead: WorktreeHeadState,
  sourceDirtyCount: Schema.Number,
  defaultBranch: Schema.String,
  defaultDestination: Schema.String,
  eligibleBranches: Schema.Array(WorktreeEligibleBranch),
  warnings: Schema.Array(Schema.String),
  blockers: Schema.Array(WorktreeCreateBlocker),
  integrationActive: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'WorktreeCreateReview' });
export type WorktreeCreateReview = typeof WorktreeCreateReview.Type;

/** Idempotent request executing Worktree creation against an active `ReviewId`. */
export const CreateWorktreeInput = Schema.Struct({
  reviewId: ReviewId,
  operationId: OperationId,
  sourcePath: Schema.String,
  destinationPath: Schema.String,
  branch: Schema.String,
  startFrom: WorktreeStartPoint,
  projectId: Schema.optionalKey(ProjectId),
}).annotate({ identifier: 'CreateWorktreeInput' });
export type CreateWorktreeInput = typeof CreateWorktreeInput.Type;

/** Durable execution result for `Worktrees.executeCreate`. */
export const CreateWorktreeResult = Schema.Struct({
  operation: OperationSnapshot,
  worktree: Schema.optionalKey(WorktreeEntry),
  inventory: Schema.optionalKey(WorktreeInventory),
}).annotate({ identifier: 'CreateWorktreeResult' });
export type CreateWorktreeResult = typeof CreateWorktreeResult.Type;

/** Tagged error raised across the Worktrees RPC boundary. */
export class WorktreesError extends Schema.TaggedError<WorktreesError>()('WorktreesError', {
  reason: Schema.Literals([
    'MissingGit',
    'NonGit',
    'MissingPath',
    'UnsupportedRepo',
    'RegistryCorrupt',
    'NewerVersion',
    'WorkerFailed',
    'InvalidInput',
    'StaleReview',
    'ReviewExpired',
    'Conflict',
    'Busy',
    'UntrustedPath',
    'RecoveryRequired',
    'NotFound',
  ]),
  detail: Schema.String,
}) {}

/** RPC contract for discovering, refreshing, reviewing, and creating Git Worktrees. */
export class WorktreesRpcs extends RpcGroup.make(
  Rpc.make('Worktrees.inventory', {
    payload: Schema.Struct({
      path: Schema.String,
      projectId: Schema.optionalKey(ProjectId),
    }),
    success: WorktreeInventory,
    error: WorktreesError,
  }),
  Rpc.make('Worktrees.refresh', {
    payload: Schema.Struct({
      path: Schema.String,
      projectId: Schema.optionalKey(ProjectId),
    }),
    success: WorktreeInventory,
    error: WorktreesError,
  }),
  Rpc.make('Worktrees.prepareCreate', {
    payload: Schema.Struct({
      path: Schema.String,
      projectId: Schema.optionalKey(ProjectId),
    }),
    success: WorktreeCreateReview,
    error: WorktreesError,
  }),
  Rpc.make('Worktrees.revalidateCreate', {
    payload: Schema.Struct({
      reviewId: ReviewId,
      sourcePath: Schema.String,
      destinationPath: Schema.String,
      branch: Schema.String,
      startFrom: WorktreeStartPoint,
      projectId: Schema.optionalKey(ProjectId),
    }),
    success: WorktreeCreateReview,
    error: WorktreesError,
  }),
  Rpc.make('Worktrees.executeCreate', {
    payload: CreateWorktreeInput,
    success: CreateWorktreeResult,
    error: WorktreesError,
  }),
  Rpc.make('Worktrees.pickDestination', {
    payload: Schema.Struct({
      defaultPath: Schema.optionalKey(Schema.String),
    }),
    success: Schema.NullOr(Schema.String),
    error: WorktreesError,
  }),
) {}
