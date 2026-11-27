import { it } from '@effect/vitest';
import { Duration, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { ProjectId, type Project } from '../../src/shared/projects/projects.rpc';
import {
  CommentId,
  GitHostError,
  PullRequestNumber,
  ReviewId,
  ReviewThreadId,
  type HostAccount,
  type HostAccountsState,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  type Settings as AppSettings,
} from '../../src/shared/settings/settings.rpc';
import { Projects } from '../projects/projects';
import { Settings } from '../settings/settings';
import { layerWindowFocus, WindowFocus } from '../sessions/window-focus';
import { layerStore } from '../store/store';
import { layerGitHostRegistry, type GitHost } from './git-host';
import { GITHUB_CAPABILITIES } from './github-adapter';
import { HostAuth, type HostAuthShape } from './host-auth';
import { PrStore, type StoredProjectSummaries } from './pr-store';
import {
  layerPullRequestsService,
  LocalBranchCoordinator,
  ProjectGitInspector,
  PullRequestsService,
  WorktreeSessionChecker,
  type InspectedWorktree,
  type LocalBranchCoordinatorShape,
  type WorktreeSessionCheckerShape,
} from './pull-requests-service';

const repo: RemoteRepoRef = { host: 'github', canonicalPath: 'org/repo' };
const projectId = ProjectId.make('proj-1');

const sampleProject: Project = {
  id: projectId,
  name: 'spence',
  path: '/tmp/spence',
  addedAt: 1_000,
  lastUsedAt: 1_000,
  settings: {},
  folderMissing: false,
};

const makeSummary = (num: number, overrides?: Partial<PullRequestSummary>): PullRequestSummary => ({
  ref: { repo, number: PullRequestNumber.make(num) },
  title: `PR #${num}`,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: 'feat/x',
  headSha: `sha-${num}`,
  headRepo: repo,
  baseRef: 'main',
  updatedAt: 2_000 + num,
  url: `https://github.com/org/repo/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: [],
  isCrossRepo: false,
  ...overrides,
});

const makeDetail = (num: number, overrides?: Partial<PullRequestDetail>): PullRequestDetail => ({
  ...makeSummary(num),
  body: 'body',
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
    allowedMergeMethods: ['merge', 'squash'],
  },
  revision: { headSha: `sha-${num}`, updatedAt: 2_000 + num },
  ...overrides,
});

const connectedAccount: HostAccount = {
  host: 'github',
  handle: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
  authMethod: 'pat',
  scopes: ['repo', 'read:org'],
  status: 'connected',
  statusDetail: null,
  persistMode: 'secure',
  updatedAt: 1_000,
};

const makeHarness = (options: {
  readonly storeRoot: string;
  readonly listForRepo: GitHost['listForRepo'];
  readonly getDetail?: GitHost['getDetail'];
  readonly getSummaryByNumber?: GitHost['getSummaryByNumber'];
  readonly merge?: GitHost['merge'];
  readonly setAutoMerge?: GitHost['setAutoMerge'];
  readonly worktrees?: ReadonlyArray<InspectedWorktree>;
  readonly localBranchCoordinator?: LocalBranchCoordinatorShape;
  readonly sessionChecker?: WorktreeSessionCheckerShape;
  readonly autoUpdateBaseBranchAfterMerge?: boolean;
  readonly update?: GitHost['update'];
  readonly addComment?: GitHost['addComment'];
  readonly editComment?: GitHost['editComment'];
  readonly deleteComment?: GitHost['deleteComment'];
  readonly submitReview?: GitHost['submitReview'];
  readonly deletePendingReview?: GitHost['deletePendingReview'];
  readonly resolveThread?: GitHost['resolveThread'];
  readonly unresolveThread?: GitHost['unresolveThread'];
}) => {
  let accountStatus: HostAccount['status'] = 'connected';
  const fakeAuth: HostAuthShape = {
    getAccounts: Effect.sync((): HostAccountsState => ({
      accounts: [{ ...connectedAccount, status: accountStatus }],
      secretStorageAvailable: true,
    })),
    startDeviceFlow: () => Effect.die('unused'),
    pollDeviceFlow: () => Effect.die('unused'),
    cancelDeviceFlow: () => Effect.void,
    connectPat: () => Effect.die('unused'),
    checkGhCli: () => Effect.die('unused'),
    importGhCli: () => Effect.die('unused'),
    verify: () => Effect.die('unused'),
    markNeedsReconnect: (_host, _detail) =>
      Effect.sync(() => {
        accountStatus = 'needs-reconnect';
      }),
    disconnect: () => Effect.void,
    withToken: (_host, use) => use('tok'),
  };

  const fakeHost: GitHost = {
    kind: 'github',
    capabilities: GITHUB_CAPABILITIES,
    parseRemoteUrl: () => repo,
    listForRepo: options.listForRepo,
    getSummaryByNumber:
      options.getSummaryByNumber ?? (({ number }) => Effect.succeed(makeSummary(Number(number)))),
    getDetail:
      options.getDetail ??
      (({ number }) => Effect.succeed({ notModified: false, detail: makeDetail(Number(number)) })),
    getDiff: ({ number, headSha, baseSha }) =>
      Effect.succeed({ ref: { repo, number }, headSha, baseSha, files: [] }),
    merge:
      options.merge ??
      (({ number }) => Effect.succeed(makeDetail(Number(number), { state: 'merged' }))),
    setAutoMerge:
      options.setAutoMerge ??
      (({ number, enabled }) =>
        Effect.succeed(makeDetail(Number(number), { autoMergeEnabled: enabled }))),
    update:
      options.update ??
      (({ currentDetail, patch }) =>
        Effect.succeed({
          ...currentDetail,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
        })),
    addComment: options.addComment ?? (() => Effect.die('unused')),
    editComment: options.editComment ?? (() => Effect.die('unused')),
    deleteComment: options.deleteComment ?? (() => Effect.die('unused')),
    submitReview: options.submitReview ?? (() => Effect.die('unused')),
    deletePendingReview: options.deletePendingReview ?? (() => Effect.die('unused')),
    resolveThread: options.resolveThread ?? (() => Effect.die('unused')),
    unresolveThread: options.unresolveThread ?? (() => Effect.die('unused')),
    clearEtags: () => Effect.void,
  };

  const fakeProjects = Layer.succeed(Projects, {
    list: Effect.succeed([sampleProject]),
    add: Effect.die('unused'),
    addFolder: () => Effect.die('unused'),
    rename: () => Effect.die('unused'),
    remove: () => Effect.void,
    locate: () => Effect.die('unused'),
    locateFolder: () => Effect.die('unused'),
    check: (id) =>
      id === projectId ? Effect.succeed(sampleProject) : Effect.die('unknown project'),
    setSettings: () => Effect.die('unused'),
    touch: () => Effect.void,
  });

  const fakeInspector = Layer.succeed(ProjectGitInspector, {
    inspectProject: () =>
      Effect.succeed({
        _tag: 'Available' as const,
        remotesOutput: 'origin\thttps://github.com/org/repo.git (fetch)\n',
        worktrees: options.worktrees ?? [
          {
            key: '/tmp/spence',
            branch: 'feat/x',
            headSha: 'sha-1',
            isDetached: false,
          },
        ],
      }),
  });

  const fakeLocalCoordinator = Layer.succeed(
    LocalBranchCoordinator,
    options.localBranchCoordinator ?? {
      isWorktreeClean: () => Effect.succeed(true),
      pullFastForward: () => Effect.succeed({ _tag: 'Done', detail: 'Already up to date.' }),
      fetchBranchFastForward: () => Effect.succeed({ _tag: 'Done', detail: 'Fetched.' }),
      checkoutBranch: () => Effect.succeed({ _tag: 'Done', detail: 'Switched.' }),
    },
  );

  const fakeSessionChecker = Layer.succeed(
    WorktreeSessionChecker,
    options.sessionChecker ?? {
      hasRunningSession: () => Effect.succeed(false),
    },
  );

  const fakeSettings = Layer.succeed(Settings, {
    get: Effect.succeed({
      pullRequests: {
        ...DEFAULT_PULL_REQUEST_SETTINGS,
        autoUpdateBaseBranchAfterMerge: options.autoUpdateBaseBranchAfterMerge ?? true,
      },
    } as AppSettings),
    update: () => Effect.die('unused'),
    changes: undefined as never,
  });

  const base = Layer.mergeAll(
    layerStore(options.storeRoot),
    layerWindowFocus,
    Layer.succeed(HostAuth, fakeAuth),
    layerGitHostRegistry([fakeHost]),
    fakeProjects,
    fakeInspector,
    fakeLocalCoordinator,
    fakeSessionChecker,
    fakeSettings,
  );
  const summariesMap = new Map<ProjectId, StoredProjectSummaries>();
  const detailsMap = new Map<string, PullRequestDetail>();
  const diffsMap = new Map<string, PullRequestDiff>();
  const prStoreLayer = Layer.succeed(PrStore, {
    loadSummaries: (pid) => Effect.sync(() => summariesMap.get(pid) ?? null),
    saveSummaries: (pid, data) => Effect.sync(() => void summariesMap.set(pid, data)),
    getDetail: (pid, num) => Effect.sync(() => detailsMap.get(`${pid}:${num}`) ?? null),
    saveDetail: (pid, detail) =>
      Effect.sync(() => void detailsMap.set(`${pid}:${detail.ref.number}`, detail)),
    getDiff: (pid, num, sha) => Effect.sync(() => diffsMap.get(`${pid}:${num}:${sha}`) ?? null),
    putDiff: (pid, diff) =>
      Effect.sync(() => void diffsMap.set(`${pid}:${diff.ref.number}:${diff.headSha}`, diff)),
    evictProject: (pid) =>
      Effect.sync(() => {
        summariesMap.delete(pid);
      }),
    evictAll: () =>
      Effect.sync(() => {
        summariesMap.clear();
        detailsMap.clear();
        diffsMap.clear();
      }),
  });
  return layerPullRequestsService.pipe(Layer.provideMerge(Layer.mergeAll(base, prStoreLayer)));
};

describe('PullRequestsService polling & lifecycle', () => {
  it.effect(
    'polls at 60s on PR page, 3m in Session view, and 20s for pending-check details, pausing on blur with 30s focus cooldown',
    () =>
      Effect.gen(function* () {
        const storeRoot = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), 'spence-pr-svc-')),
        );
        let listCalls = 0;
        let detailCalls = 0;

        const layer = makeHarness({
          storeRoot,
          listForRepo: () =>
            Effect.sync(() => {
              listCalls += 1;
              return {
                notModified: false,
                summaries: [makeSummary(1, { checkRollup: 'pending' })],
              };
            }),
          getDetail: () =>
            Effect.sync(() => {
              detailCalls += 1;
              return {
                notModified: false,
                detail: makeDetail(1, { checkRollup: 'pending' }),
              };
            }),
        });

        yield* Effect.gen(function* () {
          const focus = yield* WindowFocus;
          const svc = yield* PullRequestsService;

          // Focus window & open PR page
          yield* focus.setFocused(true);
          yield* svc.setActiveView({
            projectId,
            prPageOpen: true,
            activePrNumber: PullRequestNumber.make(1),
          });
          yield* svc.getDetail(projectId, PullRequestNumber.make(1), true);
          detailCalls = 0;
          yield* TestClock.adjust(Duration.millis(10));
          const initialList = listCalls;
          expect(initialList).toBeGreaterThanOrEqual(1);

          // 20s ticks: pending-check detail poll fires
          yield* TestClock.adjust(Duration.seconds(20));
          expect(detailCalls).toBeGreaterThanOrEqual(1);

          // 60s total: summary poll fires on PR page
          yield* TestClock.adjust(Duration.seconds(40));
          expect(listCalls).toBeGreaterThan(initialList);
          const listAfter60s = listCalls;
          const detailAfter60s = detailCalls;

          // Blur window: no polls fire even after 5 minutes
          yield* focus.setFocused(false);
          yield* TestClock.adjust(Duration.minutes(5));
          expect(listCalls).toBe(listAfter60s);
          expect(detailCalls).toBe(detailAfter60s);

          // Re-focus after 5m (> 30s cooldown): immediate refresh fires
          yield* focus.setFocused(true);
          yield* TestClock.adjust(Duration.millis(10));
          expect(listCalls).toBe(listAfter60s + 1);
          const listAfterRefocus = listCalls;

          // Blur & re-focus within 10s (< 30s cooldown): does NOT refresh
          yield* focus.setFocused(false);
          yield* TestClock.adjust(Duration.seconds(10));
          yield* focus.setFocused(true);
          yield* TestClock.adjust(Duration.millis(10));
          expect(listCalls).toBe(listAfterRefocus);

          // Switch to Session view (prPageOpen: false): cadence becomes 3m (no poll at 60s, poll at 3m)
          yield* svc.setActiveView({
            projectId,
            prPageOpen: false,
            activePrNumber: null,
          });
          yield* TestClock.adjust(Duration.millis(1));
          yield* TestClock.adjust(Duration.seconds(60));
          expect(listCalls).toBe(listAfterRefocus);
          yield* TestClock.adjust(Duration.minutes(2));
          yield* TestClock.adjust(Duration.millis(10));
          expect(listCalls).toBe(listAfterRefocus + 1);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => rm(storeRoot, { recursive: true, force: true }))),
        );
      }),
  );

  it.effect('suspends polling on RateLimited until resetAt and supports lookupByNumber pins', () =>
    Effect.gen(function* () {
      const storeRoot = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), 'spence-pr-rate-')),
      );
      let listCalls = 0;
      let shouldRateLimit = true;

      const layer = makeHarness({
        storeRoot,
        listForRepo: () =>
          Effect.gen(function* () {
            listCalls += 1;
            if (shouldRateLimit) {
              return yield* new GitHostError({
                reason: 'RateLimited',
                detail: 'API rate limit exceeded',
                resetAt: 120_000,
              });
            }
            return { notModified: false, summaries: [makeSummary(1)] };
          }),
      });

      yield* Effect.gen(function* () {
        const focus = yield* WindowFocus;
        const svc = yield* PullRequestsService;
        yield* focus.setFocused(true);
        yield* svc.setActiveView({ projectId, prPageOpen: true, activePrNumber: null });
        yield* TestClock.adjust(Duration.millis(10));

        const state1 = yield* svc.getProjectState(projectId);
        expect(state1._tag).toBe('Available');
        if (state1._tag === 'Available') {
          expect(state1.syncStatus.status).toBe('rate-limited');
          expect(state1.syncStatus.resetAt).toBe(120_000);
        }

        const callsAtRateLimit = listCalls;
        // At 60s, still before resetAt (120s), polling is suspended
        yield* TestClock.adjust(Duration.seconds(60));
        expect(listCalls).toBe(callsAtRateLimit);

        // Pin #99 on demand
        const pinned = yield* svc.lookupByNumber(projectId, PullRequestNumber.make(99));
        expect(pinned.isPinned).toBe(true);
        const stateAfterPin = yield* svc.getProjectState(projectId);
        if (stateAfterPin._tag === 'Available') {
          expect(stateAfterPin.summaries.some((s) => s.ref.number === 99)).toBe(true);
        }

        // Unpin #99
        yield* svc.unpinNumber(projectId, PullRequestNumber.make(99));
        const stateAfterUnpin = yield* svc.getProjectState(projectId);
        if (stateAfterUnpin._tag === 'Available') {
          expect(stateAfterUnpin.summaries.some((s) => s.ref.number === 99)).toBe(false);
        }

        // Past resetAt (120s): polling resumes
        shouldRateLimit = false;
        yield* TestClock.adjust(Duration.seconds(65));
        expect(listCalls).toBeGreaterThan(callsAtRateLimit);
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.promise(() => rm(storeRoot, { recursive: true, force: true }))),
      );
    }),
  );

  it.effect(
    'merges PR, auto-updates clean idle base worktree via pull, ref-only via fetch, and refuses dirty/busy',
    () =>
      Effect.gen(function* () {
        const storeRoot = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), 'spence-pr-merge-svc-')),
        );
        const pullCalls: string[] = [];
        const fetchCalls: Array<{ folder: string; remote: string; branch: string }> = [];
        const checkoutCalls: Array<{ folder: string; branch: string }> = [];
        const cleanMap: Record<string, boolean> = {
          '/tmp/spence-main': true,
          '/tmp/spence-feat': true,
        };
        const busyMap: Record<string, boolean> = {
          '/tmp/spence-main': false,
          '/tmp/spence-feat': false,
        };
        const worktrees: InspectedWorktree[] = [
          { key: '/tmp/spence-main', branch: 'main', headSha: 'sha-main', isDetached: false },
          { key: '/tmp/spence-feat', branch: 'feat/x', headSha: 'sha-1', isDetached: false },
        ];

        const layer = makeHarness({
          storeRoot,
          listForRepo: () => Effect.succeed({ notModified: false, summaries: [makeSummary(1)] }),
          worktrees,
          localBranchCoordinator: {
            isWorktreeClean: (folder) => Effect.succeed(cleanMap[folder] ?? true),
            pullFastForward: (folder) =>
              Effect.sync(() => {
                pullCalls.push(folder);
                return { _tag: 'Done' as const, detail: 'Fast-forwarded' };
              }),
            fetchBranchFastForward: (folder, remote, branch) =>
              Effect.sync(() => {
                fetchCalls.push({ folder, remote, branch });
                return { _tag: 'Done' as const, detail: 'Fetched ref' };
              }),
            checkoutBranch: (folder, branch) =>
              Effect.sync(() => {
                checkoutCalls.push({ folder, branch });
                return { _tag: 'Done' as const, detail: 'Switched' };
              }),
          },
          sessionChecker: {
            hasRunningSession: (_pid, wt) => Effect.succeed(busyMap[wt] ?? false),
          },
        });

        yield* Effect.gen(function* () {
          const svc = yield* PullRequestsService;
          yield* svc.refreshProject(projectId);

          // 1. Merge with base branch checked out in clean, idle worktree -> pull --ff-only
          const res1 = yield* svc.merge({
            projectId,
            number: PullRequestNumber.make(1),
            expectedHeadSha: 'sha-1',
            method: 'squash',
          });
          expect(res1.detail.state).toBe('merged');
          expect(res1.baseUpdate).toMatchObject({
            _tag: 'Updated',
            strategy: 'pull',
            baseRef: 'main',
            worktreePath: '/tmp/spence-main',
          });
          expect(pullCalls).toEqual(['/tmp/spence-main']);

          // 2. Dirty base worktree -> Skipped(Dirty)
          cleanMap['/tmp/spence-main'] = false;
          const dirtyUpdate = yield* svc.updateLocalBaseBranch(projectId, 'main');
          expect(dirtyUpdate).toMatchObject({ _tag: 'Skipped', reason: 'Dirty' });
          expect(pullCalls).toHaveLength(1);

          // 3. Busy base worktree -> Skipped(Busy)
          cleanMap['/tmp/spence-main'] = true;
          busyMap['/tmp/spence-main'] = true;
          const busyUpdate = yield* svc.updateLocalBaseBranch(projectId, 'main');
          expect(busyUpdate).toMatchObject({ _tag: 'Skipped', reason: 'Busy' });
          expect(pullCalls).toHaveLength(1);

          // 4. Switch to base branch refused when checked out elsewhere
          const switchBlocked = yield* svc.switchToBaseBranch(
            projectId,
            '/tmp/spence-feat',
            'main',
          );
          expect(switchBlocked).toMatchObject({
            _tag: 'Rejected',
            reason: 'CheckedOutElsewhere',
          });

          // 5. When base branch is not checked out in any worktree -> fetch <remote> <base>:<base>
          worktrees.splice(0, 1); // remove /tmp/spence-main
          const fetchUpdate = yield* svc.updateLocalBaseBranch(projectId, 'main');
          expect(fetchUpdate).toMatchObject({
            _tag: 'Updated',
            strategy: 'fetch',
            baseRef: 'main',
            worktreePath: null,
          });
          expect(fetchCalls).toEqual([{ folder: '/tmp/spence', remote: 'origin', branch: 'main' }]);

          // 6. Switch to base branch succeeds on clean, idle merged worktree
          const switched = yield* svc.switchToBaseBranch(projectId, '/tmp/spence-feat', 'main');
          expect(switched).toMatchObject({
            _tag: 'Switched',
            baseRef: 'main',
            worktreePath: '/tmp/spence-feat',
          });
          expect(checkoutCalls).toEqual([{ folder: '/tmp/spence-feat', branch: 'main' }]);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => rm(storeRoot, { recursive: true, force: true }))),
        );
      }),
  );

  it.effect(
    'detects field-level conflicts on update when edited field changed remotely, but allows edits when only unrelated fields changed',
    () =>
      Effect.gen(function* () {
        const storeRoot = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), 'spence-pr-update-')),
        );
        const num = PullRequestNumber.make(10);
        const initial = makeDetail(10, {
          title: 'Original title',
          body: 'Original body',
          updatedAt: 1_000,
          revision: { headSha: 'sha-10', updatedAt: 1_000 },
        });
        let remote = initial;
        let updateCalls = 0;

        const layer = makeHarness({
          storeRoot,
          listForRepo: () => Effect.succeed({ notModified: false, summaries: [makeSummary(10)] }),
          getDetail: () => Effect.succeed({ notModified: false, detail: remote }),
          update: ({ currentDetail, patch }) => {
            updateCalls += 1;
            const next: PullRequestDetail = {
              ...currentDetail,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.body !== undefined ? { body: patch.body } : {}),
              updatedAt: currentDetail.updatedAt + 100,
              revision: {
                headSha: currentDetail.headSha,
                updatedAt: currentDetail.updatedAt + 100,
              },
            };
            remote = next;
            return Effect.succeed(next);
          },
        });

        yield* Effect.gen(function* () {
          const svc = yield* PullRequestsService;
          const loaded = yield* svc.getDetail(projectId, num);
          expect(loaded.title).toBe('Original title');

          // Remote changes ONLY body (unrelated to user's title edit)
          remote = {
            ...initial,
            body: 'Remote edited body',
            updatedAt: 2_000,
            revision: { headSha: 'sha-10', updatedAt: 2_000 },
          };

          const updated = yield* svc.update({
            projectId,
            number: num,
            revision: loaded.revision,
            patch: { title: 'My new title' },
          });
          expect(updated.title).toBe('My new title');
          expect(updated.body).toBe('Remote edited body');
          expect(updateCalls).toBe(1);

          // Now remote changes title as well; user tries to edit title using stale revision
          const staleRevision = updated.revision;
          remote = {
            ...updated,
            title: 'Someone else title',
            updatedAt: 3_000,
            revision: { headSha: 'sha-10', updatedAt: 3_000 },
          };

          const err = yield* svc
            .update({
              projectId,
              number: num,
              revision: staleRevision,
              patch: { title: 'My conflicting title' },
            })
            .pipe(Effect.flip);

          expect(err).toBeInstanceOf(GitHostError);
          expect(err.reason).toBe('Conflict');
          expect(err.conflictingFields).toEqual(['title']);
          expect(err.latestDetail?.title).toBe('Someone else title');
          expect(updateCalls).toBe(1);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => rm(storeRoot, { recursive: true, force: true }))),
        );
      }),
  );

  it.effect(
    'delegates comment, review, and thread-resolution mutations and updates cached detail + summary counts',
    () =>
      Effect.gen(function* () {
        const storeRoot = yield* Effect.promise(() =>
          mkdtemp(path.join(tmpdir(), 'spence-pr-mut-')),
        );
        const num = PullRequestNumber.make(11);
        const base = makeDetail(11, { commentCount: 0, unresolvedThreadCount: 1 });
        const afterResolve = makeDetail(11, { commentCount: 1, unresolvedThreadCount: 0 });

        const layer = makeHarness({
          storeRoot,
          listForRepo: () => Effect.succeed({ notModified: false, summaries: [makeSummary(11)] }),
          getDetail: () => Effect.succeed({ notModified: false, detail: base }),
          addComment: () => Effect.succeed(makeDetail(11, { commentCount: 1 })),
          editComment: () => Effect.succeed(makeDetail(11, { commentCount: 1 })),
          deleteComment: () => Effect.succeed(makeDetail(11, { commentCount: 0 })),
          submitReview: () => Effect.succeed(makeDetail(11, { reviewDecision: 'approved' })),
          deletePendingReview: () => Effect.succeed(base),
          resolveThread: () => Effect.succeed(afterResolve),
          unresolveThread: () => Effect.succeed(base),
        });

        yield* Effect.gen(function* () {
          const svc = yield* PullRequestsService;
          yield* svc.getProjectState(projectId);

          const c1 = yield* svc.addComment({
            projectId,
            number: num,
            body: 'hi',
            target: { _tag: 'General' },
          });
          expect(c1.commentCount).toBe(1);

          const c2 = yield* svc.editComment({
            projectId,
            number: num,
            commentId: CommentId.make('c1'),
            kind: 'issue',
            body: 'edited',
          });
          expect(c2.commentCount).toBe(1);

          const c3 = yield* svc.deleteComment({
            projectId,
            number: num,
            commentId: CommentId.make('c1'),
            kind: 'issue',
          });
          expect(c3.commentCount).toBe(0);

          const r1 = yield* svc.submitReview({
            projectId,
            number: num,
            event: 'approve',
            body: 'lgtm',
          });
          expect(r1.reviewDecision).toBe('approved');

          const r2 = yield* svc.deletePendingReview({
            projectId,
            number: num,
            reviewId: ReviewId.make('rev-1'),
          });
          expect(r2.reviews.length).toBe(0);

          const t1 = yield* svc.resolveThread({
            projectId,
            number: num,
            threadId: ReviewThreadId.make('thr-1'),
          });
          expect(t1.unresolvedThreadCount).toBe(0);

          const stateAfter = yield* svc.getProjectState(projectId);
          if (stateAfter._tag === 'Available') {
            expect(stateAfter.summaries[0]?.unresolvedThreadCount).toBe(0);
          }

          const t2 = yield* svc.unresolveThread({
            projectId,
            number: num,
            threadId: ReviewThreadId.make('thr-1'),
          });
          expect(t2.unresolvedThreadCount).toBe(1);
        }).pipe(
          Effect.provide(layer),
          Effect.ensuring(Effect.promise(() => rm(storeRoot, { recursive: true, force: true }))),
        );
      }),
  );
});
