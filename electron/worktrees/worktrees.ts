import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  RepositoryId,
  WorktreeId,
  WorktreesError,
  type GitCapability,
  type WorktreeBinding,
  type WorktreeEntry,
  type WorktreeHeadState,
  type WorktreeInventory,
  type WorktreeLocateMismatchReason,
  type WorktreeLocateResult,
} from '../../src/shared/worktrees/worktrees.rpc';
import { folderKey } from '../projects/folder-key';
import { PathSources } from '../agents/merged-path';
import { Store, type StoreError, type VersionedFile } from '../store/store';
import type { GitProbeResult, RawWorktreeRecord } from '../worker/worker-protocol';
import { GitWorker } from './git-client';

const PersistedRepository = Schema.Struct({
  id: RepositoryId,
  commonDirRealPath: Schema.String,
  commonDirKey: Schema.String,
  commonDirIdentity: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type PersistedRepository = typeof PersistedRepository.Type;

const PersistedWorktree = Schema.Struct({
  id: WorktreeId,
  repositoryId: RepositoryId,
  path: Schema.String,
  pathKey: Schema.String,
  folderIdentity: Schema.optionalKey(Schema.String),
  lastKnownBranch: Schema.optionalKey(Schema.String),
  missing: Schema.Boolean,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
type PersistedWorktree = typeof PersistedWorktree.Type;

const WorktreesRegistry = Schema.Struct({
  repositories: Schema.Array(PersistedRepository),
  worktrees: Schema.Array(PersistedWorktree),
});
type WorktreesRegistry = typeof WorktreesRegistry.Type;

export const WORKTREES_REGISTRY_FILE: VersionedFile<WorktreesRegistry> = {
  file: path.join('worktrees', 'registry.json'),
  version: 1,
  migrations: [],
  schema: WorktreesRegistry,
  initial: () => ({ repositories: [], worktrees: [] }),
};

/** Domain service discovering Git Repositories and existing Worktrees for Project and Session folders. */
export interface WorktreeLocateInput {
  readonly expectedBinding: WorktreeBinding;
  readonly targetPath: string;
  readonly projectId?: ProjectId;
  readonly allowRebind?: boolean;
}

export interface WorktreesShape {
  readonly platform: NodeJS.Platform;
  readonly inventory: (
    targetPath: string,
    projectId?: ProjectId,
  ) => Effect.Effect<WorktreeInventory, WorktreesError>;
  readonly refresh: (
    targetPath: string,
    projectId?: ProjectId,
  ) => Effect.Effect<WorktreeInventory, WorktreesError>;
  readonly locate: (
    input: WorktreeLocateInput,
  ) => Effect.Effect<WorktreeLocateResult, WorktreesError>;
  readonly reconcileBinding: (
    binding: WorktreeBinding,
    cwd: string,
    inventory: WorktreeInventory,
  ) => WorktreeBinding;
  readonly updates: Stream.Stream<WorktreeInventory>;
}

export class Worktrees extends Context.Service<Worktrees, WorktreesShape>()(
  'worktrees/Worktrees',
) {}

const mapStoreError = (err: StoreError): WorktreesError => {
  switch (err.reason) {
    case 'NewerVersion':
      return new WorktreesError({ reason: 'NewerVersion', detail: err.detail });
    case 'Invalid':
      return new WorktreesError({ reason: 'RegistryCorrupt', detail: err.detail });
    case 'NotFound':
      return new WorktreesError({ reason: 'WorkerFailed', detail: err.detail });
  }
};

const identitiesMatch = (a: string | undefined, b: string | undefined): boolean =>
  a === undefined || b === undefined || a === b;

const toCapability = (probe: GitProbeResult): GitCapability => {
  switch (probe._tag) {
    case 'Available':
      return {
        _tag: 'Available',
        gitVersion: probe.gitVersion,
        executable: probe.executable,
      };
    case 'MissingGit':
      return { _tag: 'MissingGit', detail: probe.detail };
    case 'MissingPath':
      return { _tag: 'MissingPath', path: probe.path, detail: probe.detail };
    case 'NonGit':
      return { _tag: 'NonGit', path: probe.path, detail: probe.detail };
    case 'UnsupportedRepo':
      return { _tag: 'UnsupportedRepo', path: probe.path, detail: probe.detail };
  }
};

const toHeadState = (raw: RawWorktreeRecord): WorktreeHeadState => {
  if (raw.detached) {
    return { _tag: 'Detached', commit: raw.headCommit ?? '' };
  }
  const unbornCommit = raw.headCommit === undefined || /^0+$/.test(raw.headCommit);
  if (unbornCommit && raw.branch !== undefined) {
    return { _tag: 'Unborn', branch: raw.branch };
  }
  if (raw.branch !== undefined && raw.branchRef !== undefined) {
    return {
      _tag: 'Branch',
      branch: raw.branch,
      ref: raw.branchRef,
      ...(raw.headCommit === undefined ? {} : { commit: raw.headCommit }),
    };
  }
  return { _tag: 'Detached', commit: raw.headCommit ?? '' };
};

export const headDisplayBranch = (head: WorktreeHeadState): string => {
  switch (head._tag) {
    case 'Branch':
    case 'Unborn':
      return head.branch;
    case 'Detached':
      return head.commit.slice(0, 7) || 'HEAD';
  }
};

const keepBindingIdentity = (binding: WorktreeBinding, cwd: string): WorktreeBinding => ({
  state: binding.state,
  ...(binding.repositoryId === undefined ? {} : { repositoryId: binding.repositoryId }),
  ...(binding.worktreeId === undefined ? {} : { worktreeId: binding.worktreeId }),
  expectedPath: binding.expectedPath ?? cwd,
  ...(binding.lastKnownBranch === undefined ? {} : { lastKnownBranch: binding.lastKnownBranch }),
});

/** Structural equality check for two optional `WorktreeBinding` values. */
export const sameWorktreeBinding = (
  a: WorktreeBinding | undefined,
  b: WorktreeBinding | undefined,
): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
};

/** Returns a `resolved` Session Worktree binding referencing a registered `WorktreeEntry`. */
export const toResolvedWorktreeBinding = (entry: WorktreeEntry): WorktreeBinding => {
  const branch =
    entry.head._tag === 'Branch' || entry.head._tag === 'Unborn' ? entry.head.branch : undefined;
  return {
    state: 'resolved',
    repositoryId: entry.repositoryId,
    worktreeId: entry.id,
    expectedPath: entry.path,
    ...(branch === undefined ? {} : { lastKnownBranch: branch }),
  };
};

const toNonAvailableLocateReason = (
  probe: Exclude<GitProbeResult, { readonly _tag: 'Available' }>,
  expectedBinding: WorktreeBinding,
): { readonly reason: WorktreeLocateMismatchReason; readonly detail: string } => {
  switch (probe._tag) {
    case 'MissingPath':
      return { reason: 'MissingPath', detail: probe.detail };
    case 'MissingGit':
      return { reason: 'MissingGit', detail: probe.detail };
    case 'UnsupportedRepo':
      return { reason: 'UnsupportedRepo', detail: probe.detail };
    case 'NonGit':
      return {
        reason: expectedBinding.repositoryId !== undefined ? 'NonGit' : 'NoPriorIdentity',
        detail:
          expectedBinding.repositoryId !== undefined
            ? 'Selected folder is not a Git repository; confirm to rebind this Session.'
            : 'Folder has no prior Worktree identity to verify; confirm to bind this Session.',
      };
  }
};

const findExistingRepo = (
  repositories: ReadonlyArray<PersistedRepository>,
  commonKey: string,
  commonDirIdentity: string | undefined,
): PersistedRepository | undefined =>
  repositories.find(
    (repo) =>
      (repo.commonDirKey === commonKey &&
        identitiesMatch(repo.commonDirIdentity, commonDirIdentity)) ||
      (repo.commonDirIdentity !== undefined &&
        commonDirIdentity !== undefined &&
        repo.commonDirIdentity === commonDirIdentity),
  );

/** Purely reconciles a persisted/current Session Worktree binding against the latest inventory. */
export const reconcileWorktreeBinding = (
  binding: WorktreeBinding,
  cwd: string,
  inventory: WorktreeInventory,
): WorktreeBinding => {
  const cap = inventory.capability;
  const hasPreviousRepoBinding =
    binding.worktreeId !== undefined || binding.repositoryId !== undefined;

  switch (cap._tag) {
    case 'MissingPath':
      return {
        ...keepBindingIdentity(binding, cwd),
        state: 'missing',
        reason: 'MissingPath',
        detail: cap.detail,
      };
    case 'NonGit':
      if (hasPreviousRepoBinding) {
        return {
          ...keepBindingIdentity(binding, cwd),
          state: 'missing',
          reason: 'ReplacedFolder',
          detail: 'Previously bound Git Worktree folder is now a non-Git directory.',
        };
      }
      return {
        state: 'resolved',
        expectedPath: cwd,
        reason: 'NonGit',
        detail: cap.detail,
      };
    case 'UnsupportedRepo':
      return {
        ...keepBindingIdentity(binding, cwd),
        state: hasPreviousRepoBinding ? 'missing' : 'undiscovered',
        reason: 'UnsupportedRepo',
        detail: cap.detail,
      };
    case 'MissingGit':
      return {
        ...keepBindingIdentity(binding, cwd),
        state: binding.state === 'missing' ? 'missing' : binding.state,
        reason: 'MissingGit',
        detail: cap.detail,
      };
    case 'Available': {
      const current = inventory.worktrees.find((w) => w.id === inventory.currentWorktreeId);
      if (!hasPreviousRepoBinding) {
        if (current === undefined || current.missing) {
          return {
            state: 'missing',
            expectedPath: cwd,
            reason: 'UnregisteredWorktree',
            detail: 'Checkout could not be matched to an active Git Worktree.',
          };
        }
        return {
          state: 'resolved',
          repositoryId: current.repositoryId,
          worktreeId: current.id,
          expectedPath: current.path,
          lastKnownBranch: headDisplayBranch(current.head),
        };
      }

      if (
        inventory.repositoryId === binding.repositoryId &&
        inventory.currentWorktreeId === binding.worktreeId &&
        current !== undefined &&
        !current.missing
      ) {
        return {
          state: 'resolved',
          repositoryId: current.repositoryId,
          worktreeId: current.id,
          expectedPath: current.path,
          lastKnownBranch: headDisplayBranch(current.head),
        };
      }

      if (inventory.repositoryId !== binding.repositoryId) {
        return {
          ...keepBindingIdentity(binding, cwd),
          state: 'missing',
          reason: 'ReplacedFolder',
          detail: 'Folder at this path now belongs to a different Git repository.',
        };
      }

      const boundEntry = inventory.worktrees.find((w) => w.id === binding.worktreeId);
      if (boundEntry?.missing) {
        return {
          ...keepBindingIdentity(binding, cwd),
          state: 'missing',
          reason: 'MissingPath',
          detail: 'Bound Worktree directory is missing on disk.',
        };
      }

      return {
        ...keepBindingIdentity(binding, cwd),
        state: 'missing',
        reason: 'ReplacedFolder',
        detail: 'Bound Worktree is no longer at this path.',
      };
    }
  }
};

export const layerWorktrees: Layer.Layer<Worktrees, never, GitWorker | Store | PathSources> =
  Layer.effect(
    Worktrees,
    Effect.gen(function* () {
      const gitWorker = yield* GitWorker;
      const store = yield* Store;
      const { platform } = yield* PathSources;
      const lock = Semaphore.makeUnsafe(1);
      const updates = yield* PubSub.unbounded<WorktreeInventory>();
      const cache = new Map<string, WorktreeInventory>();

      const readRegistry = () =>
        store.readVersioned(WORKTREES_REGISTRY_FILE).pipe(Effect.mapError(mapStoreError));

      const writeRegistry = (registry: WorktreesRegistry) =>
        store
          .writeVersioned(WORKTREES_REGISTRY_FILE, registry)
          .pipe(Effect.mapError(mapStoreError));

      const reconcileRegistry = (
        probe: Extract<GitProbeResult, { readonly _tag: 'Available' }>,
        registry: WorktreesRegistry,
        now: number,
        relocate?: { readonly worktreeId: WorktreeId; readonly targetKey: string },
      ): {
        readonly nextRegistry: WorktreesRegistry;
        readonly repositoryId: RepositoryId;
        readonly entries: ReadonlyArray<WorktreeEntry>;
        readonly currentWorktreeId: WorktreeId | undefined;
      } => {
        const commonKey = folderKey(probe.commonDirRealPath, platform);
        const existingRepo = findExistingRepo(
          registry.repositories,
          commonKey,
          probe.commonDirIdentity,
        );
        const repoRecord: PersistedRepository =
          existingRepo !== undefined
            ? {
                ...existingRepo,
                commonDirRealPath: probe.commonDirRealPath,
                commonDirKey: commonKey,
                ...(probe.commonDirIdentity === undefined
                  ? {}
                  : { commonDirIdentity: probe.commonDirIdentity }),
                updatedAt: now,
              }
            : {
                id: RepositoryId.make(`repo:${randomUUID()}`),
                commonDirRealPath: probe.commonDirRealPath,
                commonDirKey: commonKey,
                ...(probe.commonDirIdentity === undefined
                  ? {}
                  : { commonDirIdentity: probe.commonDirIdentity }),
                createdAt: now,
                updatedAt: now,
              };

        const existingRepoWorktrees = registry.worktrees.filter(
          (w) => w.repositoryId === repoRecord.id,
        );
        const otherWorktrees = registry.worktrees.filter((w) => w.repositoryId !== repoRecord.id);

        const seenWorktreeIds = new Set<WorktreeId>();
        const updatedRepoWorktrees: PersistedWorktree[] = [];
        const entries: WorktreeEntry[] = [];
        const targetTopKey = folderKey(probe.toplevelRealPath ?? probe.folderRealPath, platform);
        let currentWorktreeId: WorktreeId | undefined;
        let sawPrimary = false;

        for (const raw of probe.worktrees) {
          const canonicalPath = raw.realPath ?? raw.rawPath;
          const wtKey = folderKey(canonicalPath, platform);
          const relocatedMatch =
            relocate !== undefined && wtKey === relocate.targetKey
              ? existingRepoWorktrees.find(
                  (w) =>
                    w.id === relocate.worktreeId &&
                    !seenWorktreeIds.has(w.id) &&
                    identitiesMatch(w.folderIdentity, raw.folderIdentity),
                )
              : undefined;
          const existingWt =
            relocatedMatch ??
            existingRepoWorktrees.find(
              (w) =>
                !seenWorktreeIds.has(w.id) &&
                w.pathKey === wtKey &&
                identitiesMatch(w.folderIdentity, raw.folderIdentity),
            );
          const head = toHeadState(raw);
          const isMissing = !raw.exists || raw.prunableReason !== undefined;
          const isPrimary = !raw.bare && !sawPrimary;
          if (isPrimary) sawPrimary = true;

          const branchName =
            head._tag === 'Branch' || head._tag === 'Unborn' ? head.branch : undefined;
          const wtRecord: PersistedWorktree =
            existingWt !== undefined
              ? {
                  ...existingWt,
                  path: canonicalPath,
                  pathKey: wtKey,
                  ...(raw.folderIdentity === undefined
                    ? {}
                    : { folderIdentity: raw.folderIdentity }),
                  ...(branchName === undefined
                    ? existingWt.lastKnownBranch === undefined
                      ? {}
                      : { lastKnownBranch: existingWt.lastKnownBranch }
                    : { lastKnownBranch: branchName }),
                  missing: isMissing,
                  updatedAt: now,
                }
              : {
                  id: WorktreeId.make(`wt:${randomUUID()}`),
                  repositoryId: repoRecord.id,
                  path: canonicalPath,
                  pathKey: wtKey,
                  ...(raw.folderIdentity === undefined
                    ? {}
                    : { folderIdentity: raw.folderIdentity }),
                  ...(branchName === undefined ? {} : { lastKnownBranch: branchName }),
                  missing: isMissing,
                  createdAt: now,
                  updatedAt: now,
                };

          seenWorktreeIds.add(wtRecord.id);
          updatedRepoWorktrees.push(wtRecord);

          if (wtKey === targetTopKey) {
            currentWorktreeId = wtRecord.id;
          }

          entries.push({
            id: wtRecord.id,
            repositoryId: repoRecord.id,
            path: canonicalPath,
            folderName: path.basename(canonicalPath) || canonicalPath,
            head,
            isPrimary,
            bare: raw.bare,
            missing: isMissing,
            ...(raw.lockedReason === undefined ? {} : { lockedReason: raw.lockedReason }),
            ...(raw.changes === undefined ? {} : { changes: raw.changes }),
          });
        }

        for (const stale of existingRepoWorktrees) {
          if (!seenWorktreeIds.has(stale.id)) {
            if (
              relocate !== undefined &&
              stale.pathKey === relocate.targetKey &&
              stale.id !== relocate.worktreeId
            ) {
              continue;
            }
            updatedRepoWorktrees.push({
              ...stale,
              missing: true,
              updatedAt: now,
            });
          }
        }

        const nextRepos =
          existingRepo !== undefined
            ? registry.repositories.map((r) => (r.id === repoRecord.id ? repoRecord : r))
            : [...registry.repositories, repoRecord];

        return {
          nextRegistry: {
            repositories: nextRepos,
            worktrees: [...otherWorktrees, ...updatedRepoWorktrees],
          },
          repositoryId: repoRecord.id,
          entries,
          currentWorktreeId,
        };
      };

      const runDiscovery = Effect.fn('Worktrees.refresh')(function* (
        targetPath: string,
        projectId?: ProjectId,
      ) {
        const probe = yield* gitWorker.probe(targetPath);
        const now = Date.now();
        const inv: WorktreeInventory = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const registry = yield* readRegistry();
            if (probe._tag !== 'Available') {
              return {
                ...(projectId === undefined ? {} : { projectId }),
                cwd: targetPath,
                capability: toCapability(probe),
                worktrees: [],
                refreshedAt: now,
              } satisfies WorktreeInventory;
            }

            const reconciled = reconcileRegistry(probe, registry, now);
            yield* writeRegistry(reconciled.nextRegistry);
            return {
              ...(projectId === undefined ? {} : { projectId }),
              cwd: probe.toplevelRealPath ?? probe.folderRealPath,
              capability: toCapability(probe),
              repositoryId: reconciled.repositoryId,
              commonDir: probe.commonDirRealPath,
              ...(reconciled.currentWorktreeId === undefined
                ? {}
                : { currentWorktreeId: reconciled.currentWorktreeId }),
              worktrees: reconciled.entries,
              refreshedAt: now,
            } satisfies WorktreeInventory;
          }),
        );
        cache.set(folderKey(targetPath, platform), inv);
        if (inv.cwd !== targetPath) {
          cache.set(folderKey(inv.cwd, platform), inv);
        }
        yield* PubSub.publish(updates, inv);
        return inv;
      });

      const getInventory = Effect.fn('Worktrees.inventory')(function* (
        targetPath: string,
        projectId?: ProjectId,
      ) {
        yield* lock.withPermits(1)(readRegistry());
        const cached = cache.get(folderKey(targetPath, platform));
        if (cached !== undefined) {
          return projectId !== undefined && cached.projectId !== projectId
            ? { ...cached, projectId }
            : cached;
        }
        return yield* runDiscovery(targetPath, projectId);
      });

      const cacheInventory = (targetPath: string, inv: WorktreeInventory): void => {
        cache.set(folderKey(targetPath, platform), inv);
        if (inv.cwd !== targetPath) {
          cache.set(folderKey(inv.cwd, platform), inv);
        }
      };

      const locate = Effect.fn('Worktrees.locate')(function* ({
        expectedBinding,
        targetPath,
        projectId,
        allowRebind = false,
      }: WorktreeLocateInput): Effect.fn.Return<WorktreeLocateResult, WorktreesError> {
        const probe = yield* gitWorker.probe(targetPath);
        const now = Date.now();
        if (probe._tag !== 'Available') {
          const inv: WorktreeInventory = {
            ...(projectId === undefined ? {} : { projectId }),
            cwd: probe._tag === 'NonGit' ? probe.path : targetPath,
            capability: toCapability(probe),
            worktrees: [],
            refreshedAt: now,
          };
          if (!allowRebind) {
            const { reason, detail } = toNonAvailableLocateReason(probe, expectedBinding);
            return {
              _tag: 'RequiresRebind',
              mismatchReason: reason,
              candidatePath: inv.cwd,
              detail,
              inventory: inv,
            };
          }
          if (probe._tag === 'MissingPath') {
            return yield* Effect.fail(
              new WorktreesError({ reason: 'MissingPath', detail: probe.detail }),
            );
          }
          if (probe._tag === 'UnsupportedRepo') {
            return yield* Effect.fail(
              new WorktreesError({ reason: 'UnsupportedRepo', detail: probe.detail }),
            );
          }
          return {
            _tag: 'Rebound',
            binding: {
              state: probe._tag === 'NonGit' ? 'resolved' : 'undiscovered',
              expectedPath: inv.cwd,
              reason: probe._tag === 'NonGit' ? 'NonGit' : 'MissingGit',
              detail: probe.detail,
            },
            inventory: inv,
          };
        }

        const result = yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const registry = yield* readRegistry();
            const commonKey = folderKey(probe.commonDirRealPath, platform);
            const matchedRepo = findExistingRepo(
              registry.repositories,
              commonKey,
              probe.commonDirIdentity,
            );
            const targetTop = probe.toplevelRealPath ?? probe.folderRealPath;
            const targetTopKey = folderKey(targetTop, platform);
            const matchedRaw = probe.worktrees.find(
              (w) =>
                w.realPath !== undefined &&
                folderKey(w.realPath, platform) === targetTopKey &&
                w.prunableReason === undefined &&
                !w.bare,
            );

            const expectedRepo =
              expectedBinding.repositoryId === undefined
                ? undefined
                : registry.repositories.find((r) => r.id === expectedBinding.repositoryId);
            const expectedWt =
              expectedBinding.worktreeId === undefined
                ? undefined
                : registry.worktrees.find((w) => w.id === expectedBinding.worktreeId);

            const repoMatches =
              expectedRepo !== undefined &&
              matchedRepo !== undefined &&
              matchedRepo.id === expectedRepo.id;
            const checkoutMatches =
              expectedWt !== undefined &&
              matchedRaw !== undefined &&
              expectedWt.folderIdentity !== undefined &&
              matchedRaw.folderIdentity !== undefined &&
              expectedWt.folderIdentity === matchedRaw.folderIdentity;

            if (repoMatches && checkoutMatches) {
              const reconciled = reconcileRegistry(probe, registry, now, {
                worktreeId: expectedWt.id,
                targetKey: targetTopKey,
              });
              yield* writeRegistry(reconciled.nextRegistry);
              const inv: WorktreeInventory = {
                ...(projectId === undefined ? {} : { projectId }),
                cwd: targetTop,
                capability: toCapability(probe),
                repositoryId: reconciled.repositoryId,
                commonDir: probe.commonDirRealPath,
                ...(reconciled.currentWorktreeId === undefined
                  ? {}
                  : { currentWorktreeId: reconciled.currentWorktreeId }),
                worktrees: reconciled.entries,
                refreshedAt: now,
              };
              const entry = reconciled.entries.find((e) => e.id === expectedWt.id);
              if (entry !== undefined && !entry.missing) {
                return {
                  publish: inv,
                  value: {
                    _tag: 'Verified' as const,
                    entry,
                    binding: toResolvedWorktreeBinding(entry),
                    inventory: inv,
                  },
                };
              }
            }

            if (!allowRebind) {
              const candidatePath = matchedRaw?.realPath ?? targetTop;
              let mismatchReason: WorktreeLocateMismatchReason;
              let detail: string;
              if (
                expectedBinding.repositoryId === undefined ||
                expectedRepo === undefined ||
                expectedWt === undefined
              ) {
                mismatchReason = 'NoPriorIdentity';
                detail =
                  'This Session has no prior Git checkout identity; confirm to rebind to the selected folder.';
              } else if (!repoMatches) {
                mismatchReason = 'DifferentRepository';
                detail =
                  'Selected folder belongs to a different Git repository than the bound Worktree.';
              } else if (matchedRaw === undefined) {
                mismatchReason = 'UnregisteredWorktree';
                detail =
                  'Folder is not registered as an active Worktree in git worktree list; run git worktree repair or choose a registered Worktree.';
              } else if (expectedWt.pathKey === folderKey(candidatePath, platform)) {
                mismatchReason = 'ReplacedFolder';
                detail =
                  'Directory at this path does not match the original Worktree filesystem identity.';
              } else {
                mismatchReason = 'DifferentCheckout';
                detail =
                  'Selected folder is a different checkout or copy within the repository; confirm to rebind this Session.';
              }
              return {
                publish: undefined,
                value: {
                  _tag: 'RequiresRebind' as const,
                  mismatchReason,
                  candidatePath,
                  detail,
                },
              };
            }

            if (matchedRaw === undefined) {
              return yield* Effect.fail(
                new WorktreesError({
                  reason: 'UnsupportedRepo',
                  detail:
                    'Selected folder is not registered in git worktree list; repair Git registration or pick a registered Worktree.',
                }),
              );
            }

            const reconciled = reconcileRegistry(probe, registry, now);
            yield* writeRegistry(reconciled.nextRegistry);
            const inv: WorktreeInventory = {
              ...(projectId === undefined ? {} : { projectId }),
              cwd: targetTop,
              capability: toCapability(probe),
              repositoryId: reconciled.repositoryId,
              commonDir: probe.commonDirRealPath,
              ...(reconciled.currentWorktreeId === undefined
                ? {}
                : { currentWorktreeId: reconciled.currentWorktreeId }),
              worktrees: reconciled.entries,
              refreshedAt: now,
            };
            const targetEntry = reconciled.entries.find(
              (e) => e.id === reconciled.currentWorktreeId && !e.missing,
            );
            if (targetEntry === undefined) {
              return yield* Effect.fail(
                new WorktreesError({
                  reason: 'UnsupportedRepo',
                  detail: 'Could not resolve a registered Worktree at the selected path.',
                }),
              );
            }
            return {
              publish: inv,
              value: {
                _tag: 'Rebound' as const,
                binding: toResolvedWorktreeBinding(targetEntry),
                inventory: inv,
              },
            };
          }),
        );

        if (result.publish !== undefined) {
          cacheInventory(targetPath, result.publish);
          yield* PubSub.publish(updates, result.publish);
        }
        return result.value;
      });

      return {
        platform,
        inventory: getInventory,
        refresh: runDiscovery,
        locate,
        reconcileBinding: reconcileWorktreeBinding,
        updates: Stream.fromPubSub(updates),
      } satisfies WorktreesShape;
    }),
  );

/** Temporary placeholder layer used by tests that do not test Git Worktree discovery. */
export const layerWorktreesStub: Layer.Layer<Worktrees> = Layer.succeed(Worktrees, {
  platform: process.platform,
  inventory: (targetPath, projectId) =>
    Effect.succeed({
      ...(projectId === undefined ? {} : { projectId }),
      cwd: targetPath,
      capability: {
        _tag: 'NonGit',
        path: targetPath,
        detail: 'Worktree discovery is disabled in this test layer.',
      },
      worktrees: [],
      refreshedAt: Date.now(),
    }),
  refresh: (targetPath, projectId) =>
    Effect.succeed({
      ...(projectId === undefined ? {} : { projectId }),
      cwd: targetPath,
      capability: {
        _tag: 'NonGit',
        path: targetPath,
        detail: 'Worktree discovery is disabled in this test layer.',
      },
      worktrees: [],
      refreshedAt: Date.now(),
    }),
  locate: ({ expectedBinding, targetPath, projectId, allowRebind }) =>
    Effect.succeed(
      allowRebind
        ? {
            _tag: 'Rebound',
            binding: {
              state: 'resolved',
              expectedPath: targetPath,
              reason: 'NonGit',
              detail: 'Worktree discovery is disabled in this test layer.',
            },
            inventory: {
              ...(projectId === undefined ? {} : { projectId }),
              cwd: targetPath,
              capability: {
                _tag: 'NonGit',
                path: targetPath,
                detail: 'Worktree discovery is disabled in this test layer.',
              },
              worktrees: [],
              refreshedAt: Date.now(),
            },
          }
        : {
            _tag: 'RequiresRebind',
            mismatchReason:
              expectedBinding.repositoryId !== undefined ? 'NonGit' : 'NoPriorIdentity',
            candidatePath: targetPath,
            detail: 'Worktree discovery is disabled in this test layer.',
          },
    ),
  reconcileBinding: reconcileWorktreeBinding,
  updates: Stream.empty,
});
