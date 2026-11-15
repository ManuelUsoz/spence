import { Clock, Context, Effect, Layer } from 'effect';
import { type SessionError, type SessionId } from '../../src/shared/sessions/sessions.rpc';
import {
  SourceControlError,
  type ChangedFileEntry,
  type CommitDetail,
  type CommitHistorySnapshot,
  type CurrentChangesSnapshot,
  type CurrentChangesSummary,
  type DiffPreview,
  type DiffScope,
} from '../../src/shared/source-control/source-control.rpc';
import {
  type RepositoryId,
  type WorktreeBinding,
  type WorktreeHeadState,
  type WorktreeId,
  type WorktreesError,
} from '../../src/shared/worktrees/worktrees.rpc';
import { SessionStore } from '../sessions/session-store';
import type {
  WorkerCapabilityFailure,
  WorkerChangedFile,
  WorkerHeadState,
} from '../worker/worker-protocol';
import { GitWorker } from '../worktrees/git-client';
import { Worktrees } from '../worktrees/worktrees';

export interface SourceControlShape {
  readonly status: (sessionId: SessionId) => Effect.Effect<CurrentChangesSnapshot, SourceControlError>;
  readonly diff: (
    sessionId: SessionId,
    path: string,
    scope?: DiffScope,
  ) => Effect.Effect<DiffPreview, SourceControlError>;
  readonly commits: (
    sessionId: SessionId,
    limit?: number,
    offset?: number,
  ) => Effect.Effect<CommitHistorySnapshot, SourceControlError>;
  readonly commitDetail: (
    sessionId: SessionId,
    sha: string,
  ) => Effect.Effect<CommitDetail, SourceControlError>;
  readonly commitFileDiff: (
    sessionId: SessionId,
    sha: string,
    path: string,
  ) => Effect.Effect<DiffPreview, SourceControlError>;
}

/** Domain service inspecting current Worktree changes and Git commit history for Sessions. */
export class SourceControl extends Context.Service<SourceControl, SourceControlShape>()(
  'source-control/SourceControl',
) {}

const mapSessionError = (err: SessionError): SourceControlError => {
  switch (err.reason) {
    case 'NotFound':
      return new SourceControlError({ reason: 'NotFound', detail: err.detail });
    case 'WorktreeMissing':
      return new SourceControlError({ reason: 'WorktreeMissing', detail: err.detail });
    case 'Busy':
      return new SourceControlError({ reason: 'Busy', detail: err.detail });
    case 'NewerVersion':
    case 'Unsupported':
    case 'MemoryLost':
    case 'AgentNotInstalled':
    case 'AgentNeedsLogin':
    case 'AgentCantStart':
    case 'ExitUnconfirmed':
      return new SourceControlError({ reason: 'OperationFailed', detail: err.detail });
  }
};

const mapWorktreesError = (err: WorktreesError): SourceControlError => {
  switch (err.reason) {
    case 'MissingGit':
      return new SourceControlError({ reason: 'MissingGit', detail: err.detail });
    case 'NonGit':
      return new SourceControlError({ reason: 'NonGit', detail: err.detail });
    case 'MissingPath':
      return new SourceControlError({ reason: 'MissingPath', detail: err.detail });
    case 'UnsupportedRepo':
      return new SourceControlError({ reason: 'UnsupportedRepo', detail: err.detail });
    case 'WorkerFailed':
      return new SourceControlError({ reason: 'WorkerFailed', detail: err.detail });
    case 'RegistryCorrupt':
    case 'NewerVersion':
      return new SourceControlError({ reason: 'OperationFailed', detail: err.detail });
  }
};

const capabilityFailureToError = (failure: WorkerCapabilityFailure): SourceControlError => {
  switch (failure._tag) {
    case 'MissingGit':
      return new SourceControlError({ reason: 'MissingGit', detail: failure.detail });
    case 'NonGit':
      return new SourceControlError({ reason: 'NonGit', detail: failure.detail });
    case 'MissingPath':
      return new SourceControlError({ reason: 'MissingPath', detail: failure.detail });
    case 'UnsupportedRepo':
      return new SourceControlError({ reason: 'UnsupportedRepo', detail: failure.detail });
  }
};

const toWorktreeHeadState = (head: WorkerHeadState): WorktreeHeadState => {
  switch (head._tag) {
    case 'Branch':
      return {
        _tag: 'Branch',
        branch: head.branch,
        ref: head.ref,
        ...(head.commit === undefined ? {} : { commit: head.commit }),
      };
    case 'Detached':
      return { _tag: 'Detached', commit: head.commit };
    case 'Unborn':
      return { _tag: 'Unborn', branch: head.branch };
  }
};

const toChangedFileEntry = (file: WorkerChangedFile): ChangedFileEntry => ({
  path: file.path,
  ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
  status: file.status,
  indexStatus: file.indexStatus,
  workTreeStatus: file.workTreeStatus,
  staged: file.staged,
  unstaged: file.unstaged,
  hasStagedAndUnstaged: file.hasStagedAndUnstaged,
  stagedNetZeroWorking: file.stagedNetZeroWorking,
  kind: file.kind,
  additions: file.additions,
  deletions: file.deletions,
  ...(file.byteSize === undefined ? {} : { byteSize: file.byteSize }),
  ...(file.unstable === undefined ? {} : { unstable: file.unstable }),
});

const summarizeFiles = (files: ReadonlyArray<ChangedFileEntry>): CurrentChangesSummary => ({
  changedCount: files.length,
  stagedCount: files.filter((f) => f.staged).length,
  unstagedCount: files.filter((f) => f.unstaged).length,
  untrackedCount: files.filter((f) => f.status === 'Untracked').length,
  conflictedCount: files.filter((f) => f.status === 'Conflicted').length,
  additions: files.reduce((sum, f) => sum + (f.additions ?? 0), 0),
  deletions: files.reduce((sum, f) => sum + (f.deletions ?? 0), 0),
});

type ResolvedSessionTarget =
  | {
      readonly _tag: 'Ready';
      readonly cwd: string;
      readonly binding?: WorktreeBinding;
      readonly repositoryId?: RepositoryId;
      readonly worktreeId?: WorktreeId;
    }
  | {
      readonly _tag: 'Unavailable';
      readonly cwd: string;
      readonly binding?: WorktreeBinding;
      readonly state:
        | {
            readonly _tag: 'WorktreeMissing';
            readonly reason: NonNullable<WorktreeBinding['reason']>;
            readonly detail: string;
            readonly expectedPath?: string;
            readonly lastKnownBranch?: string;
          }
        | { readonly _tag: 'MissingGit'; readonly detail: string }
        | { readonly _tag: 'NonGit'; readonly path: string; readonly detail: string }
        | { readonly _tag: 'MissingPath'; readonly path: string; readonly detail: string }
        | { readonly _tag: 'UnsupportedRepo'; readonly path: string; readonly detail: string };
    };

export const layerSourceControl: Layer.Layer<
  SourceControl,
  never,
  SessionStore | Worktrees | GitWorker
> = Layer.effect(
  SourceControl,
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore;
    const worktrees = yield* Worktrees;
    const gitWorker = yield* GitWorker;

    const resolveSessionTarget = Effect.fnUntraced(function* (
      sessionId: SessionId,
    ): Effect.fn.Return<ResolvedSessionTarget, SourceControlError> {
      const meta = yield* sessionStore.meta(sessionId).pipe(Effect.mapError(mapSessionError));
      const targetPath = meta.worktreeBinding?.expectedPath ?? meta.cwd;
      const inventory = yield* worktrees
        .refresh(targetPath, meta.projectId)
        .pipe(Effect.mapError(mapWorktreesError));

      const reconciled =
        meta.worktreeBinding === undefined
          ? undefined
          : worktrees.reconcileBinding(meta.worktreeBinding, meta.cwd, inventory);

      const bindingToExpose = reconciled ?? meta.worktreeBinding;

      if (inventory.capability._tag === 'MissingGit') {
        return {
          _tag: 'Unavailable',
          cwd: targetPath,
          ...(bindingToExpose === undefined ? {} : { binding: bindingToExpose }),
          state: { _tag: 'MissingGit', detail: inventory.capability.detail },
        };
      }

      if (
        reconciled !== undefined &&
        reconciled.state === 'missing' &&
        (meta.worktreeBinding?.worktreeId !== undefined ||
          reconciled.reason === 'ReplacedFolder' ||
          reconciled.reason === 'UnregisteredWorktree')
      ) {
        return {
          _tag: 'Unavailable',
          cwd: targetPath,
          ...(bindingToExpose === undefined ? {} : { binding: bindingToExpose }),
          state: {
            _tag: 'WorktreeMissing',
            reason: reconciled.reason ?? 'MissingPath',
            detail:
              reconciled.detail ??
              'Session Worktree binding could not be verified at its expected folder.',
            ...(reconciled.expectedPath === undefined
              ? {}
              : { expectedPath: reconciled.expectedPath }),
            ...(reconciled.lastKnownBranch === undefined
              ? {}
              : { lastKnownBranch: reconciled.lastKnownBranch }),
          },
        };
      }

      switch (inventory.capability._tag) {
        case 'MissingPath':
        case 'NonGit':
        case 'UnsupportedRepo':
          return {
            _tag: 'Unavailable',
            cwd: targetPath,
            ...(bindingToExpose === undefined ? {} : { binding: bindingToExpose }),
            state: inventory.capability,
          };
        case 'Available': {
          const folder = reconciled?.expectedPath ?? targetPath;
          const worktreeId = reconciled?.worktreeId ?? inventory.currentWorktreeId;
          return {
            _tag: 'Ready',
            cwd: folder,
            ...(bindingToExpose === undefined ? {} : { binding: bindingToExpose }),
            ...(inventory.repositoryId === undefined ? {} : { repositoryId: inventory.repositoryId }),
            ...(worktreeId === undefined ? {} : { worktreeId }),
          };
        }
      }
    });

    const requireReadyTarget = Effect.fnUntraced(function* (sessionId: SessionId) {
      const target = yield* resolveSessionTarget(sessionId);
      if (target._tag === 'Ready') return target;
      switch (target.state._tag) {
        case 'WorktreeMissing':
          return yield* new SourceControlError({
            reason: 'WorktreeMissing',
            detail: target.state.detail,
          });
        case 'MissingGit':
          return yield* new SourceControlError({
            reason: 'MissingGit',
            detail: target.state.detail,
          });
        case 'NonGit':
          return yield* new SourceControlError({
            reason: 'NonGit',
            detail: target.state.detail,
          });
        case 'MissingPath':
          return yield* new SourceControlError({
            reason: 'MissingPath',
            detail: target.state.detail,
          });
        case 'UnsupportedRepo':
          return yield* new SourceControlError({
            reason: 'UnsupportedRepo',
            detail: target.state.detail,
          });
      }
    });

    return {
      status: Effect.fn('SourceControl.status')(function* (sessionId: SessionId) {
        const inspectedAt = yield* Clock.currentTimeMillis;
        const target = yield* resolveSessionTarget(sessionId);
        if (target._tag === 'Unavailable') {
          return {
            sessionId,
            cwd: target.cwd,
            ...(target.binding === undefined ? {} : { binding: target.binding }),
            inspectedAt,
            state: target.state,
          } satisfies CurrentChangesSnapshot;
        }

        const workerRes = yield* gitWorker
          .status(target.cwd)
          .pipe(Effect.mapError(mapWorktreesError));
        if (workerRes._tag !== 'Available') {
          return {
            sessionId,
            cwd: target.cwd,
            ...(target.binding === undefined ? {} : { binding: target.binding }),
            inspectedAt,
            state: workerRes,
          } satisfies CurrentChangesSnapshot;
        }

        const files = workerRes.files.map(toChangedFileEntry);
        return {
          sessionId,
          cwd: target.cwd,
          ...(target.binding === undefined ? {} : { binding: target.binding }),
          inspectedAt,
          state: {
            _tag: 'Available',
            gitVersion: workerRes.gitVersion,
            ...(target.repositoryId === undefined ? {} : { repositoryId: target.repositoryId }),
            ...(target.worktreeId === undefined ? {} : { worktreeId: target.worktreeId }),
            toplevelPath: workerRes.toplevelRealPath,
            head: toWorktreeHeadState(workerRes.head),
            ...(workerRes.aheadBehind === undefined ? {} : { aheadBehind: workerRes.aheadBehind }),
            integration: workerRes.integration,
            hasConflicts: workerRes.hasConflicts,
            unstablePaths: workerRes.unstablePaths,
            ...(workerRes.instabilityDetail === undefined
              ? {}
              : { instabilityDetail: workerRes.instabilityDetail }),
            excludedEntries: workerRes.excludedEntries,
            incompleteDiffCounts: workerRes.incompleteDiffCounts,
            summary: summarizeFiles(files),
            files,
          },
        } satisfies CurrentChangesSnapshot;
      }),

      diff: Effect.fn('SourceControl.diff')(function* (
        sessionId: SessionId,
        filePath: string,
        scope: DiffScope = 'combined',
      ) {
        const target = yield* requireReadyTarget(sessionId);
        const res = yield* gitWorker
          .diff(target.cwd, filePath, scope)
          .pipe(Effect.mapError(mapWorktreesError));
        switch (res._tag) {
          case 'Available':
            return res.preview;
          case 'InvalidPath':
            return yield* new SourceControlError({
              reason: 'InvalidInput',
              detail: res.detail,
            });
          case 'MissingGit':
          case 'MissingPath':
          case 'NonGit':
          case 'UnsupportedRepo':
            return yield* capabilityFailureToError(res);
        }
      }),

      commits: Effect.fn('SourceControl.commits')(function* (
        sessionId: SessionId,
        limit = 30,
        offset = 0,
      ) {
        const target = yield* resolveSessionTarget(sessionId);
        if (target._tag === 'Unavailable') {
          return {
            _tag: 'Unavailable',
            sessionId,
            cwd: target.cwd,
            reason: target.state._tag,
            detail: target.state.detail,
          } satisfies CommitHistorySnapshot;
        }

        const res = yield* gitWorker
          .commits(target.cwd, limit, offset)
          .pipe(Effect.mapError(mapWorktreesError));
        switch (res._tag) {
          case 'Unborn':
            return {
              _tag: 'Unborn',
              sessionId,
              cwd: target.cwd,
              branch: res.branch,
              ref: res.ref,
            } satisfies CommitHistorySnapshot;
          case 'History':
            return {
              _tag: 'History',
              sessionId,
              cwd: target.cwd,
              head: toWorktreeHeadState(res.head),
              commits: res.commits,
              hasMore: res.hasMore,
              ...(res.nextOffset === undefined ? {} : { nextOffset: res.nextOffset }),
            } satisfies CommitHistorySnapshot;
          case 'MissingGit':
          case 'MissingPath':
          case 'NonGit':
          case 'UnsupportedRepo':
            return {
              _tag: 'Unavailable',
              sessionId,
              cwd: target.cwd,
              reason: res._tag,
              detail: res.detail,
            } satisfies CommitHistorySnapshot;
        }
      }),

      commitDetail: Effect.fn('SourceControl.commitDetail')(function* (
        sessionId: SessionId,
        sha: string,
      ) {
        const target = yield* requireReadyTarget(sessionId);
        const res = yield* gitWorker
          .commitDetail(target.cwd, sha)
          .pipe(Effect.mapError(mapWorktreesError));
        switch (res._tag) {
          case 'Commit':
            return {
              sessionId,
              cwd: target.cwd,
              commit: res.commit,
              files: res.files,
              truncatedFiles: res.truncatedFiles,
            } satisfies CommitDetail;
          case 'InvalidCommit':
            return yield* new SourceControlError({
              reason: 'InvalidInput',
              detail: res.detail,
            });
          case 'MissingGit':
          case 'MissingPath':
          case 'NonGit':
          case 'UnsupportedRepo':
            return yield* capabilityFailureToError(res);
        }
      }),

      commitFileDiff: Effect.fn('SourceControl.commitFileDiff')(function* (
        sessionId: SessionId,
        sha: string,
        filePath: string,
      ) {
        const target = yield* requireReadyTarget(sessionId);
        const res = yield* gitWorker
          .commitFileDiff(target.cwd, sha, filePath)
          .pipe(Effect.mapError(mapWorktreesError));
        switch (res._tag) {
          case 'Available':
            return res.preview;
          case 'InvalidCommit':
          case 'InvalidPath':
            return yield* new SourceControlError({
              reason: 'InvalidInput',
              detail: res.detail,
            });
          case 'MissingGit':
          case 'MissingPath':
          case 'NonGit':
          case 'UnsupportedRepo':
            return yield* capabilityFailureToError(res);
        }
      }),
    } satisfies SourceControlShape;
  }),
);
