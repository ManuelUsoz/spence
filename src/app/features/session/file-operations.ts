import { Effect } from 'effect';
import {
  type FileOperationBlockerCode,
  type FileOperationCreateKind,
  type FileOperationReview,
} from '../../../shared/files/file-operations.rpc';
import type { FilesRootTarget } from '../../../shared/files/files.rpc';
import {
  OperationId,
  type OperationPathResult,
  type OperationSnapshot,
} from '../../../shared/source-control/source-control.rpc';
import { DesktopApi } from '../../core/desktop-api';

/** Generates a short operation id tied to a review for file mutations. */
export const makeFileOperationId = (reviewId: string): typeof OperationId.Type =>
  OperationId.make(`file-op-${reviewId}`);

/** Requests a review for creating a file or folder. */
export const reviewCreateFile = Effect.fnUntraced(function* (input: {
  readonly target: FilesRootTarget;
  readonly dirPath: string;
  readonly name: string;
  readonly kind: FileOperationCreateKind;
}) {
  const api = yield* DesktopApi;
  return yield* api['FileOperations.reviewCreate'](input);
});

/** Requests a review for renaming a file or folder. */
export const reviewRenameFile = Effect.fnUntraced(function* (input: {
  readonly target: FilesRootTarget;
  readonly relativePath: string;
  readonly newName: string;
}) {
  const api = yield* DesktopApi;
  return yield* api['FileOperations.reviewRename'](input);
});

/** Requests a review for deleting one or more files or folders. */
export const reviewDeleteFiles = Effect.fnUntraced(function* (input: {
  readonly target: FilesRootTarget;
  readonly relativePaths: ReadonlyArray<string>;
  readonly permanent?: boolean;
}) {
  const api = yield* DesktopApi;
  return yield* api['FileOperations.reviewDelete']({
    target: input.target,
    relativePaths: input.relativePaths,
    ...(input.permanent === undefined ? {} : { permanent: input.permanent }),
  });
});

/** Executes a reviewed file operation durably. */
export const executeFileOperation = Effect.fnUntraced(function* (input: {
  readonly review: FileOperationReview;
  readonly allowPermanentDelete?: boolean;
}) {
  const api = yield* DesktopApi;
  return yield* api['FileOperations.execute']({
    reviewId: input.review.reviewId,
    operationId: makeFileOperationId(input.review.reviewId),
    ...(input.allowPermanentDelete === undefined
      ? {}
      : { allowPermanentDelete: input.allowPermanentDelete }),
  });
});

/** True when the snapshot represents a finished file operation. */
export const isFileOperationComplete = (snapshot: OperationSnapshot): boolean =>
  snapshot.phase === 'Completed' || snapshot.phase === 'NeedsRecovery';

/** Localized label for a per-path operation outcome. */
export const formatPathResultStatus = (status: OperationPathResult['status']): string => {
  switch (status) {
    case 'Completed':
      return $localize`Completed`;
    case 'Failed':
      return $localize`Failed`;
    case 'Untouched':
      return $localize`Untouched`;
  }
};

/** Localized label for a file operation dialog title. */
export const fileOperationTitle = (kind: FileOperationReview['kind']): string => {
  switch (kind) {
    case 'Files.create':
      return $localize`Create file`;
    case 'Files.rename':
      return $localize`Rename`;
    case 'Files.delete':
      return $localize`Delete`;
  }
};

/** Formats a file operation blocker for display in the UI. */
export const formatFileOperationBlocker = (
  code: FileOperationBlockerCode,
  detail: string,
): string => {
  switch (code) {
    case 'ProtectedPath':
      return $localize`Protected path: ${detail}`;
    case 'OutsideRoot':
      return $localize`Path is outside the workspace: ${detail}`;
    case 'Traversal':
      return $localize`Path traversal is not allowed: ${detail}`;
    case 'NestedRepo':
      return $localize`Nested Git repositories cannot be modified: ${detail}`;
    case 'SpecialFile':
      return $localize`Special files are unsupported: ${detail}`;
    case 'DestinationInsideSource':
      return $localize`Destination cannot be inside source: ${detail}`;
    case 'TargetMissing':
      return $localize`Path does not exist: ${detail}`;
    case 'TargetExists':
      return $localize`Path already exists: ${detail}`;
    case 'RecoveryRequired':
      return $localize`Resolve pending recovery first: ${detail}`;
    case 'Busy':
      return $localize`Target is busy: ${detail}`;
  }
};
