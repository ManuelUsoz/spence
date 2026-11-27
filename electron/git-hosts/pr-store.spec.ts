import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  PullRequestNumber,
  type HostCapabilities,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { layerStore } from '../store/store';
import { layerPrStore, PrStore } from './pr-store';

const repo: RemoteRepoRef = { host: 'github', canonicalPath: 'org/repo' };

const capabilities: HostCapabilities = {
  supportsDraft: true,
  supportsThreadResolution: true,
  supportsAutoMerge: true,
  supportsPendingReviews: true,
  supportsMilestones: true,
  supportedMergeMethods: ['merge', 'squash', 'rebase'],
};

const makeSummary = (num: number, extra?: Partial<PullRequestSummary>): PullRequestSummary => ({
  ref: { repo, number: PullRequestNumber.make(num) },
  title: `PR #${num}`,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: `feat/${num}`,
  headSha: `sha-${num}`,
  headRepo: repo,
  baseRef: 'main',
  updatedAt: 1_000 + num,
  url: `https://github.com/org/repo/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: [],
  isCrossRepo: false,
  ...extra,
});

const makeDetail = (num: number): PullRequestDetail => ({
  ...makeSummary(num),
  body: `Body for #${num}`,
  mergeState: 'clean',
  autoMergeEnabled: false,
  labels: [],
  reviewers: [],
  assignees: [],
  milestone: null,
  repoLabels: [],
  repoMilestones: [],
  collaborators: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  comments: [],
  actions: {
    canUpdate: true,
    canMerge: true,
    canReview: true,
    canApproveOrRequestChanges: true,
    canResolveThreads: true,
    allowedMergeMethods: ['merge', 'squash', 'rebase'],
  },
  revision: { headSha: `sha-${num}`, updatedAt: 1_000 + num },
});

const makeDiff = (num: number): PullRequestDiff => ({
  ref: { repo, number: PullRequestNumber.make(num) },
  headSha: `sha-${num}`,
  baseSha: 'base-sha',
  files: [],
});

const withTempPrStore = <A>(
  run: (root: string) => Effect.Effect<A, never, PrStore>,
): Effect.Effect<A> =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-pr-store-'))),
    (root) => run(root).pipe(Effect.provide(layerPrStore.pipe(Layer.provide(layerStore(root))))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

describe('PrStore', () => {
  it.effect(
    'persists summaries.json across restarts while stripping session-only #number pins',
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-pr-store-restart-'))),
        (root) =>
          Effect.gen(function* () {
            const projectId = ProjectId.make('proj-1');
            const layer1 = layerPrStore.pipe(Layer.provide(layerStore(root)));
            yield* Effect.gen(function* () {
              const prStore = yield* PrStore;
              yield* prStore.saveSummaries(projectId, {
                repo,
                targetRemoteName: 'origin',
                headRemoteName: 'origin',
                capabilities,
                lastSyncedAt: 5_000,
                summaries: [makeSummary(1), makeSummary(99, { isPinned: true })],
                worktreeLinks: {},
              });
            }).pipe(Effect.provide(layer1));

            // Fresh PrStore instance reading from the same Store root
            const layer2 = layerPrStore.pipe(Layer.provide(layerStore(root)));
            const loaded = yield* Effect.gen(function* () {
              const prStore = yield* PrStore;
              return yield* prStore.loadSummaries(projectId);
            }).pipe(Effect.provide(layer2));

            expect(loaded).not.toBeNull();
            expect(loaded?.summaries.map((s) => s.ref.number)).toEqual([1]);
          }),
        (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
      ),
  );

  it.effect('caps details-lru.json at 20 most recently viewed PR details', () =>
    withTempPrStore((root) =>
      Effect.gen(function* () {
        const prStore = yield* PrStore;
        const projectId = ProjectId.make('proj-lru');

        for (let i = 1; i <= 25; i++) {
          yield* prStore.saveDetail(projectId, makeDetail(i));
        }
        // Re-touch PR #6 so it becomes most recently used
        yield* prStore.saveDetail(projectId, makeDetail(6));

        const cached6 = yield* prStore.getDetail(projectId, PullRequestNumber.make(6));
        const cached1 = yield* prStore.getDetail(projectId, PullRequestNumber.make(1));
        const cached7 = yield* prStore.getDetail(projectId, PullRequestNumber.make(7));

        expect(cached6?.ref.number).toBe(6);
        expect(cached1).toBeNull();
        expect(cached7?.ref.number).toBe(7);

        // Also verify fresh instance loads the 20 entries from disk
        const layer2 = layerPrStore.pipe(Layer.provide(layerStore(root)));
        const countOnDisk = yield* Effect.gen(function* () {
          const s2 = yield* PrStore;
          const d6 = yield* s2.getDetail(projectId, PullRequestNumber.make(6));
          const d5 = yield* s2.getDetail(projectId, PullRequestNumber.make(5));
          return { has6: d6 !== null, has5: d5 !== null };
        }).pipe(Effect.provide(layer2));

        expect(countOnDisk).toEqual({ has6: true, has5: false });
      }),
    ),
  );

  it.effect('keeps diffs in a 15-item memory-only LRU and never writes them to disk', () =>
    withTempPrStore((root) =>
      Effect.gen(function* () {
        const prStore = yield* PrStore;
        const projectId = ProjectId.make('proj-diff');

        for (let i = 1; i <= 17; i++) {
          yield* prStore.putDiff(projectId, makeDiff(i));
        }

        expect(yield* prStore.getDiff(projectId, PullRequestNumber.make(1), 'sha-1')).toBeNull();
        expect(yield* prStore.getDiff(projectId, PullRequestNumber.make(2), 'sha-2')).toBeNull();
        expect(
          yield* prStore.getDiff(projectId, PullRequestNumber.make(3), 'sha-3'),
        ).not.toBeNull();
        expect(
          yield* prStore.getDiff(projectId, PullRequestNumber.make(17), 'sha-17'),
        ).not.toBeNull();
        expect(existsSync(path.join(root, 'pull-requests', 'projects', 'proj-diff'))).toBe(false);
      }),
    ),
  );

  it.effect(
    'evicts project directory and in-memory state on evictProject and wipes all on evictAll',
    () =>
      withTempPrStore((root) =>
        Effect.gen(function* () {
          const prStore = yield* PrStore;
          const p1 = ProjectId.make('proj-a');
          const p2 = ProjectId.make('proj-b');

          yield* prStore.saveSummaries(p1, {
            repo,
            targetRemoteName: 'origin',
            headRemoteName: 'origin',
            capabilities,
            lastSyncedAt: 1_000,
            summaries: [makeSummary(1)],
            worktreeLinks: {},
          });
          yield* prStore.saveDetail(p1, makeDetail(1));
          yield* prStore.putDiff(p1, makeDiff(1));

          yield* prStore.saveSummaries(p2, {
            repo,
            targetRemoteName: 'origin',
            headRemoteName: 'origin',
            capabilities,
            lastSyncedAt: 2_000,
            summaries: [makeSummary(2)],
            worktreeLinks: {},
          });

          yield* prStore.evictProject(p1);
          expect(existsSync(path.join(root, 'pull-requests', 'projects', 'proj-a'))).toBe(false);
          expect(yield* prStore.loadSummaries(p1)).toBeNull();
          expect(yield* prStore.getDetail(p1, PullRequestNumber.make(1))).toBeNull();
          expect(yield* prStore.getDiff(p1, PullRequestNumber.make(1), 'sha-1')).toBeNull();
          expect(existsSync(path.join(root, 'pull-requests', 'projects', 'proj-b'))).toBe(true);

          yield* prStore.evictAll();
          expect(existsSync(path.join(root, 'pull-requests'))).toBe(false);
          expect(yield* prStore.loadSummaries(p2)).toBeNull();
        }),
      ),
  );
});
