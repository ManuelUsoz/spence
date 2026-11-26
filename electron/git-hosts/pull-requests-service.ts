import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Project, ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  GitHostError,
  type GitHostKind,
  type ProjectPullRequestsState,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestNumber,
  type PullRequestSummary,
  type SyncStatus,
  type WorktreePullRequestLink,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { Projects } from '../projects/projects';
import { WindowFocus } from '../sessions/window-focus';
import {
  GitHostRegistry,
  matchWorktreeToPullRequest,
  resolveProjectRemote,
  type ResolvedProjectRemote,
} from './git-host';
import { HostAuth } from './host-auth';
import { PrStore } from './pr-store';

const execFileAsync = promisify(execFile);

const PR_PAGE_POLL_INTERVAL = Duration.seconds(60);
const SESSION_VIEW_POLL_INTERVAL = Duration.minutes(3);
const PENDING_DETAIL_POLL_INTERVAL = Duration.seconds(20);
const FOCUS_COOLDOWN_MS = 30_000;
const TURN_END_DEBOUNCE = Duration.millis(1_500);

export interface InspectedWorktree {
  readonly key: string;
  readonly branch: string | null;
  readonly headSha: string | null;
  readonly isDetached: boolean;
}

export type ProjectGitInspection =
  | {
      readonly _tag: 'Unavailable';
      readonly reason: 'NonGit' | 'MissingGit' | 'FolderMissing';
      readonly detail: string;
    }
  | {
      readonly _tag: 'Available';
      readonly remotesOutput: string;
      readonly worktrees: ReadonlyArray<InspectedWorktree>;
    };

export interface ProjectGitInspectorShape {
  readonly inspectProject: (project: Project) => Effect.Effect<ProjectGitInspection>;
}

/** Inspects a Project's local Git remotes and worktrees. Swapped in tests. */
export class ProjectGitInspector extends Context.Service<
  ProjectGitInspector,
  ProjectGitInspectorShape
>()('git-hosts/ProjectGitInspector') {}

const runGit = (cwd: string, args: ReadonlyArray<string>): Promise<string> =>
  execFileAsync('git', [...args], { cwd, timeout: 10_000, windowsHide: true }).then((r) =>
    r.stdout.trimEnd(),
  );

const parseWorktreePorcelain = (output: string): ReadonlyArray<InspectedWorktree> => {
  const worktrees: InspectedWorktree[] = [];
  const blocks = output.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  for (const block of blocks) {
    let wtPath = '';
    let headSha: string | null = null;
    let branch: string | null = null;
    let isDetached = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        headSha = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch refs/heads/')) {
        branch = line.slice('branch refs/heads/'.length).trim();
      } else if (line === 'detached') {
        isDetached = true;
      }
    }
    if (wtPath.length > 0) {
      worktrees.push({ key: wtPath, branch, headSha, isDetached });
    }
  }
  return worktrees;
};

export const layerProjectGitInspectorLive = Layer.succeed(ProjectGitInspector, {
  inspectProject: Effect.fnUntraced(function* (project: Project) {
    if (project.folderMissing || !existsSync(project.path)) {
      return {
        _tag: 'Unavailable' as const,
        reason: 'FolderMissing' as const,
        detail: `Folder '${project.path}' is missing.`,
      };
    }
    const gitAvailable = yield* Effect.tryPromise(() => runGit(project.path, ['--version'])).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!gitAvailable) {
      return {
        _tag: 'Unavailable' as const,
        reason: 'MissingGit' as const,
        detail: 'Git CLI is not available on PATH.',
      };
    }
    const isRepo = yield* Effect.tryPromise(() =>
      runGit(project.path, ['rev-parse', '--is-inside-work-tree']),
    ).pipe(
      Effect.map((out) => out.trim() === 'true'),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!isRepo) {
      return {
        _tag: 'Unavailable' as const,
        reason: 'NonGit' as const,
        detail: `'${project.path}' is not a Git repository.`,
      };
    }
    const remotesOutput = yield* Effect.tryPromise(() =>
      runGit(project.path, ['remote', '-v']),
    ).pipe(Effect.catch(() => Effect.succeed('')));
    const wtOutput = yield* Effect.tryPromise(() =>
      runGit(project.path, ['worktree', 'list', '--porcelain']),
    ).pipe(Effect.catch(() => Effect.succeed('')));
    return {
      _tag: 'Available' as const,
      remotesOutput,
      worktrees: parseWorktreePorcelain(wtOutput),
    };
  }),
});

export interface ActivePrView {
  readonly projectId: ProjectId | null;
  readonly prPageOpen: boolean;
  readonly activePrNumber: PullRequestNumber | null;
}

export interface PullRequestsServiceShape {
  readonly changes: Stream.Stream<ProjectPullRequestsState>;
  readonly setActiveView: (view: ActivePrView) => Effect.Effect<void>;
  readonly getProjectState: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectPullRequestsState, GitHostError>;
  readonly refreshProject: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectPullRequestsState, GitHostError>;
  readonly lookupByNumber: (
    projectId: ProjectId,
    number: PullRequestNumber,
  ) => Effect.Effect<PullRequestSummary, GitHostError>;
  readonly unpinNumber: (projectId: ProjectId, number: PullRequestNumber) => Effect.Effect<void>;
  readonly getDetail: (
    projectId: ProjectId,
    number: PullRequestNumber,
    bypassEtag?: boolean,
  ) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly getDiff: (
    projectId: ProjectId,
    number: PullRequestNumber,
  ) => Effect.Effect<PullRequestDiff, GitHostError>;
  readonly notifyTurnEnded: (projectId: ProjectId) => Effect.Effect<void>;
  readonly evictProject: (projectId: ProjectId) => Effect.Effect<void>;
  readonly evictAll: () => Effect.Effect<void>;
}

/** Coordinates PR discovery, ETag-gated focused polling, caching, and eviction. */
export class PullRequestsService extends Context.Service<
  PullRequestsService,
  PullRequestsServiceShape
>()('git-hosts/PullRequestsService') {}

const computeWorktreeLinks = (
  worktrees: ReadonlyArray<InspectedWorktree>,
  resolved: ResolvedProjectRemote,
  summaries: ReadonlyArray<PullRequestSummary>,
): Readonly<Record<string, WorktreePullRequestLink>> => {
  const links: Record<string, WorktreePullRequestLink> = {};
  for (const wt of worktrees) {
    const link = matchWorktreeToPullRequest({
      worktreeBranch: wt.branch,
      worktreeHeadSha: wt.headSha,
      isDetached: wt.isDetached,
      headRepo: resolved.headRepo,
      isFork: resolved.isFork,
      summaries,
    });
    if (link !== null) {
      links[wt.key] = link;
    }
  }
  return links;
};

const mergePinnedSummaries = (
  base: ReadonlyArray<PullRequestSummary>,
  pins: ReadonlyMap<PullRequestNumber, PullRequestSummary>,
): ReadonlyArray<PullRequestSummary> => {
  if (pins.size === 0) return base;
  const seen = new Set(base.map((s) => s.ref.number));
  const extra: PullRequestSummary[] = [];
  for (const [num, summary] of pins.entries()) {
    if (!seen.has(num)) {
      extra.push({ ...summary, isPinned: true });
    }
  }
  return [...base, ...extra];
};

export const layerPullRequestsService = Layer.effect(
  PullRequestsService,
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const projects = yield* Projects;
    const inspector = yield* ProjectGitInspector;
    const registry = yield* GitHostRegistry;
    const auth = yield* HostAuth;
    const prStore = yield* PrStore;
    const focus = yield* WindowFocus;

    const pubsub = yield* PubSub.unbounded<ProjectPullRequestsState>();
    const syncLock = yield* Semaphore.make(1);
    const pollLock = yield* Semaphore.make(1);

    const states = new Map<ProjectId, ProjectPullRequestsState>();
    const pinsByProject = new Map<ProjectId, Map<PullRequestNumber, PullRequestSummary>>();
    const lastSyncedAtByProject = new Map<ProjectId, number>();
    const rateLimitResetByHost = new Map<GitHostKind, number>();
    const resolvedByProject = new Map<ProjectId, ResolvedProjectRemote>();

    let activeView: ActivePrView = {
      projectId: null,
      prPageOpen: false,
      activePrNumber: null,
    };
    let summaryPollFiber: Fiber.Fiber<void, never> | null = null;
    let detailPollFiber: Fiber.Fiber<void, never> | null = null;
    let turnDebounceFiber: Fiber.Fiber<void, never> | null = null;

    const publishState = Effect.fnUntraced(function* (state: ProjectPullRequestsState) {
      states.set(state.projectId, state);
      yield* PubSub.publish(pubsub, state);
      return state;
    });

    const getAccountStatus = (host: GitHostKind) =>
      auth.getAccounts.pipe(
        Effect.map((s): 'disconnected' | 'connected' | 'needs-reconnect' => {
          const found = s.accounts.find((a) => a.host === host);
          if (!found) return 'disconnected';
          return found.status === 'needs-reconnect' ? 'needs-reconnect' : 'connected';
        }),
      );

    const resolveRemoteForProject = Effect.fnUntraced(function* (projectId: ProjectId) {
      const project = yield* projects
        .check(projectId)
        .pipe(
          Effect.mapError((err) => new GitHostError({ reason: 'NotFound', detail: err.detail })),
        );
      const inspection = yield* inspector.inspectProject(project);
      if (inspection._tag === 'Unavailable') {
        const unavailable: ProjectPullRequestsState = {
          _tag: 'Unavailable',
          projectId,
          reason: inspection.reason,
          detail: inspection.detail,
        };
        return { _tag: 'Unavailable' as const, state: unavailable };
      }
      const resolved = resolveProjectRemote(
        inspection.remotesOutput,
        project.settings.targetRemote,
      );
      if (resolved === null) {
        const unavailable: ProjectPullRequestsState = {
          _tag: 'Unavailable',
          projectId,
          reason: 'NoSupportedRemote',
          detail: 'No supported Git host remote was found in this repository.',
        };
        return { _tag: 'Unavailable' as const, state: unavailable };
      }
      resolvedByProject.set(projectId, resolved);
      return {
        _tag: 'Available' as const,
        resolved,
        worktrees: inspection.worktrees,
      };
    });

    const syncProject = (
      projectId: ProjectId,
      options: { readonly bypassEtag: boolean },
    ): Effect.Effect<ProjectPullRequestsState, GitHostError> =>
      syncLock.withPermits(1)(
        Effect.gen(function* () {
          const resolvedResult = yield* resolveRemoteForProject(projectId);
          if (resolvedResult._tag === 'Unavailable') {
            return yield* publishState(resolvedResult.state);
          }

          const { resolved, worktrees } = resolvedResult;
          const host = yield* registry.get(resolved.repo.host);
          const accountStatus = yield* getAccountStatus(resolved.repo.host);
          const cached = states.get(projectId);
          const diskCached =
            cached?._tag === 'Available' ? null : yield* prStore.loadSummaries(projectId);
          const existingSummaries =
            cached?._tag === 'Available' ? cached.summaries : (diskCached?.summaries ?? []);
          const existingLastSynced =
            lastSyncedAtByProject.get(projectId) ??
            (cached?._tag === 'Available'
              ? cached.lastSyncedAt
              : (diskCached?.lastSyncedAt ?? null));

          const pins =
            pinsByProject.get(projectId) ?? new Map<PullRequestNumber, PullRequestSummary>();

          if (accountStatus !== 'connected') {
            const syncStatus: SyncStatus =
              accountStatus === 'needs-reconnect'
                ? {
                    status: 'needs-reconnect',
                    detail: 'Reconnect your Git host account in Settings.',
                  }
                : { status: 'idle' };
            const state: ProjectPullRequestsState = {
              _tag: 'Available',
              projectId,
              repo: resolved.repo,
              targetRemoteName: resolved.targetRemoteName,
              headRemoteName: resolved.headRemoteName,
              capabilities: host.capabilities,
              accountStatus,
              syncStatus,
              lastSyncedAt: existingLastSynced,
              summaries: mergePinnedSummaries(existingSummaries, pins),
              worktreeLinks: computeWorktreeLinks(worktrees, resolved, existingSummaries),
            };
            return yield* publishState(state);
          }

          const nowMs = yield* Clock.currentTimeMillis;
          const rateResetAt = rateLimitResetByHost.get(resolved.repo.host);
          if (rateResetAt !== undefined && nowMs < rateResetAt) {
            const state: ProjectPullRequestsState = {
              _tag: 'Available',
              projectId,
              repo: resolved.repo,
              targetRemoteName: resolved.targetRemoteName,
              headRemoteName: resolved.headRemoteName,
              capabilities: host.capabilities,
              accountStatus,
              syncStatus: {
                status: 'rate-limited',
                resetAt: rateResetAt,
                detail: 'GitHub API rate limit reached.',
              },
              lastSyncedAt: existingLastSynced,
              summaries: mergePinnedSummaries(existingSummaries, pins),
              worktreeLinks: computeWorktreeLinks(worktrees, resolved, existingSummaries),
            };
            return yield* publishState(state);
          }
          if (rateResetAt !== undefined && nowMs >= rateResetAt) {
            rateLimitResetByHost.delete(resolved.repo.host);
          }

          const listResult = yield* host
            .listForRepo({ repo: resolved.repo, bypassEtag: options.bypassEtag })
            .pipe(
              Effect.map((res) => ({ ok: true as const, res })),
              Effect.catch((err) => Effect.succeed({ ok: false as const, err })),
            );

          if (!listResult.ok) {
            const err = listResult.err;
            let syncStatus: SyncStatus = { status: 'offline', detail: err.detail };
            let nextAccountStatus: 'disconnected' | 'connected' | 'needs-reconnect' = accountStatus;

            if (err.reason === 'RateLimited') {
              const resetAt = err.resetAt ?? nowMs + (err.retryAfterSeconds ?? 60) * 1_000;
              rateLimitResetByHost.set(resolved.repo.host, resetAt);
              syncStatus = { status: 'rate-limited', resetAt, detail: err.detail };
            } else if (err.reason === 'TokenExpired') {
              yield* auth.markNeedsReconnect(resolved.repo.host, err.detail);
              nextAccountStatus = 'needs-reconnect';
              syncStatus = { status: 'needs-reconnect', detail: err.detail };
            }

            const state: ProjectPullRequestsState = {
              _tag: 'Available',
              projectId,
              repo: resolved.repo,
              targetRemoteName: resolved.targetRemoteName,
              headRemoteName: resolved.headRemoteName,
              capabilities: host.capabilities,
              accountStatus: nextAccountStatus,
              syncStatus,
              lastSyncedAt: existingLastSynced,
              summaries: mergePinnedSummaries(existingSummaries, pins),
              worktreeLinks: computeWorktreeLinks(worktrees, resolved, existingSummaries),
            };
            return yield* publishState(state);
          }

          const nextSummaries = listResult.res.notModified
            ? existingSummaries
            : listResult.res.summaries;
          const mergedSummaries = mergePinnedSummaries(nextSummaries, pins);
          const worktreeLinks = computeWorktreeLinks(worktrees, resolved, mergedSummaries);
          lastSyncedAtByProject.set(projectId, nowMs);

          yield* prStore.saveSummaries(projectId, {
            repo: resolved.repo,
            targetRemoteName: resolved.targetRemoteName,
            headRemoteName: resolved.headRemoteName,
            capabilities: host.capabilities,
            lastSyncedAt: nowMs,
            summaries: mergedSummaries,
            worktreeLinks,
          });

          const state: ProjectPullRequestsState = {
            _tag: 'Available',
            projectId,
            repo: resolved.repo,
            targetRemoteName: resolved.targetRemoteName,
            headRemoteName: resolved.headRemoteName,
            capabilities: host.capabilities,
            accountStatus: 'connected',
            syncStatus: { status: 'idle' },
            lastSyncedAt: nowMs,
            summaries: mergedSummaries,
            worktreeLinks,
          };
          return yield* publishState(state);
        }),
      );

    const stopPollingFibers = Effect.gen(function* () {
      if (summaryPollFiber !== null) {
        yield* Fiber.interrupt(summaryPollFiber);
        summaryPollFiber = null;
      }
      if (detailPollFiber !== null) {
        yield* Fiber.interrupt(detailPollFiber);
        detailPollFiber = null;
      }
    });

    const isActiveDetailPending = (): boolean => {
      if (
        !activeView.prPageOpen ||
        activeView.projectId === null ||
        activeView.activePrNumber === null
      ) {
        return false;
      }
      const st = states.get(activeView.projectId);
      if (st?._tag !== 'Available') return false;
      const summary = st.summaries.find((s) => s.ref.number === activeView.activePrNumber);
      return summary?.checkRollup === 'pending';
    };

    const startPollingFibers = pollLock.withPermits(1)(
      Effect.gen(function* () {
        yield* stopPollingFibers;
        const focused = yield* focus.isFocused;
        const pid = activeView.projectId;
        if (!focused || pid === null) return;

        const summaryInterval = activeView.prPageOpen
          ? PR_PAGE_POLL_INTERVAL
          : SESSION_VIEW_POLL_INTERVAL;

        summaryPollFiber = yield* Effect.forever(
          Effect.sleep(summaryInterval).pipe(
            Effect.andThen(syncProject(pid, { bypassEtag: false }).pipe(Effect.ignore)),
          ),
        ).pipe(Effect.forkIn(scope));

        if (isActiveDetailPending() && activeView.activePrNumber !== null) {
          const prNum = activeView.activePrNumber;
          detailPollFiber = yield* Effect.forever(
            Effect.sleep(PENDING_DETAIL_POLL_INTERVAL).pipe(
              Effect.andThen(getDetailInternal(pid, prNum, false, true).pipe(Effect.ignore)),
            ),
          ).pipe(Effect.forkIn(scope));
        }
      }),
    );

    const getDetailInternal = Effect.fnUntraced(function* (
      projectId: ProjectId,
      number: PullRequestNumber,
      bypassEtag: boolean,
      checkPending: boolean,
    ) {
      let resolved = resolvedByProject.get(projectId);
      if (resolved === undefined) {
        const r = yield* resolveRemoteForProject(projectId);
        if (r._tag === 'Unavailable') {
          return yield* new GitHostError({ reason: 'NotFound', detail: r.state.detail });
        }
        resolved = r.resolved;
      }
      const host = yield* registry.get(resolved.repo.host);
      const cached = yield* prStore.getDetail(projectId, number);

      if (!bypassEtag && cached !== null && !checkPending) {
        return cached;
      }

      const res = yield* host
        .getDetail({
          repo: resolved.repo,
          number,
          bypassEtag,
          checkPending,
        })
        .pipe(
          Effect.catch((err) => {
            if (
              cached !== null &&
              (err.reason === 'NetworkUnavailable' ||
                err.reason === 'RateLimited' ||
                err.reason === 'TokenExpired')
            ) {
              return Effect.succeed({ notModified: true } as const);
            }
            return Effect.fail(err);
          }),
        );

      if (res.notModified) {
        if (cached !== null) return cached;
        const forced = yield* host.getDetail({
          repo: resolved.repo,
          number,
          bypassEtag: true,
          checkPending,
        });
        if (!forced.notModified) {
          yield* prStore.saveDetail(projectId, forced.detail);
          return forced.detail;
        }
        return yield* new GitHostError({
          reason: 'NotFound',
          detail: `Pull request #${number} detail is not available.`,
        });
      }

      yield* prStore.saveDetail(projectId, res.detail);
      return res.detail;
    });

    // React to WindowFocus changes (pause on blur, 30s cooldown on focus)
    yield* focus.changes.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (focused: boolean) {
          if (!focused) {
            yield* stopPollingFibers;
            return;
          }
          const pid = activeView.projectId;
          if (pid !== null) {
            const nowMs = yield* Clock.currentTimeMillis;
            const last = lastSyncedAtByProject.get(pid);
            if (last === undefined || nowMs - last >= FOCUS_COOLDOWN_MS) {
              yield* syncProject(pid, { bypassEtag: false }).pipe(
                Effect.ignore,
                Effect.forkIn(scope),
              );
            }
          }
          yield* startPollingFibers;
        }),
      ),
      Effect.forkIn(scope),
    );

    const setActiveView: PullRequestsServiceShape['setActiveView'] = Effect.fnUntraced(
      function* (view) {
        const projectChanged = activeView.projectId !== view.projectId;
        activeView = view;
        const focused = yield* focus.isFocused;
        if (focused && view.projectId !== null && (projectChanged || !states.has(view.projectId))) {
          yield* syncProject(view.projectId, { bypassEtag: false }).pipe(Effect.ignore);
        }
        yield* startPollingFibers;
      },
    );

    const getProjectState: PullRequestsServiceShape['getProjectState'] = Effect.fnUntraced(
      function* (projectId) {
        const existing = states.get(projectId);
        if (existing !== undefined) return existing;
        const disk = yield* prStore.loadSummaries(projectId);
        if (disk !== null) {
          const host = yield* registry.get(disk.repo.host);
          const accountStatus = yield* getAccountStatus(disk.repo.host);
          const state: ProjectPullRequestsState = {
            _tag: 'Available',
            projectId,
            repo: disk.repo,
            targetRemoteName: disk.targetRemoteName,
            headRemoteName: disk.headRemoteName,
            capabilities: host.capabilities,
            accountStatus,
            syncStatus: { status: 'idle' },
            lastSyncedAt: disk.lastSyncedAt,
            summaries: disk.summaries,
            worktreeLinks: disk.worktreeLinks,
          };
          states.set(projectId, state);
          return state;
        }
        return yield* syncProject(projectId, { bypassEtag: false });
      },
    );

    const refreshProject: PullRequestsServiceShape['refreshProject'] = (projectId) =>
      syncProject(projectId, { bypassEtag: true });

    const lookupByNumber: PullRequestsServiceShape['lookupByNumber'] = Effect.fnUntraced(
      function* (projectId, number) {
        let resolved = resolvedByProject.get(projectId);
        if (resolved === undefined) {
          const r = yield* resolveRemoteForProject(projectId);
          if (r._tag === 'Unavailable') {
            return yield* new GitHostError({ reason: 'NotFound', detail: r.state.detail });
          }
          resolved = r.resolved;
        }
        const host = yield* registry.get(resolved.repo.host);
        const summary = yield* host.getSummaryByNumber({ repo: resolved.repo, number });
        const pinned: PullRequestSummary = { ...summary, isPinned: true };
        const pins =
          pinsByProject.get(projectId) ?? new Map<PullRequestNumber, PullRequestSummary>();
        pins.set(number, pinned);
        pinsByProject.set(projectId, pins);

        const current = states.get(projectId);
        if (current?._tag === 'Available') {
          const nextSummaries = mergePinnedSummaries(
            current.summaries.filter((s) => s.ref.number !== number),
            pins,
          );
          yield* publishState({ ...current, summaries: nextSummaries });
        }
        return pinned;
      },
    );

    const unpinNumber: PullRequestsServiceShape['unpinNumber'] = Effect.fnUntraced(
      function* (projectId, number) {
        const pins = pinsByProject.get(projectId);
        if (pins === undefined) return;
        pins.delete(number);
        const current = states.get(projectId);
        if (current?._tag === 'Available') {
          const nextSummaries = current.summaries.filter(
            (s) => !(s.ref.number === number && s.isPinned === true),
          );
          yield* publishState({ ...current, summaries: nextSummaries });
        }
      },
    );

    const getDetail: PullRequestsServiceShape['getDetail'] = (
      projectId,
      number,
      bypassEtag = false,
    ) => getDetailInternal(projectId, number, bypassEtag, isActiveDetailPending());

    const getDiff: PullRequestsServiceShape['getDiff'] = Effect.fnUntraced(
      function* (projectId, number) {
        let resolved = resolvedByProject.get(projectId);
        if (resolved === undefined) {
          const r = yield* resolveRemoteForProject(projectId);
          if (r._tag === 'Unavailable') {
            return yield* new GitHostError({ reason: 'NotFound', detail: r.state.detail });
          }
          resolved = r.resolved;
        }
        const detail = yield* getDetailInternal(projectId, number, false, false);
        const cachedDiff = yield* prStore.getDiff(projectId, number, detail.headSha);
        if (cachedDiff !== null) return cachedDiff;

        const host = yield* registry.get(resolved.repo.host);
        const diff = yield* host.getDiff({
          repo: resolved.repo,
          number,
          headSha: detail.headSha,
          baseSha: detail.baseRef,
        });
        yield* prStore.putDiff(projectId, diff);
        return diff;
      },
    );

    const notifyTurnEnded: PullRequestsServiceShape['notifyTurnEnded'] = Effect.fnUntraced(
      function* (projectId) {
        if (turnDebounceFiber !== null) {
          yield* Fiber.interrupt(turnDebounceFiber);
          turnDebounceFiber = null;
        }
        turnDebounceFiber = yield* Effect.sleep(TURN_END_DEBOUNCE).pipe(
          Effect.andThen(syncProject(projectId, { bypassEtag: false }).pipe(Effect.ignore)),
          Effect.forkIn(scope),
        );
      },
    );

    const evictProject: PullRequestsServiceShape['evictProject'] = Effect.fnUntraced(
      function* (projectId) {
        const resolved = resolvedByProject.get(projectId);
        states.delete(projectId);
        pinsByProject.delete(projectId);
        lastSyncedAtByProject.delete(projectId);
        resolvedByProject.delete(projectId);
        if (resolved !== undefined) {
          const host = yield* registry
            .get(resolved.repo.host)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (host !== null) yield* host.clearEtags(resolved.repo);
        }
        yield* prStore.evictProject(projectId);
      },
    );

    const evictAll: PullRequestsServiceShape['evictAll'] = Effect.fnUntraced(function* () {
      states.clear();
      pinsByProject.clear();
      lastSyncedAtByProject.clear();
      resolvedByProject.clear();
      rateLimitResetByHost.clear();
      const host = yield* registry.get('github').pipe(Effect.catch(() => Effect.succeed(null)));
      if (host !== null) yield* host.clearEtags();
      yield* prStore.evictAll();
    });

    return {
      changes: Stream.fromPubSub(pubsub),
      setActiveView,
      getProjectState,
      refreshProject,
      lookupByNumber,
      unpinNumber,
      getDetail,
      getDiff,
      notifyTurnEnded,
      evictProject,
      evictAll,
    };
  }),
);
