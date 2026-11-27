import { it } from '@effect/vitest';
import { Duration, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect } from 'vitest';
import { ProjectId, type Project } from '../../src/shared/projects/projects.rpc';
import {
  GitHostError,
  PullRequestNumber,
  type HostAccount,
  type HostAccountsState,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { Projects } from '../projects/projects';
import { layerWindowFocus, WindowFocus } from '../sessions/window-focus';
import { layerStore } from '../store/store';
import { layerGitHostRegistry, type GitHost } from './git-host';
import { GITHUB_CAPABILITIES } from './github-adapter';
import { HostAuth, type HostAuthShape } from './host-auth';
import { layerPrStore, PrStore, type StoredProjectSummaries } from './pr-store';
import {
  layerPullRequestsService,
  ProjectGitInspector,
  PullRequestsService,
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
    create: ({ title, head, base, draft }) =>
      Effect.succeed(
        makeSummary(101, {
          title,
          headRef: head,
          baseRef: base,
          state: draft ? 'draft' : 'open',
        }),
      ),
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
        worktrees: [
          {
            key: '/tmp/spence',
            branch: 'feat/x',
            headSha: 'sha-1',
            isDetached: false,
          },
        ],
      }),
  });

  const base = Layer.mergeAll(
    layerStore(options.storeRoot),
    layerWindowFocus,
    Layer.succeed(HostAuth, fakeAuth),
    layerGitHostRegistry([fakeHost]),
    fakeProjects,
    fakeInspector,
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

  it.effect('prepareCreate detects blockers and create pushes once then skips push on retry', () =>
    Effect.gen(function* () {
      const execFileAsync = promisify(execFile);
      const runGitCmd = (cwd: string, ...args: string[]) =>
        execFileAsync('git', args, { cwd, windowsHide: true }).then((r) => r.stdout.trimEnd());

      const root = yield* Effect.promise(() =>
        mkdtemp(path.join(tmpdir(), 'spence-pr-svc-create-')),
      );
      const storeRoot = path.join(root, 'store');
      const bare = path.join(root, 'origin.git');
      const work = path.join(root, 'work');
      yield* Effect.promise(async () => {
        await runGitCmd(root, 'init', '--bare', bare);
        await runGitCmd(root, 'clone', bare, work);
        await runGitCmd(work, 'config', 'user.email', 'test@spence.local');
        await runGitCmd(work, 'config', 'user.name', 'Spence Test');
        await runGitCmd(work, 'checkout', '-b', 'main');
        await writeFile(path.join(work, 'README.md'), 'init\n');
        await runGitCmd(work, 'add', 'README.md');
        await runGitCmd(work, 'commit', '-m', 'init');
        await runGitCmd(work, 'push', '-u', 'origin', 'main');
        await runGitCmd(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
        await runGitCmd(work, 'remote', 'set-head', 'origin', 'main');
      });

      let createAttempts = 0;
      const fakeHost: GitHost = {
        kind: 'github',
        capabilities: GITHUB_CAPABILITIES,
        parseRemoteUrl: () => repo,
        listForRepo: () => Effect.succeed({ notModified: false, summaries: [] }),
        getSummaryByNumber: ({ number }) => Effect.succeed(makeSummary(Number(number))),
        getDetail: ({ number }) =>
          Effect.succeed({ notModified: false, detail: makeDetail(Number(number)) }),
        getDiff: ({ number, headSha, baseSha }) =>
          Effect.succeed({ ref: { repo, number }, headSha, baseSha, files: [] }),
        create: ({ title, head, base, draft }) =>
          Effect.suspend(() => {
            createAttempts += 1;
            if (createAttempts === 1) {
              return Effect.fail(
                new GitHostError({ reason: 'HostError', detail: 'Transient API failure' }),
              );
            }
            return Effect.succeed(
              makeSummary(202, {
                title,
                headRef: head,
                baseRef: base,
                state: draft ? 'draft' : 'open',
              }),
            );
          }),
        clearEtags: () => Effect.void,
      };

      const repoProject: Project = { ...sampleProject, path: work };
      const layer = layerPullRequestsService.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Projects, {
              list: Effect.succeed([repoProject]),
              check: () => Effect.succeed(repoProject),
              add: Effect.die('unused'),
              addFolder: () => Effect.die('unused'),
              rename: () => Effect.die('unused'),
              remove: () => Effect.void,
              locate: () => Effect.die('unused'),
              locateFolder: () => Effect.die('unused'),
              setSettings: () => Effect.die('unused'),
              touch: () => Effect.void,
            }),
            Layer.succeed(ProjectGitInspector, {
              inspectProject: () =>
                Effect.succeed({
                  _tag: 'Available',
                  remotesOutput: 'origin\thttps://github.com/org/repo.git (fetch)\n',
                  worktrees: [{ key: work, branch: 'feat/p1', headSha: 'abc', isDetached: false }],
                }),
            }),
            layerGitHostRegistry([fakeHost]),
            Layer.succeed(HostAuth, {
              getAccounts: Effect.succeed({
                accounts: [connectedAccount],
                secretStorageAvailable: true,
              }),
              startDeviceFlow: () => Effect.die('unused'),
              pollDeviceFlow: () => Effect.die('unused'),
              cancelDeviceFlow: () => Effect.void,
              connectPat: () => Effect.die('unused'),
              checkGhCli: () => Effect.die('unused'),
              importGhCli: () => Effect.die('unused'),
              verify: () => Effect.die('unused'),
              disconnect: () => Effect.void,
              markNeedsReconnect: () => Effect.void,
              withToken: (_host, fn) => fn('tok'),
            }),
            layerPrStore.pipe(Layer.provide(layerStore(storeRoot))),
            layerWindowFocus,
          ),
        ),
      );

      return yield* Effect.gen(function* () {
        const svc = yield* PullRequestsService;

        // Zero commits ahead on main -> blocker
        const prepZero = yield* svc.prepareCreate({ projectId });
        expect(prepZero.blockers.some((b) => b.reason === 'ZeroCommitsAhead')).toBe(true);

        // Create feature branch with 1 unpushed commit
        yield* Effect.promise(async () => {
          await runGitCmd(work, 'checkout', '-b', 'feat/p1');
          await writeFile(path.join(work, 'f.ts'), 'export const x = 1;\n');
          await runGitCmd(work, 'add', 'f.ts');
          await runGitCmd(work, 'commit', '-m', 'feat: p1');
        });

        const prepReady = yield* svc.prepareCreate({ projectId });
        expect(prepReady.blockers).toEqual([]);
        expect(prepReady.needsPush).toBe(true);
        expect(prepReady.headRef).toBe('feat/p1');

        // First create attempt: pushes to origin, then GitHost.create fails
        const firstExit = yield* Effect.exit(
          svc.create({
            projectId,
            title: 'Feat P1',
            body: 'Body',
            baseRef: 'main',
            headRef: 'feat/p1',
            draft: false,
            pushFirst: true,
          }),
        );
        expect(firstExit._tag).toBe('Failure');

        // Verify push actually landed in bare origin
        const remoteRef = yield* Effect.promise(() =>
          runGitCmd(bare, 'rev-parse', '--verify', 'refs/heads/feat/p1'),
        );
        expect(remoteRef.length).toBeGreaterThan(10);

        // Delete remote branch in bare repo to prove retry skips git push for same headSha
        yield* Effect.promise(() => runGitCmd(bare, 'branch', '-D', 'feat/p1'));

        const created = yield* svc.create({
          projectId,
          title: 'Feat P1',
          body: 'Body',
          baseRef: 'main',
          headRef: 'feat/p1',
          draft: false,
          pushFirst: true,
        });
        expect(created.ref.number).toBe(202);
        // Bare branch should still be absent because push was skipped on retry
        const stillMissing = yield* Effect.promise(() =>
          runGitCmd(bare, 'rev-parse', '--verify', 'refs/heads/feat/p1').catch(() => 'missing'),
        );
        expect(stillMissing).toBe('missing');
      }).pipe(
        Effect.provide(layer),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true }))),
      );
    }),
  );
});
