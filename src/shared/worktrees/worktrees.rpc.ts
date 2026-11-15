import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId } from '../projects/projects.rpc';

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

/** Compact working-tree change counts reported for one discovered Worktree. */
export const WorktreeChangeSummary = Schema.Struct({
  changedFiles: Schema.Number,
  staged: Schema.Number,
  unstaged: Schema.Number,
  untracked: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
}).annotate({ identifier: 'WorktreeChangeSummary' });
export type WorktreeChangeSummary = typeof WorktreeChangeSummary.Type;

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
  changes: Schema.optionalKey(WorktreeChangeSummary),
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
  ]),
  detail: Schema.String,
}) {}

/** Why explicit Worktree Locate could not establish identity and requires explicit rebinding. */
export const WorktreeLocateMismatchReason = Schema.Literals([
  'DifferentRepository',
  'DifferentCheckout',
  'UnregisteredWorktree',
  'ReplacedFolder',
  'NonGit',
  'MissingPath',
  'MissingGit',
  'UnsupportedRepo',
  'NoPriorIdentity',
]).annotate({ identifier: 'WorktreeLocateMismatchReason' });
export type WorktreeLocateMismatchReason = typeof WorktreeLocateMismatchReason.Type;

/** Result of validating and optionally rebinding a target path against a Session's Worktree binding. */
export const WorktreeLocateResult = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Verified'),
    entry: WorktreeEntry,
    binding: WorktreeBinding,
    inventory: WorktreeInventory,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Rebound'),
    binding: WorktreeBinding,
    inventory: WorktreeInventory,
  }),
  Schema.Struct({
    _tag: Schema.Literal('RequiresRebind'),
    mismatchReason: WorktreeLocateMismatchReason,
    candidatePath: Schema.String,
    detail: Schema.String,
    inventory: Schema.optionalKey(WorktreeInventory),
    candidateEntry: Schema.optionalKey(WorktreeEntry),
  }),
]).annotate({ identifier: 'WorktreeLocateResult' });
export type WorktreeLocateResult = typeof WorktreeLocateResult.Type;

/** RPC contract for discovering, refreshing, and locating Git Worktrees. */
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
  Rpc.make('Worktrees.locate', {
    payload: Schema.Struct({
      expectedBinding: WorktreeBinding,
      targetPath: Schema.String,
      projectId: Schema.optionalKey(ProjectId),
      allowRebind: Schema.optionalKey(Schema.Boolean),
    }),
    success: WorktreeLocateResult,
    error: WorktreesError,
  }),
) {}
