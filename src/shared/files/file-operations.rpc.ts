import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { Timestamp } from '../projects/projects.rpc';
import { OperationId, OperationSnapshot, ReviewId } from '../source-control/source-control.rpc';
import { FilesRootTarget } from './files.rpc';

/** What kind of filesystem entry a create operation prepares. */
export const FileOperationCreateKind = Schema.Literals(['file', 'folder']).annotate({
  identifier: 'FileOperationCreateKind',
});
export type FileOperationCreateKind = typeof FileOperationCreateKind.Type;

/** Reasons a file operation review can be blocked before execution. */
export const FileOperationBlockerCode = Schema.Literals([
  'ProtectedPath',
  'OutsideRoot',
  'Traversal',
  'NestedRepo',
  'SpecialFile',
  'DestinationInsideSource',
  'TargetMissing',
  'TargetExists',
  'RecoveryRequired',
  'Busy',
]).annotate({ identifier: 'FileOperationBlockerCode' });
export type FileOperationBlockerCode = typeof FileOperationBlockerCode.Type;

/** One blocker preventing a file operation from proceeding. */
export const FileOperationBlocker = Schema.Struct({
  code: FileOperationBlockerCode,
  detail: Schema.String,
}).annotate({ identifier: 'FileOperationBlocker' });
export type FileOperationBlocker = typeof FileOperationBlocker.Type;

/** One affected target in a reviewed file operation. */
export const FileOperationReviewTarget = Schema.Struct({
  /** Normalized relative path inside the workspace root. */
  path: Schema.String,
  /** Entry kind relevant to the operation. */
  kind: Schema.Literals([
    'file',
    'directory',
    'symlink',
    'nestedRepo',
    'special',
    'missing',
    'unreadable',
  ]),
  /** Whether the target already exists on disk at review time. */
  exists: Schema.Boolean,
  /** Whether this target will be sent to trash if execution proceeds. */
  willBeTrashed: Schema.Boolean,
  /** Whether this target will be permanently overwritten or removed. */
  willBePermanentlyRemoved: Schema.Boolean,
  /** For renames, the reviewed destination path. */
  destinationPath: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'FileOperationReviewTarget' });
export type FileOperationReviewTarget = typeof FileOperationReviewTarget.Type;

/** Expiring review snapshot for a create, rename or delete operation. */
export const FileOperationReview = Schema.Struct({
  reviewId: ReviewId,
  issuedAt: Timestamp,
  expiresAt: Timestamp,
  /** Durable operation kind this review authorizes. */
  kind: Schema.Literals(['Files.create', 'Files.rename', 'Files.delete']),
  /** Affected targets, in deterministic path order. */
  targets: Schema.Array(FileOperationReviewTarget),
  warnings: Schema.Array(Schema.String),
  blockers: Schema.Array(FileOperationBlocker),
  /** When true, trash is unavailable and the user must explicitly confirm permanent removal. */
  requiresPermanentConfirmation: Schema.Boolean,
}).annotate({ identifier: 'FileOperationReview' });
export type FileOperationReview = typeof FileOperationReview.Type;

/** Tagged error for the FileOperations RPC domain. */
export class FileOperationsError extends Schema.TaggedError<FileOperationsError>()(
  'FileOperationsError',
  {
    reason: Schema.Literals([
      'NotFound',
      'OutsideRoot',
      'ProtectedPath',
      'UnsupportedFile',
      'Conflict',
      'Busy',
      'StaleReview',
      'ReviewExpired',
      'TrashUnavailable',
      'PermanentDeleteRequired',
      'RecoveryRequired',
      'WorkerFailed',
      'IoFailed',
      'InvalidInput',
    ]),
    detail: Schema.String,
  },
) {}

/** RPC contract for reviewed, durable create/rename/delete file operations. */
export class FileOperationRpcs extends RpcGroup.make(
  Rpc.make('FileOperations.reviewCreate', {
    payload: {
      target: FilesRootTarget,
      dirPath: Schema.String,
      name: Schema.String,
      kind: FileOperationCreateKind,
    },
    success: FileOperationReview,
    error: FileOperationsError,
  }),
  Rpc.make('FileOperations.reviewRename', {
    payload: {
      target: FilesRootTarget,
      relativePath: Schema.String,
      newName: Schema.String,
      allowOverwrite: Schema.optionalKey(Schema.Boolean),
    },
    success: FileOperationReview,
    error: FileOperationsError,
  }),
  Rpc.make('FileOperations.reviewDelete', {
    payload: {
      target: FilesRootTarget,
      relativePaths: Schema.Array(Schema.String),
      permanent: Schema.optionalKey(Schema.Boolean),
    },
    success: FileOperationReview,
    error: FileOperationsError,
  }),
  Rpc.make('FileOperations.execute', {
    payload: {
      reviewId: ReviewId,
      operationId: OperationId,
      allowPermanentDelete: Schema.optionalKey(Schema.Boolean),
    },
    success: OperationSnapshot,
    error: FileOperationsError,
  }),
) {}
