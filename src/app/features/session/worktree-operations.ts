import { Cause, Effect, Option, Predicate, Stream } from 'effect';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  type OperationId,
  type OperationProgressStep,
  type OperationSnapshot,
  type ReviewId,
  SourceControlError,
} from '../../../shared/source-control/source-control.rpc';
import {
  type CreateWorktreeInput,
  type WorktreeCreateBlocker,
  type WorktreeCreateBlockerCode,
  WorktreesError,
  type WorktreeStartPoint,
} from '../../../shared/worktrees/worktrees.rpc';
import { DesktopApi } from '../../core/desktop-api';

/** Prepares an expiring review and defaults for creating a Git Worktree from `path`. */
export const prepareCreateWorktree = Effect.fnUntraced(function* (
  path: string,
  projectId?: ProjectId,
) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.prepareCreate'](
    projectId === undefined ? { path } : { path, projectId },
  );
});

/** Revalidates a Worktree creation review against updated branch, destination, or repository state. */
export const revalidateCreateWorktree = Effect.fnUntraced(function* (input: {
  readonly reviewId: ReviewId;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly branch: string;
  readonly startFrom: WorktreeStartPoint;
  readonly projectId?: ProjectId;
}) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.revalidateCreate'](input);
});

/** Executes Worktree creation durably against a previously issued `ReviewId`. */
export const executeCreateWorktree = Effect.fnUntraced(function* (input: CreateWorktreeInput) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.executeCreate'](input);
});

/** Opens the native folder picker to choose a destination directory for a new Worktree. */
export const pickWorktreeDestination = Effect.fnUntraced(function* (defaultPath?: string) {
  const api = yield* DesktopApi;
  return yield* api['Worktrees.pickDestination'](defaultPath === undefined ? {} : { defaultPath });
});

/** Lists persisted or active Source Control operations matching an optional filter. */
export const listSourceControlOperations = Effect.fnUntraced(function* (filter: {
  readonly repositoryKey?: string;
  readonly sourcePath?: string;
}) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.listOperations'](filter);
});

/** Streams live Source Control operation updates, invoking `onSnapshot` per event. */
export const followSourceControlOperations = Effect.fnUntraced(function* (
  onSnapshot: (snapshot: OperationSnapshot) => void,
) {
  const api = yield* DesktopApi;
  yield* api['SourceControl.operationEvents'](undefined).pipe(
    Stream.runForEach((snapshot) =>
      Effect.sync(() => {
        onSnapshot(snapshot);
      }),
    ),
  );
});

/** Triggers postcondition reconciliation for an interrupted or unknown operation. */
export const reconcileSourceControlOperation = Effect.fnUntraced(function* (
  operationId: OperationId,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.reconcileOperation']({ operationId });
});

/** Dismisses a `NeedsRecovery` operation after inspection so locks are released cleanly. */
export const dismissSourceControlOperation = Effect.fnUntraced(function* (
  operationId: OperationId,
) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.dismissOperation']({ operationId });
});

/** Requests cancellation for a queued/prepared Source Control operation before mutation begins. */
export const cancelSourceControlOperation = Effect.fnUntraced(function* (operationId: OperationId) {
  const api = yield* DesktopApi;
  return yield* api['SourceControl.cancelOperation']({ operationId });
});

/** Sanitizes a branch name into the sibling directory slug used by Worktree creation. */
export const sanitizeBranchSlug = (branch: string): string =>
  branch
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'worktree';

/** Derives the default sibling destination path when the user edits Branch before customizing folder. */
export const deriveSuggestedDestination = (
  sourcePath: string,
  defaultDestination: string,
  branch: string,
): string => {
  const slug = sanitizeBranchSlug(branch);
  const lastSep = Math.max(
    defaultDestination.lastIndexOf('/'),
    defaultDestination.lastIndexOf('\\'),
  );
  const parentDir = lastSep >= 0 ? defaultDestination.slice(0, lastSep + 1) : '';
  const sourceBase =
    sourcePath
      .split(/[/\\]/)
      .filter((segment) => segment.length > 0)
      .at(-1) ?? 'worktree';
  return `${parentDir}${sourceBase}-${slug}`;
};

/** Maps a durable `OperationProgressStep` into a localized user-facing label. */
export const progressStepLabel = (step: OperationProgressStep): string => {
  switch (step) {
    case 'Validating':
      return $localize`Validating`;
    case 'Reserving':
      return $localize`Reserving target`;
    case 'Preparing':
      return $localize`Preparing review`;
    case 'ExecutingGit':
      return $localize`Creating Worktree`;
    case 'VerifyingPostconditions':
      return $localize`Verifying result`;
    case 'RefreshingInventory':
      return $localize`Updating Worktrees`;
    case 'Reconciling':
      return $localize`Reconciling state`;
    case 'Done':
      return $localize`Finished`;
  }
};

/** Maps a durable `OperationProgressStep` into a monotonic percentage for `<hlm-progress>`. */
export const progressStepPercent = (step: OperationProgressStep): number => {
  switch (step) {
    case 'Validating':
      return 15;
    case 'Reserving':
      return 30;
    case 'Preparing':
      return 45;
    case 'ExecutingGit':
      return 65;
    case 'VerifyingPostconditions':
      return 85;
    case 'RefreshingInventory':
      return 95;
    case 'Reconciling':
      return 70;
    case 'Done':
      return 100;
  }
};

/** Formats a server blocker code cleanly while falling back to the structured server detail. */
export const blockerHeadline = (code: WorktreeCreateBlockerCode): string => {
  switch (code) {
    case 'MissingGit':
      return $localize`Git is unavailable`;
    case 'NonGit':
      return $localize`Folder is not a Git repository`;
    case 'MissingPath':
      return $localize`Source folder does not exist`;
    case 'UnsupportedRepo':
      return $localize`Unsupported Git repository`;
    case 'BareRepoOnly':
      return $localize`Bare repositories cannot create a Worktree from HEAD`;
    case 'UnbornHead':
      return $localize`Current checkout has no commits yet`;
    case 'ActiveIntegration':
      return $localize`Finish or abort the active Git operation first`;
    case 'RecoveryRequired':
      return $localize`Pending operation recovery must be resolved first`;
    case 'DestinationExists':
      return $localize`Destination folder already exists and is not empty`;
    case 'DestinationInsideSource':
      return $localize`Destination cannot lie inside an existing Worktree`;
    case 'UntrustedPath':
      return $localize`Destination path is not allowed`;
    case 'InvalidBranch':
      return $localize`Branch name is invalid for Git`;
    case 'BranchAlreadyExists':
      return $localize`Branch already exists`;
    case 'BranchCheckedOut':
      return $localize`Branch is already checked out in another Worktree`;
    case 'TurnActive':
      return $localize`Wait for active Turns on this target to finish`;
  }
};

/** Formats a blocker for display, pairing localized headline with backend diagnostic detail. */
export const formatBlockerLine = (blocker: WorktreeCreateBlocker): string =>
  `${blockerHeadline(blocker.code)}: ${blocker.detail}`;

/** Extracts typed RPC failure reason and detail from an Effect `Exit.Failure` cause. */
export const extractTypedRpcError = (
  cause: Cause.Cause<unknown>,
): { readonly tag: string; readonly reason?: string; readonly detail: string } | null => {
  const errOpt = Cause.findErrorOption(cause);
  if (Option.isNone(errOpt)) return null;
  const err = errOpt.value;
  if (err instanceof WorktreesError || err instanceof SourceControlError) {
    return { tag: err._tag, reason: err.reason, detail: err.detail };
  }
  if (Predicate.isTagged('WorktreesError')(err) || Predicate.isTagged('SourceControlError')(err)) {
    const record = err as unknown as {
      readonly _tag: string;
      readonly reason?: string;
      readonly detail?: string;
    };
    return {
      tag: record._tag,
      ...(typeof record.reason === 'string' ? { reason: record.reason } : {}),
      detail: typeof record.detail === 'string' ? record.detail : '',
    };
  }
  return null;
};

/** Upserts an operation snapshot into an immutable descending-by-update array. */
export const upsertOperationSnapshot = (
  list: ReadonlyArray<OperationSnapshot>,
  next: OperationSnapshot,
): ReadonlyArray<OperationSnapshot> => {
  const filtered = list.filter((item) => item.id !== next.id);
  return [next, ...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
};
