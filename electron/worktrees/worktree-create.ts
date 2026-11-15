import { Cause, Context, Effect, Layer } from 'effect';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  type OperationRecoveryState,
  type ReviewId,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';
import {
  type CreateWorktreeInput,
  type CreateWorktreeResult,
  type RepositoryId,
  type WorktreeCreateBlocker,
  type WorktreeCreateReview,
  type WorktreeEntry,
  type WorktreeHeadState,
  type WorktreeId,
  type WorktreeInventory,
  type WorktreeStartPoint,
  WorktreesError,
} from '../../src/shared/worktrees/worktrees.rpc';
import { PathSources } from '../agents/merged-path';
import { folderKey } from '../projects/folder-key';
import {
  type DurableOperationRecord,
  Operations,
  type OperationReconciliationOutcome,
} from '../source-control/operations';
import { ReservationCoordinator, reservationKeys } from '../source-control/reservation-coordinator';
import { ReviewRegistry } from '../source-control/review-registry';
import { isSafeStoreId } from '../store/durable';
import type {
  GitCreateContextResult,
  GitPostWorktreeCreateInspection,
} from '../worker/worker-protocol';
import { GitWorker } from './git-client';
import { Worktrees } from './worktrees';

interface CreateWorktreeReviewPayload {
  readonly repositoryId: RepositoryId;
  readonly commonDirRealPath: string;
  readonly commonDirIdentity: string | null;
  readonly sourceWorktreeId: WorktreeId;
  readonly sourceWorktreePath: string;
  readonly head: GitCreateContextAvailable['head'];
  readonly integrationActive: string | null;
  readonly branchesDigest: string;
  readonly worktreePathsKey: ReadonlyArray<string>;
  readonly targetBound?: {
    readonly destinationKey: string;
    readonly destinationExists: boolean;
    readonly destinationIsEmpty: boolean | null;
    readonly branch: string;
    readonly startFrom: WorktreeStartPoint;
  };
}

type GitCreateContextAvailable = Extract<GitCreateContextResult, { readonly _tag: 'Available' }>;

export interface WorktreeCreateShape {
  readonly prepareCreate: (input: {
    readonly path: string;
    readonly projectId?: ProjectId;
  }) => Effect.Effect<WorktreeCreateReview, WorktreesError>;
  readonly revalidateCreate: (input: {
    readonly reviewId?: ReviewId;
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly branch: string;
    readonly startFrom: WorktreeStartPoint;
    readonly projectId?: ProjectId;
  }) => Effect.Effect<WorktreeCreateReview, WorktreesError>;
  readonly executeCreate: (
    input: CreateWorktreeInput,
  ) => Effect.Effect<CreateWorktreeResult, WorktreesError>;
}

/** Domain service coordinating reviewable, durable Worktree creation (`#100`). */
export class WorktreeCreate extends Context.Service<WorktreeCreate, WorktreeCreateShape>()(
  'worktrees/WorktreeCreate',
) {}

const FORBIDDEN_BRANCH_CHARS = new Set(['~', '^', ':', '?', '*', '[', ']', '\\']);

const hasUnsafeBranchChar = (branch: string): boolean => {
  for (let i = 0; i < branch.length; i += 1) {
    const code = branch.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
    if (FORBIDDEN_BRANCH_CHARS.has(branch.charAt(i))) return true;
  }
  return false;
};

const isSyntacticallyValidBranch = (branch: string): boolean => {
  if (branch.length === 0 || branch.length > 240) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.startsWith('.') || branch.endsWith('.')) return false;
  if (branch === '@' || branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return false;
  }
  if (hasUnsafeBranchChar(branch)) return false;
  for (const part of branch.split('/')) {
    if (part.length === 0 || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
};

const hasGitSegment = (targetPath: string): boolean =>
  path
    .resolve(targetPath)
    .split(/[\\/]+/)
    .some((segment) => segment.toLowerCase() === '.git');

const sanitizeBranchForFolder = (branch: string): string =>
  branch
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '') || 'worktree';

const sha256Hex = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const toWorktreeHeadState = (head: GitCreateContextAvailable['head']): WorktreeHeadState => {
  switch (head._tag) {
    case 'Branch':
      return {
        _tag: 'Branch',
        branch: head.branch,
        ref: `refs/heads/${head.branch}`,
        commit: head.commit,
      };
    case 'Detached':
      return { _tag: 'Detached', commit: head.commit };
    case 'Unborn':
      return { _tag: 'Unborn', branch: head.branch ?? 'HEAD' };
  }
};

const mapSourceControlError = (err: SourceControlError): WorktreesError => {
  switch (err.reason) {
    case 'MissingGit':
      return new WorktreesError({ reason: 'MissingGit', detail: err.detail });
    case 'NonGit':
      return new WorktreesError({ reason: 'NonGit', detail: err.detail });
    case 'MissingPath':
      return new WorktreesError({ reason: 'MissingPath', detail: err.detail });
    case 'UnsupportedRepo':
      return new WorktreesError({ reason: 'UnsupportedRepo', detail: err.detail });
    case 'InvalidInput':
      return new WorktreesError({ reason: 'InvalidInput', detail: err.detail });
    case 'StaleReview':
      return new WorktreesError({ reason: 'StaleReview', detail: err.detail });
    case 'ReviewExpired':
      return new WorktreesError({ reason: 'ReviewExpired', detail: err.detail });
    case 'Conflict':
      return new WorktreesError({ reason: 'Conflict', detail: err.detail });
    case 'Busy':
      return new WorktreesError({ reason: 'Busy', detail: err.detail });
    case 'UntrustedPath':
      return new WorktreesError({ reason: 'UntrustedPath', detail: err.detail });
    case 'RecoveryRequired':
      return new WorktreesError({ reason: 'RecoveryRequired', detail: err.detail });
    case 'NotFound':
      return new WorktreesError({ reason: 'NotFound', detail: err.detail });
    case 'WorkerFailed':
    case 'OperationFailed':
      return new WorktreesError({ reason: 'WorkerFailed', detail: err.detail });
  }
};

const toSourceControlError = (err: WorktreesError): SourceControlError => {
  switch (err.reason) {
    case 'MissingGit':
      return new SourceControlError({ reason: 'MissingGit', detail: err.detail });
    case 'NonGit':
      return new SourceControlError({ reason: 'NonGit', detail: err.detail });
    case 'MissingPath':
      return new SourceControlError({ reason: 'MissingPath', detail: err.detail });
    case 'UnsupportedRepo':
      return new SourceControlError({ reason: 'UnsupportedRepo', detail: err.detail });
    case 'InvalidInput':
      return new SourceControlError({ reason: 'InvalidInput', detail: err.detail });
    case 'StaleReview':
      return new SourceControlError({ reason: 'StaleReview', detail: err.detail });
    case 'ReviewExpired':
      return new SourceControlError({ reason: 'ReviewExpired', detail: err.detail });
    case 'Conflict':
      return new SourceControlError({ reason: 'Conflict', detail: err.detail });
    case 'Busy':
      return new SourceControlError({ reason: 'Busy', detail: err.detail });
    case 'UntrustedPath':
      return new SourceControlError({ reason: 'UntrustedPath', detail: err.detail });
    case 'RecoveryRequired':
      return new SourceControlError({ reason: 'RecoveryRequired', detail: err.detail });
    case 'NotFound':
      return new SourceControlError({ reason: 'NotFound', detail: err.detail });
    case 'RegistryCorrupt':
    case 'NewerVersion':
    case 'WorkerFailed':
      return new SourceControlError({ reason: 'WorkerFailed', detail: err.detail });
  }
};

const buildRecoveryState = (
  post: GitPostWorktreeCreateInspection,
  destinationPath: string,
  branch: string,
  expectedCommit: string | null,
): OperationRecoveryState => {
  const fullMatch =
    post.repoAvailable &&
    post.folderExists &&
    post.registeredInGit &&
    post.registeredBranch === branch &&
    post.clean === true &&
    (expectedCommit === null || post.headCommit === expectedCommit);

  let summary: string;
  let detail: string;
  if (fullMatch) {
    summary = 'Worktree creation appears complete and can be verified cleanly.';
    detail = `Directory ${destinationPath} exists on disk and is registered cleanly in Git on branch ${branch}.`;
  } else if (post.folderExists && !post.registeredInGit) {
    summary = 'Destination folder exists on disk without a Git Worktree registration.';
    detail = `Directory ${destinationPath} exists (${post.folderEmpty ? 'empty' : 'non-empty'}) and is not registered in Git. Inspect or clean up before retrying.`;
  } else if (!post.folderExists && post.branchExists) {
    summary = `Branch "${branch}" exists, but destination folder is missing.`;
    detail = `Git created branch "${branch}" without a corresponding directory at ${destinationPath}.`;
  } else if (post.registeredInGit && post.clean === false) {
    summary = 'Created Worktree has unexpected uncommitted changes or wrong state.';
    detail = `Worktree at ${destinationPath} is registered on "${post.registeredBranch ?? 'unknown'}", but working tree is dirty or mismatched.`;
  } else if (!post.folderExists && !post.registeredInGit && !post.branchExists) {
    summary = 'Operation stopped before creating files or branches; safe to dismiss.';
    detail = post.detail;
  } else {
    summary = 'Worktree creation left partial or mismatched state requiring inspection.';
    detail = post.detail;
  }

  return {
    summary,
    detail,
    observedFolderExists: post.folderExists,
    observedRegisteredInGit: post.registeredInGit,
    observedBranchExists: post.branchExists,
    ...(post.clean === null ? {} : { observedClean: post.clean }),
    ...(post.headCommit === null ? {} : { observedHeadCommit: post.headCommit }),
    ...(post.registeredBranch === null ? {} : { observedBranch: post.registeredBranch }),
    canReconcile: true,
    canDismiss: true,
  };
};

const pathExistsAsync = async (targetPath: string): Promise<boolean> => {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
};

const isWorkerCrashDetail = (detail: string): boolean => {
  const lower = detail.toLowerCase();
  return (
    lower.includes('exited unexpectedly') ||
    lower.includes('timed out waiting for source control worker') ||
    lower.includes('worker has stopped')
  );
};

/** Live Worktree creation domain layer built over the shared Source Control foundation. */
export const layerWorktreeCreate: Layer.Layer<
  WorktreeCreate,
  never,
  Worktrees | GitWorker | PathSources | ReviewRegistry | ReservationCoordinator | Operations
> = Layer.effect(
  WorktreeCreate,
  Effect.gen(function* () {
    const worktrees = yield* Worktrees;
    const gitWorker = yield* GitWorker;
    const pathSources = yield* PathSources;
    const reviewRegistry = yield* ReviewRegistry;
    const coordinator = yield* ReservationCoordinator;
    const operations = yield* Operations;

    const platform = pathSources.platform;

    const requireAvailableContext = Effect.fnUntraced(function* (
      sourcePath: string,
      options?: { readonly destinationPath?: string; readonly branch?: string },
    ) {
      const ctx = yield* gitWorker.inspectCreateContext(sourcePath, options);
      switch (ctx._tag) {
        case 'Available':
          return ctx;
        case 'MissingGit':
          return yield* new WorktreesError({ reason: 'MissingGit', detail: ctx.detail });
        case 'NonGit':
          return yield* new WorktreesError({ reason: 'NonGit', detail: ctx.detail });
        case 'MissingPath':
          return yield* new WorktreesError({ reason: 'MissingPath', detail: ctx.detail });
        case 'UnsupportedRepo':
          return yield* new WorktreesError({ reason: 'UnsupportedRepo', detail: ctx.detail });
      }
    });

    const resolveRepoIdentity = Effect.fnUntraced(function* (
      sourcePath: string,
      ctx: GitCreateContextAvailable,
      projectId?: ProjectId,
    ) {
      const inv = yield* worktrees.refresh(sourcePath, projectId);
      if (inv.capability._tag !== 'Available') {
        return yield* new WorktreesError({
          reason:
            inv.capability._tag === 'MissingGit'
              ? 'MissingGit'
              : inv.capability._tag === 'NonGit'
                ? 'NonGit'
                : inv.capability._tag === 'MissingPath'
                  ? 'MissingPath'
                  : 'UnsupportedRepo',
          detail: inv.capability.detail,
        });
      }
      const sourceKey = folderKey(ctx.worktreeRealPath, platform);
      const sourceEntry =
        inv.worktrees.find((w) => folderKey(w.path, platform) === sourceKey) ?? inv.worktrees[0];
      if (sourceEntry === undefined) {
        return yield* new WorktreesError({
          reason: 'UnsupportedRepo',
          detail: 'Unable to locate active checkout in Repository inventory.',
        });
      }
      return {
        inventory: inv,
        repositoryId: inv.repositoryId ?? sourceEntry.repositoryId,
        sourceWorktree: sourceEntry,
      };
    });

    const deriveDefaults = Effect.fnUntraced(function* (ctx: GitCreateContextAvailable) {
      const existingBranches = new Set(ctx.branches.map((b) => b.name));
      const existingWorktreeKeys = new Set(ctx.worktreePaths.map((p) => folderKey(p, platform)));
      const sourceDir = ctx.worktreeRealPath;
      const baseName = path.basename(sourceDir) || 'repo';
      const parentDir = path.dirname(sourceDir);

      for (let index = 1; index <= 999; index += 1) {
        const branch = `worktree-${index}`;
        if (existingBranches.has(branch)) continue;
        const candidateDest = path.join(
          parentDir,
          `${baseName}-${sanitizeBranchForFolder(branch)}`,
        );
        if (existingWorktreeKeys.has(folderKey(candidateDest, platform))) continue;
        const exists = yield* Effect.promise(() => pathExistsAsync(candidateDest));
        if (!exists) {
          return { defaultBranch: branch, defaultDestination: candidateDest };
        }
      }
      const fallbackBranch = `worktree-${Date.now()}`;
      return {
        defaultBranch: fallbackBranch,
        defaultDestination: path.join(parentDir, `${baseName}-${fallbackBranch}`),
      };
    });

    const computeRepoFingerprint = (
      ctx: GitCreateContextAvailable,
      repositoryId: RepositoryId,
      targetBound?: CreateWorktreeReviewPayload['targetBound'],
    ): string =>
      sha256Hex({
        repositoryId,
        commonDirKey: folderKey(ctx.commonDirRealPath, platform),
        commonDirIdentity: ctx.commonDirIdentity,
        sourceWorktreeKey: folderKey(ctx.worktreeRealPath, platform),
        head: ctx.head,
        integrationActive: ctx.integrationActive,
        branchesDigest: ctx.branchesDigest,
        worktreePathsKey: ctx.worktreePaths.map((p) => folderKey(p, platform)).sort(),
        ...(targetBound === undefined ? {} : { targetBound }),
      });

    const collectTargetBlockers = Effect.fnUntraced(function* (
      ctx: GitCreateContextAvailable,
      target?: {
        readonly destinationPath: string;
        readonly branch: string;
        readonly startFrom: WorktreeStartPoint;
      },
    ) {
      const blockers: WorktreeCreateBlocker[] = [];
      if (ctx.integrationActive !== null) {
        blockers.push({
          code: 'ActiveIntegration',
          detail: `Finish or abort the active ${ctx.integrationActive} before creating a Worktree.`,
        });
      }

      const repoKey = reservationKeys.repo(folderKey(ctx.commonDirRealPath, platform));
      const unresolved = yield* coordinator.listUnresolvedTargets();
      const targetDestKey =
        target !== undefined
          ? reservationKeys.folder(
              folderKey(
                ctx.destinationCheck?.resolvedRealPath ?? path.resolve(target.destinationPath),
                platform,
              ),
            )
          : undefined;
      const targetRefKey =
        target !== undefined
          ? reservationKeys.ref(folderKey(ctx.commonDirRealPath, platform), target.branch)
          : undefined;

      for (const rec of unresolved) {
        if (
          rec.keys.includes(repoKey) ||
          (targetDestKey !== undefined && rec.keys.includes(targetDestKey)) ||
          (targetRefKey !== undefined && rec.keys.includes(targetRefKey))
        ) {
          blockers.push({
            code: 'RecoveryRequired',
            detail: `Unresolved operation (${rec.operationId}): ${rec.summary}`,
          });
          break;
        }
      }

      if (target === undefined) {
        if (ctx.head._tag === 'Unborn' && !ctx.branches.some((b) => !b.checkedOut)) {
          blockers.push({
            code: 'UnbornHead',
            detail: 'Create an initial commit before branching a new Worktree from HEAD.',
          });
        }
        return blockers;
      }

      if (target.startFrom.mode === 'Head' && ctx.head._tag === 'Unborn') {
        blockers.push({
          code: 'UnbornHead',
          detail:
            'Current checkout HEAD is unborn; create an initial commit or pick an existing branch.',
        });
      }

      if (ctx.branchCheck !== undefined) {
        if (!ctx.branchCheck.validName) {
          blockers.push({
            code: 'InvalidBranch',
            detail: `Branch name "${target.branch}" is invalid for Git.`,
          });
        } else {
          const startFrom = target.startFrom;
          if (startFrom.mode === 'Head' && ctx.branchCheck.exists) {
            blockers.push({
              code: 'BranchAlreadyExists',
              detail: `Branch "${target.branch}" already exists.`,
            });
          } else if (startFrom.mode === 'Branch') {
            const picked = ctx.branches.find((b) => b.name === startFrom.branch);
            if (picked === undefined) {
              blockers.push({
                code: 'InvalidBranch',
                detail: `Branch "${startFrom.branch}" does not exist.`,
              });
            } else if (picked.checkedOut) {
              blockers.push({
                code: 'BranchCheckedOut',
                detail: `Branch "${startFrom.branch}" is already checked out in another Worktree.`,
              });
            } else if (target.branch !== startFrom.branch) {
              blockers.push({
                code: 'InvalidBranch',
                detail: 'Branch name must match the selected existing branch.',
              });
            }
          }
        }
      }

      if (ctx.destinationCheck !== undefined) {
        const dest = ctx.destinationCheck;
        if (dest.touchesGitAdmin) {
          blockers.push({
            code: 'UntrustedPath',
            detail: 'Destination folder cannot target or lie inside a .git directory.',
          });
        } else if (dest.insideSourceOrRepo) {
          blockers.push({
            code: 'DestinationInsideSource',
            detail:
              'Destination folder cannot be inside the source checkout or an existing Worktree.',
          });
        } else if (dest.containsExistingWorktree) {
          blockers.push({
            code: 'UntrustedPath',
            detail: 'Destination folder cannot wrap an existing Worktree.',
          });
        } else if (dest.resolvedRealPath === null) {
          blockers.push({
            code: 'UntrustedPath',
            detail: 'Destination parent root does not exist.',
          });
        } else if (dest.destinationExists) {
          if (!dest.destinationIsDirectory || dest.destinationIsEmpty !== true) {
            blockers.push({
              code: 'DestinationExists',
              detail: 'Destination already exists on disk and is not an empty folder.',
            });
          }
        }
      }

      return blockers;
    });

    const reconcileWorktreeCreateRecord = Effect.fn('WorktreeCreate.reconcile')(function* (
      record: DurableOperationRecord,
    ): Effect.fn.Return<OperationReconciliationOutcome, SourceControlError> {
      const meta = record.metadata;
      const sourcePath =
        typeof meta['sourcePath'] === 'string' ? meta['sourcePath'] : record.snapshot.sourcePath;
      const destinationPath =
        typeof meta['destinationPath'] === 'string'
          ? meta['destinationPath']
          : record.snapshot.targetPath;
      const branch = typeof meta['branch'] === 'string' ? meta['branch'] : record.snapshot.branch;
      const mode = meta['mode'] === 'ExistingBranch' ? 'ExistingBranch' : 'NewBranch';
      const expectedCommit = typeof meta['startCommit'] === 'string' ? meta['startCommit'] : null;

      if (sourcePath === undefined || destinationPath === undefined || branch === undefined) {
        return {
          _tag: 'NeedsRecovery',
          outcome: 'NeedsRecovery',
          recovery: {
            summary: 'Incomplete operation metadata; manual inspection required.',
            detail: 'Operation journal is missing sourcePath, destinationPath, or branch.',
            observedFolderExists: false,
            observedRegisteredInGit: false,
            observedBranchExists: false,
            canReconcile: false,
            canDismiss: true,
          },
        };
      }

      const post = yield* gitWorker
        .inspectPostWorktreeCreate(sourcePath, destinationPath, branch)
        .pipe(Effect.mapError(toSourceControlError));

      const fullMatch =
        post.repoAvailable &&
        post.folderExists &&
        post.registeredInGit &&
        post.registeredBranch === branch &&
        post.clean === true &&
        (mode !== 'NewBranch' || expectedCommit === null || post.headCommit === expectedCommit);

      if (fullMatch) {
        const projectIdRaw =
          typeof meta['projectId'] === 'string' ? ProjectId.make(meta['projectId']) : undefined;
        yield* worktrees.refresh(sourcePath, projectIdRaw).pipe(Effect.ignore);
        return {
          _tag: 'Succeeded',
          targetPath: post.destinationRealPath ?? destinationPath,
          branch,
          detail: 'Verified created Worktree exists cleanly in Git without replaying creation.',
          metadata: {
            destinationRealPath: post.destinationRealPath ?? destinationPath,
          },
        };
      }

      const recovery = buildRecoveryState(
        post,
        destinationPath,
        branch,
        mode === 'NewBranch' ? expectedCommit : null,
      );
      return {
        _tag: 'NeedsRecovery',
        outcome: 'NeedsRecovery',
        recovery,
        errorDetail: recovery.detail,
      };
    });

    // Register startup & on-demand reconciler immediately before reconciling pending restart journals.
    yield* operations.registerReconciler('Worktree.create', reconcileWorktreeCreateRecord);
    yield* operations.reconcilePendingForKind('Worktree.create').pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          console.warn('[WorktreeCreate] startup reconciliation failed:', err.detail);
        }),
      ),
    );

    const issueCreateReview = Effect.fnUntraced(function* (input: {
      readonly sourcePath: string;
      readonly projectId?: ProjectId;
      readonly stale: boolean;
      readonly staleReason?: string;
      readonly target?: {
        readonly destinationPath: string;
        readonly branch: string;
        readonly startFrom: WorktreeStartPoint;
      };
    }): Effect.fn.Return<WorktreeCreateReview, WorktreesError> {
      const ctx = yield* requireAvailableContext(
        input.sourcePath,
        input.target === undefined
          ? undefined
          : {
              destinationPath: input.target.destinationPath,
              branch: input.target.branch,
            },
      );
      const { repositoryId, sourceWorktree } = yield* resolveRepoIdentity(
        input.sourcePath,
        ctx,
        input.projectId,
      );
      const { defaultBranch, defaultDestination } = yield* deriveDefaults(ctx);

      const targetBound: CreateWorktreeReviewPayload['targetBound'] =
        input.target === undefined
          ? undefined
          : {
              destinationKey: folderKey(
                ctx.destinationCheck?.resolvedRealPath ??
                  ctx.destinationCheck?.normalizedPath ??
                  path.resolve(input.target.destinationPath),
                platform,
              ),
              destinationExists: ctx.destinationCheck?.destinationExists ?? false,
              destinationIsEmpty: ctx.destinationCheck?.destinationIsEmpty ?? null,
              branch: input.target.branch,
              startFrom: input.target.startFrom,
            };

      const blockers = yield* collectTargetBlockers(ctx, input.target);
      const payload: CreateWorktreeReviewPayload = {
        repositoryId,
        commonDirRealPath: ctx.commonDirRealPath,
        commonDirIdentity: ctx.commonDirIdentity,
        sourceWorktreeId: sourceWorktree.id,
        sourceWorktreePath: ctx.worktreeRealPath,
        head: ctx.head,
        integrationActive: ctx.integrationActive,
        branchesDigest: ctx.branchesDigest,
        worktreePathsKey: ctx.worktreePaths.map((p) => folderKey(p, platform)).sort(),
        ...(targetBound === undefined ? {} : { targetBound }),
      };

      const fingerprint = computeRepoFingerprint(ctx, repositoryId, targetBound);
      const issued = yield* reviewRegistry.issue({
        kind: 'Worktree.create',
        fingerprint,
        payload,
      });

      return {
        reviewId: issued.reviewId,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        stale: input.stale,
        ...(input.staleReason === undefined ? {} : { staleReason: input.staleReason }),
        repositoryId,
        sourceWorktreeId: sourceWorktree.id,
        sourcePath: ctx.worktreeRealPath,
        sourceHead: toWorktreeHeadState(ctx.head),
        sourceDirtyCount: ctx.dirtyCount,
        defaultBranch,
        defaultDestination,
        eligibleBranches: ctx.branches,
        warnings: [],
        blockers,
        ...(ctx.integrationActive === null ? {} : { integrationActive: ctx.integrationActive }),
      };
    });

    const blockerToWorktreesError = (blocker: WorktreeCreateBlocker): WorktreesError => {
      switch (blocker.code) {
        case 'MissingGit':
          return new WorktreesError({ reason: 'MissingGit', detail: blocker.detail });
        case 'NonGit':
          return new WorktreesError({ reason: 'NonGit', detail: blocker.detail });
        case 'MissingPath':
          return new WorktreesError({ reason: 'MissingPath', detail: blocker.detail });
        case 'UnsupportedRepo':
        case 'BareRepoOnly':
        case 'UnbornHead':
          return new WorktreesError({ reason: 'UnsupportedRepo', detail: blocker.detail });
        case 'RecoveryRequired':
          return new WorktreesError({ reason: 'RecoveryRequired', detail: blocker.detail });
        case 'UntrustedPath':
        case 'DestinationInsideSource':
          return new WorktreesError({ reason: 'UntrustedPath', detail: blocker.detail });
        case 'InvalidBranch':
          return new WorktreesError({ reason: 'InvalidInput', detail: blocker.detail });
        case 'ActiveIntegration':
        case 'DestinationExists':
        case 'BranchAlreadyExists':
        case 'BranchCheckedOut':
          return new WorktreesError({ reason: 'Conflict', detail: blocker.detail });
        case 'TurnActive':
          return new WorktreesError({ reason: 'Busy', detail: blocker.detail });
      }
    };

    const resolveCreatedEntry = Effect.fnUntraced(function* (
      sourcePath: string,
      destinationPath: string,
      projectId?: ProjectId,
    ): Effect.fn.Return<{
      readonly worktree?: WorktreeEntry;
      readonly inventory?: WorktreeInventory;
    }> {
      const invExit = yield* Effect.exit(worktrees.inventory(sourcePath, projectId));
      if (invExit._tag !== 'Success') return {};
      const destKey = folderKey(destinationPath, platform);
      const matched = invExit.value.worktrees.find((w) => folderKey(w.path, platform) === destKey);
      return {
        inventory: invExit.value,
        ...(matched === undefined ? {} : { worktree: matched }),
      };
    });

    return {
      prepareCreate: Effect.fn('WorktreeCreate.prepareCreate')(function* ({
        path: sourcePath,
        projectId,
      }) {
        return yield* issueCreateReview({
          sourcePath,
          ...(projectId === undefined ? {} : { projectId }),
          stale: false,
        });
      }),

      revalidateCreate: Effect.fn('WorktreeCreate.revalidateCreate')(function* ({
        reviewId,
        sourcePath,
        destinationPath,
        branch,
        startFrom,
        projectId,
      }) {
        let stale = false;
        let staleReason: string | undefined;

        if (reviewId !== undefined) {
          const existing = yield* reviewRegistry.get(reviewId);
          if (existing === undefined) {
            stale = true;
            staleReason = 'Previous review was no longer active.';
          } else if (existing.kind === 'Worktree.create') {
            const ctx = yield* requireAvailableContext(sourcePath, { destinationPath, branch });
            const { repositoryId } = yield* resolveRepoIdentity(sourcePath, ctx, projectId);
            const prevPayload = existing.payload as CreateWorktreeReviewPayload;
            const liveRepoFp = computeRepoFingerprint(ctx, repositoryId, prevPayload.targetBound);
            if (prevPayload.targetBound === undefined) {
              // Compare base repository fingerprint when previous review came from prepareCreate.
              const prevBaseFp = sha256Hex({
                repositoryId: prevPayload.repositoryId,
                commonDirKey: folderKey(prevPayload.commonDirRealPath, platform),
                commonDirIdentity: prevPayload.commonDirIdentity,
                sourceWorktreeKey: folderKey(prevPayload.sourceWorktreePath, platform),
                head: prevPayload.head,
                integrationActive: prevPayload.integrationActive,
                branchesDigest: prevPayload.branchesDigest,
                worktreePathsKey: prevPayload.worktreePathsKey,
              });
              const liveBaseFp = computeRepoFingerprint(ctx, repositoryId);
              if (prevBaseFp !== liveBaseFp) {
                stale = true;
                staleReason = 'Repository state changed since initial review.';
              }
            } else if (existing.fingerprint !== liveRepoFp) {
              stale = true;
              staleReason = 'Repository or destination changed since previous review.';
            }
          }
        }

        return yield* issueCreateReview({
          sourcePath,
          ...(projectId === undefined ? {} : { projectId }),
          stale,
          ...(staleReason === undefined ? {} : { staleReason }),
          target: {
            destinationPath,
            branch,
            startFrom,
          },
        });
      }),

      executeCreate: Effect.fn('WorktreeCreate.executeCreate')(function* (input) {
        if (!isSafeStoreId(input.operationId)) {
          return yield* new WorktreesError({
            reason: 'InvalidInput',
            detail: `Invalid operation identifier "${input.operationId}".`,
          });
        }

        const trimmedBranch = input.branch.trim();
        if (!isSyntacticallyValidBranch(trimmedBranch)) {
          return yield* new WorktreesError({
            reason: 'InvalidInput',
            detail: `Branch name "${input.branch}" is not valid for Git.`,
          });
        }

        if (
          input.destinationPath.length === 0 ||
          input.destinationPath.includes('\0') ||
          !path.isAbsolute(input.destinationPath)
        ) {
          return yield* new WorktreesError({
            reason: 'UntrustedPath',
            detail: 'Destination folder must be a valid absolute path.',
          });
        }
        const resolvedDest = path.resolve(input.destinationPath);
        if (path.dirname(resolvedDest) === resolvedDest || hasGitSegment(resolvedDest)) {
          return yield* new WorktreesError({
            reason: 'UntrustedPath',
            detail: 'Destination folder cannot be a filesystem root or touch a .git directory.',
          });
        }

        // Canonical request digest so duplicate identical retries are idempotent and different params reject Conflict.
        const requestDigest = sha256Hex({
          reviewId: input.reviewId,
          sourceKey: folderKey(input.sourcePath, platform),
          destKey: folderKey(resolvedDest, platform),
          branch: trimmedBranch,
          startFrom: input.startFrom,
          projectId: input.projectId ?? null,
        });

        const peekedReview = yield* reviewRegistry.get(input.reviewId);
        const peekPayload = peekedReview?.payload as CreateWorktreeReviewPayload | undefined;
        const repoKeyHint = folderKey(peekPayload?.commonDirRealPath ?? input.sourcePath, platform);
        const destKey = folderKey(resolvedDest, platform);
        const initialLockKeys = [
          reservationKeys.repo(repoKeyHint),
          reservationKeys.folder(destKey),
          reservationKeys.ref(repoKeyHint, trimmedBranch),
        ];

        let preparedContext:
          | {
              readonly ctx: GitCreateContextAvailable;
              readonly destinationRealPath: string;
              readonly mode: 'NewBranch' | 'ExistingBranch';
              readonly startCommit: string;
            }
          | undefined;

        const snapshot = yield* operations
          .execute({
            operationId: input.operationId,
            kind: 'Worktree.create',
            title: `Create Worktree (${trimmedBranch})`,
            requestDigest,
            lockKeys: initialLockKeys,
            ...(peekPayload === undefined ? {} : { repositoryKey: peekPayload.repositoryId }),
            sourcePath: input.sourcePath,
            targetPath: resolvedDest,
            branch: trimmedBranch,
            metadata: {
              sourcePath: input.sourcePath,
              destinationPath: resolvedDest,
              branch: trimmedBranch,
              mode: input.startFrom.mode === 'Branch' ? 'ExistingBranch' : 'NewBranch',
              ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
            },
            prepare: Effect.fnUntraced(function* () {
              const liveCtx = yield* requireAvailableContext(input.sourcePath, {
                destinationPath: resolvedDest,
                branch: trimmedBranch,
              }).pipe(Effect.mapError(toSourceControlError));
              const { repositoryId } = yield* resolveRepoIdentity(
                input.sourcePath,
                liveCtx,
                input.projectId,
              ).pipe(Effect.mapError(toSourceControlError));

              const verified = yield* reviewRegistry.verifyAndConsume({
                reviewId: input.reviewId,
                kind: 'Worktree.create',
                operationId: input.operationId,
                checkFingerprint: (record) => {
                  const reviewed = record.payload as CreateWorktreeReviewPayload;
                  if (
                    reviewed.targetBound !== undefined &&
                    (reviewed.targetBound.branch !== trimmedBranch ||
                      reviewed.targetBound.destinationKey !==
                        folderKey(
                          liveCtx.destinationCheck?.resolvedRealPath ??
                            liveCtx.destinationCheck?.normalizedPath ??
                            resolvedDest,
                          platform,
                        ) ||
                      JSON.stringify(reviewed.targetBound.startFrom) !==
                        JSON.stringify(input.startFrom))
                  ) {
                    return Effect.fail({
                      _tag: 'Drifted',
                      reason: 'StaleReview',
                      detail:
                        'Branch, starting point, or destination changed since review. Re-review before creating.',
                    });
                  }

                  const liveFp = computeRepoFingerprint(
                    liveCtx,
                    repositoryId,
                    reviewed.targetBound === undefined
                      ? undefined
                      : {
                          destinationKey: folderKey(
                            liveCtx.destinationCheck?.resolvedRealPath ??
                              liveCtx.destinationCheck?.normalizedPath ??
                              resolvedDest,
                            platform,
                          ),
                          destinationExists: liveCtx.destinationCheck?.destinationExists ?? false,
                          destinationIsEmpty: liveCtx.destinationCheck?.destinationIsEmpty ?? null,
                          branch: trimmedBranch,
                          startFrom: input.startFrom,
                        },
                  );
                  if (liveFp !== record.fingerprint) {
                    return Effect.fail({
                      _tag: 'Drifted',
                      reason: 'StaleReview',
                      detail:
                        'Repository or destination state changed since this review. Refresh the review and try again.',
                    });
                  }
                  return Effect.void;
                },
              });

              void verified;

              const blockers = yield* collectTargetBlockers(liveCtx, {
                destinationPath: resolvedDest,
                branch: trimmedBranch,
                startFrom: input.startFrom,
              });
              const firstBlocker = blockers[0];
              if (firstBlocker !== undefined) {
                return yield* toSourceControlError(blockerToWorktreesError(firstBlocker));
              }

              let mode: 'NewBranch' | 'ExistingBranch';
              let startCommit: string;
              if (input.startFrom.mode === 'Head') {
                if (liveCtx.head._tag === 'Unborn') {
                  return yield* new SourceControlError({
                    reason: 'UnsupportedRepo',
                    detail: 'Current HEAD has no commits yet.',
                  });
                }
                mode = 'NewBranch';
                startCommit = liveCtx.head.commit;
              } else {
                const requestedBranch = input.startFrom.branch;
                const chosen = liveCtx.branches.find((b) => b.name === requestedBranch);
                if (chosen === undefined) {
                  return yield* new SourceControlError({
                    reason: 'InvalidInput',
                    detail: 'Selected branch no longer exists.',
                  });
                }
                mode = 'ExistingBranch';
                startCommit = chosen.commit;
              }

              const destRealOrNorm = liveCtx.destinationCheck?.resolvedRealPath ?? resolvedDest;
              preparedContext = {
                ctx: liveCtx,
                destinationRealPath: destRealOrNorm,
                mode,
                startCommit,
              };

              const repoKey = folderKey(liveCtx.commonDirRealPath, platform);
              return {
                targetPath: destRealOrNorm,
                branch: trimmedBranch,
                lockKeys: [
                  reservationKeys.repo(repoKey),
                  reservationKeys.folder(folderKey(destRealOrNorm, platform)),
                  reservationKeys.ref(repoKey, trimmedBranch),
                ],
                metadata: {
                  sourcePath: liveCtx.worktreeRealPath,
                  destinationPath: destRealOrNorm,
                  branch: trimmedBranch,
                  mode,
                  startCommit,
                  expectedCommonDirRealPath: liveCtx.commonDirRealPath,
                  ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
                },
              };
            }),
            apply: Effect.fnUntraced(function* ({ record, reportProgress }) {
              const prep = preparedContext;
              if (prep === undefined) {
                return yield* new SourceControlError({
                  reason: 'OperationFailed',
                  detail: 'Prepared Worktree creation context missing.',
                });
              }

              yield* reportProgress('ExecutingGit', `Creating branch ${trimmedBranch}…`);
              const execExit = yield* Effect.exit(
                gitWorker.createWorktree({
                  folder: prep.ctx.worktreeRealPath,
                  destinationPath: prep.destinationRealPath,
                  expectedCommonDirRealPath: prep.ctx.commonDirRealPath,
                  expectedCommonDirIdentity: prep.ctx.commonDirIdentity,
                  mode: prep.mode,
                  branch: trimmedBranch,
                  startPoint: prep.startCommit,
                }),
              );

              if (execExit._tag === 'Failure') {
                const errOpt = Cause.findErrorOption(execExit.cause);
                const errValue = errOpt._tag === 'Some' ? errOpt.value : undefined;
                const errDetail =
                  errValue instanceof WorktreesError ? errValue.detail : String(execExit.cause);
                const errReason =
                  errValue instanceof WorktreesError ? errValue.reason : 'WorkerFailed';

                const postExit = yield* Effect.exit(
                  gitWorker.inspectPostWorktreeCreate(
                    prep.ctx.worktreeRealPath,
                    prep.destinationRealPath,
                    trimmedBranch,
                  ),
                );
                const post: GitPostWorktreeCreateInspection =
                  postExit._tag === 'Success'
                    ? postExit.value
                    : {
                        folderExists: false,
                        folderEmpty: true,
                        registeredInGit: false,
                        registeredBranch: null,
                        branchExists: false,
                        branchCommit: null,
                        clean: null,
                        headCommit: null,
                        destinationRealPath: null,
                        gitAvailable: false,
                        repoAvailable: false,
                        detail: errDetail,
                      };

                const workerUncertain = isWorkerCrashDetail(errDetail);
                const hasArtifacts =
                  post.folderExists ||
                  post.registeredInGit ||
                  (prep.mode === 'NewBranch' && post.branchExists);

                if (workerUncertain || hasArtifacts || postExit._tag === 'Failure') {
                  return {
                    _tag: 'Unknown' as const,
                    unknownReason: errDetail,
                    errorDetail: errDetail,
                    recovery: buildRecoveryState(
                      post,
                      prep.destinationRealPath,
                      trimmedBranch,
                      prep.mode === 'NewBranch' ? prep.startCommit : null,
                    ),
                  };
                }

                return {
                  _tag: 'FailedClean' as const,
                  errorReason: errReason,
                  errorDetail: errDetail,
                };
              }

              yield* reportProgress('VerifyingPostconditions', 'Verifying new Worktree…');
              const postExit = yield* Effect.exit(
                gitWorker.inspectPostWorktreeCreate(
                  prep.ctx.worktreeRealPath,
                  execExit.value.destinationRealPath,
                  trimmedBranch,
                ),
              );
              if (
                postExit._tag !== 'Success' ||
                !postExit.value.registeredInGit ||
                !postExit.value.folderExists
              ) {
                const fallbackPost: GitPostWorktreeCreateInspection =
                  postExit._tag === 'Success'
                    ? postExit.value
                    : {
                        folderExists: true,
                        folderEmpty: false,
                        registeredInGit: false,
                        registeredBranch: null,
                        branchExists: true,
                        branchCommit: execExit.value.commit,
                        clean: null,
                        headCommit: execExit.value.commit,
                        destinationRealPath: execExit.value.destinationRealPath,
                        gitAvailable: false,
                        repoAvailable: false,
                        detail: 'Unable to verify Worktree postconditions.',
                      };
                return {
                  _tag: 'Unknown' as const,
                  unknownReason: 'Postcondition check failed after git worktree add.',
                  recovery: buildRecoveryState(
                    fallbackPost,
                    execExit.value.destinationRealPath,
                    trimmedBranch,
                    prep.mode === 'NewBranch' ? prep.startCommit : null,
                  ),
                };
              }

              yield* reportProgress('RefreshingInventory', 'Updating Worktree list…');
              yield* worktrees.refresh(input.sourcePath, input.projectId).pipe(Effect.ignore);
              void record;

              return {
                _tag: 'Succeeded' as const,
                targetPath: execExit.value.destinationRealPath,
                branch: execExit.value.branch,
                metadata: {
                  destinationRealPath: execExit.value.destinationRealPath,
                },
              };
            }),
          })
          .pipe(Effect.mapError(mapSourceControlError));

        if (snapshot.phase === 'Completed' && snapshot.outcome === 'Succeeded') {
          const resolved = yield* resolveCreatedEntry(
            input.sourcePath,
            snapshot.targetPath ?? resolvedDest,
            input.projectId,
          );
          return {
            operation: snapshot,
            ...(resolved.worktree === undefined ? {} : { worktree: resolved.worktree }),
            ...(resolved.inventory === undefined ? {} : { inventory: resolved.inventory }),
          };
        }

        return { operation: snapshot };
      }),
    } satisfies WorktreeCreateShape;
  }),
);
