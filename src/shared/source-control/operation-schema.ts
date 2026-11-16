import { Schema } from 'effect';
import { Timestamp } from '../projects/projects.rpc';

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

/** Source Control durable operation kinds. Extend cleanly across Wave 2 slices. */
export const OperationKind = Schema.Literals([
  'Worktree.create',
  'SourceControl.commit',
  'Files.create',
  'Files.rename',
  'Files.delete',
]).annotate({
  identifier: 'OperationKind',
});
export type OperationKind = typeof OperationKind.Type;

/** Durable journal lifecycle phases for serialized Source Control mutations. */
export const OperationPhase = Schema.Literals([
  'Prepared',
  'Applying',
  'NeedsRecovery',
  'LocalRestored',
  'TranscriptFinalizing',
  'Completed',
]).annotate({ identifier: 'OperationPhase' });
export type OperationPhase = typeof OperationPhase.Type;

/** Outcome settled (or left open for recovery) by a Source Control operation. */
export const OperationOutcome = Schema.Literals([
  'Succeeded',
  'Partial',
  'Failed',
  'Cancelled',
  'Unknown',
  'NeedsRecovery',
]).annotate({ identifier: 'OperationOutcome' });
export type OperationOutcome = typeof OperationOutcome.Type;

/** Per-path outcome retained when a file operation stops after some work. */
export const OperationPathResult = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(['Completed', 'Failed', 'Untouched']),
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'OperationPathResult' });
export type OperationPathResult = typeof OperationPathResult.Type;

/** Progress checkpoints reported while a durable Source Control operation executes. */
export const OperationProgressStep = Schema.Literals([
  'Validating',
  'Reserving',
  'Preparing',
  'ExecutingGit',
  'VerifyingPostconditions',
  'RefreshingInventory',
  'Reconciling',
  'Done',
]).annotate({ identifier: 'OperationProgressStep' });
export type OperationProgressStep = typeof OperationProgressStep.Type;

/** Latest progress detail emitted for an in-flight or reconciled operation. */
export const OperationProgress = Schema.Struct({
  step: OperationProgressStep,
  detail: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'OperationProgress' });
export type OperationProgress = typeof OperationProgress.Type;

/** Inspected repository/filesystem facts surfaced when an operation needs recovery or reconciliation. */
export const OperationRecoveryState = Schema.Struct({
  summary: Schema.String,
  detail: Schema.String,
  observedFolderExists: Schema.optionalKey(Schema.Boolean),
  observedRegisteredInGit: Schema.optionalKey(Schema.Boolean),
  observedBranchExists: Schema.optionalKey(Schema.Boolean),
  observedClean: Schema.optionalKey(Schema.Boolean),
  observedHeadCommit: Schema.optionalKey(Schema.String),
  observedBranch: Schema.optionalKey(Schema.String),
  canReconcile: Schema.Boolean,
  canDismiss: Schema.Boolean,
}).annotate({ identifier: 'OperationRecoveryState' });
export type OperationRecoveryState = typeof OperationRecoveryState.Type;

/** Commit identity and reconciliation facts recorded without assuming an interrupted Git operation succeeded. */
export const CommitOperationResult = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('Committed'), commit: Schema.String }),
  Schema.Struct({
    _tag: Schema.Literal('Unknown'),
    detail: Schema.String,
    observedHead: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.Literal('Partial'),
    detail: Schema.String,
    commit: Schema.optionalKey(Schema.String),
  }),
]);
export type CommitOperationResult = typeof CommitOperationResult.Type;

/** Renderer-facing durable state snapshot for one Source Control operation. */
export const OperationSnapshot = Schema.Struct({
  id: OperationId,
  kind: OperationKind,
  title: Schema.String,
  repositoryKey: Schema.optionalKey(Schema.String),
  sourcePath: Schema.optionalKey(Schema.String),
  targetPath: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  phase: OperationPhase,
  outcome: Schema.optionalKey(OperationOutcome),
  pathResults: Schema.optionalKey(Schema.Array(OperationPathResult)),
  progress: Schema.optionalKey(OperationProgress),
  warnings: Schema.Array(Schema.String),
  recovery: Schema.optionalKey(OperationRecoveryState),
  commitResult: Schema.optionalKey(CommitOperationResult),
  errorReason: Schema.optionalKey(Schema.String),
  errorDetail: Schema.optionalKey(Schema.String),
  unknownReason: Schema.optionalKey(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).annotate({ identifier: 'OperationSnapshot' });
export type OperationSnapshot = typeof OperationSnapshot.Type;
