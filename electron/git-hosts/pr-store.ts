import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { Timestamp, type ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  HostCapabilities,
  PullRequestDetail,
  PullRequestSummary,
  RemoteRepoRef,
  WorktreePullRequestLink,
  type PullRequestDiff,
  type PullRequestNumber,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { Store, type VersionedFile } from '../store/store';

export const DETAILS_LRU_CAPACITY = 20;
export const DIFFS_LRU_CAPACITY = 15;

const StoredProjectSummaries = Schema.Struct({
  repo: RemoteRepoRef,
  targetRemoteName: Schema.String,
  headRemoteName: Schema.String,
  capabilities: HostCapabilities,
  lastSyncedAt: Timestamp,
  summaries: Schema.Array(PullRequestSummary),
  worktreeLinks: Schema.Record(Schema.String, WorktreePullRequestLink),
});
export type StoredProjectSummaries = typeof StoredProjectSummaries.Type;

const StoredProjectDetails = Schema.Struct({
  entries: Schema.Array(PullRequestDetail),
});
type StoredProjectDetails = typeof StoredProjectDetails.Type;

const summariesFile = (projectId: ProjectId): VersionedFile<StoredProjectSummaries | null> => ({
  file: `pull-requests/projects/${projectId}/summaries.json`,
  version: 1,
  migrations: [],
  schema: Schema.NullOr(StoredProjectSummaries),
  initial: () => null,
});

const detailsFile = (projectId: ProjectId): VersionedFile<StoredProjectDetails> => ({
  file: `pull-requests/projects/${projectId}/details-lru.json`,
  version: 1,
  migrations: [],
  schema: StoredProjectDetails,
  initial: () => ({ entries: [] }),
});

export interface PrStoreShape {
  readonly loadSummaries: (projectId: ProjectId) => Effect.Effect<StoredProjectSummaries | null>;
  readonly saveSummaries: (
    projectId: ProjectId,
    data: StoredProjectSummaries,
  ) => Effect.Effect<void>;
  readonly getDetail: (
    projectId: ProjectId,
    number: PullRequestNumber,
  ) => Effect.Effect<PullRequestDetail | null>;
  readonly saveDetail: (projectId: ProjectId, detail: PullRequestDetail) => Effect.Effect<void>;
  readonly getDiff: (
    projectId: ProjectId,
    number: PullRequestNumber,
    headSha: string,
  ) => Effect.Effect<PullRequestDiff | null>;
  readonly putDiff: (projectId: ProjectId, diff: PullRequestDiff) => Effect.Effect<void>;
  readonly evictProject: (projectId: ProjectId) => Effect.Effect<void>;
  readonly evictAll: () => Effect.Effect<void>;
}

/** Disk-backed (summaries + 20-entry details LRU) and memory-only (15-entry diffs LRU) PR cache. */
export class PrStore extends Context.Service<PrStore, PrStoreShape>()('git-hosts/PrStore') {}

const diffCacheKey = (projectId: ProjectId, number: PullRequestNumber, headSha: string): string =>
  `${projectId}\0${number}\0${headSha}`;

export const layerPrStore = Layer.effect(
  PrStore,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Semaphore.make(1);
    const diffCache = new Map<
      string,
      { readonly projectId: ProjectId; readonly diff: PullRequestDiff }
    >();
    const detailMemCache = new Map<ProjectId, ReadonlyArray<PullRequestDetail>>();

    const loadSummaries: PrStoreShape['loadSummaries'] = Effect.fnUntraced(function* (projectId) {
      return yield* store
        .readVersioned(summariesFile(projectId))
        .pipe(Effect.catchTag('StoreError', () => Effect.succeed(null)));
    });

    const saveSummaries: PrStoreShape['saveSummaries'] = (projectId, data) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          // Strip session-only #number pins before persisting to disk.
          const persistedSummaries = data.summaries.filter((s) => s.isPinned !== true);
          yield* store.writeVersioned(summariesFile(projectId), {
            ...data,
            summaries: persistedSummaries,
          });
        }),
      );

    const getDetail: PrStoreShape['getDetail'] = (projectId, number) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          let entries = detailMemCache.get(projectId);
          if (entries === undefined) {
            const current = yield* store
              .readVersioned(detailsFile(projectId))
              .pipe(Effect.catchTag('StoreError', () => Effect.succeed({ entries: [] })));
            entries = current.entries;
            detailMemCache.set(projectId, entries);
          }
          const idx = entries.findIndex((entry) => entry.ref.number === number);
          if (idx === -1) return null;
          const found = entries[idx];
          if (found === undefined) return null;
          if (idx < entries.length - 1) {
            const reordered = [...entries.slice(0, idx), ...entries.slice(idx + 1), found];
            detailMemCache.set(projectId, reordered);
            yield* store.writeVersioned(detailsFile(projectId), { entries: reordered });
          }
          return found;
        }),
      );

    const saveDetail: PrStoreShape['saveDetail'] = (projectId, detail) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          let entries = detailMemCache.get(projectId);
          if (entries === undefined) {
            const current = yield* store
              .readVersioned(detailsFile(projectId))
              .pipe(Effect.catchTag('StoreError', () => Effect.succeed({ entries: [] })));
            entries = current.entries;
          }
          const filtered = entries.filter((entry) => entry.ref.number !== detail.ref.number);
          const next = [...filtered, detail].slice(-DETAILS_LRU_CAPACITY);
          detailMemCache.set(projectId, next);
          yield* store.writeVersioned(detailsFile(projectId), { entries: next });
        }),
      );

    const getDiff: PrStoreShape['getDiff'] = (projectId, number, headSha) =>
      Effect.sync(() => {
        const key = diffCacheKey(projectId, number, headSha);
        const existing = diffCache.get(key);
        if (existing === undefined) return null;
        diffCache.delete(key);
        diffCache.set(key, existing);
        return existing.diff;
      });

    const putDiff: PrStoreShape['putDiff'] = (projectId, diff) =>
      Effect.sync(() => {
        const key = diffCacheKey(projectId, diff.ref.number, diff.headSha);
        if (diffCache.has(key)) {
          diffCache.delete(key);
        }
        diffCache.set(key, { projectId, diff });
        while (diffCache.size > DIFFS_LRU_CAPACITY) {
          const oldest = diffCache.keys().next().value;
          if (oldest === undefined) break;
          diffCache.delete(oldest);
        }
      });

    const evictProject: PrStoreShape['evictProject'] = (projectId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          detailMemCache.delete(projectId);
          for (const [key, entry] of diffCache.entries()) {
            if (entry.projectId === projectId) {
              diffCache.delete(key);
            }
          }
          yield* store.removeDir(`pull-requests/projects/${projectId}`);
        }),
      );

    const evictAll: PrStoreShape['evictAll'] = () =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          detailMemCache.clear();
          diffCache.clear();
          yield* store.removeDir('pull-requests');
        }),
      );

    return {
      loadSummaries,
      saveSummaries,
      getDetail,
      saveDetail,
      getDiff,
      putDiff,
      evictProject,
      evictAll,
    };
  }),
);
