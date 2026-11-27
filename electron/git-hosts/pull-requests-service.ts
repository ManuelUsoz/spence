import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PubSub,
  Scope,
  Semaphore,
  Stream,
} from 'effect';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import type { Project, ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  GitHostError,
  type CreatePrBlocker,
  type CreatePrPreparation,
  type DraftPullRequestResult,
  type AddCommentTarget,
  type CommentId,
  type GitHostKind,
  type ProjectPullRequestsState,
  type PullRequestCommentKind,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestNumber,
  type PullRequestRevision,
  type PullRequestSummary,
  type PullRequestUpdatePatch,
  type ReviewId,
  type ReviewSubmitEvent,
  type ReviewThreadId,
  type SyncStatus,
  type WorktreePullRequestLink,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { TurnId } from '../../src/shared/sessions/sessions.rpc';
import { DEFAULT_PULL_REQUEST_SETTINGS } from '../../src/shared/settings/settings.rpc';
import { AcpClient } from '../acp/acpSessionManager';
import { runIsolatedToolFreePrompt } from '../acp/tool-free-prompt';
import { catalog } from '../agents/catalog';
import { Projects } from '../projects/projects';
import { WindowFocus } from '../sessions/window-focus';
import { Settings } from '../settings/settings';
import { pushBranch } from '../source-control/git-actions';
import { BranchOrigins } from '../worktrees/branch-origins';
import {
  GitHostRegistry,
  matchWorktreeToPullRequest,
  resolveProjectRemote,
  type GitHost,
  type ResolvedProjectRemote,
} from './git-host';
import { HostAuth } from './host-auth';
import {
  buildDraftCreatePrompt,
  gatherDraftCreateInput,
  inspectCreateContext,
  parseDraftAgentReply,
} from './pr-create-git';
import { detectPrTemplate } from './pr-template';
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
  readonly prepareCreate: (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string;
    readonly baseRef?: string;
  }) => Effect.Effect<CreatePrPreparation, GitHostError>;
  readonly draftCreate: (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string;
    readonly baseRef: string;
  }) => Effect.Effect<DraftPullRequestResult, GitHostError>;
  readonly create: (input: {
    readonly projectId: ProjectId;
    readonly worktreePath?: string;
    readonly title: string;
    readonly body: string;
    readonly baseRef: string;
    readonly headRef: string;
    readonly draft: boolean;
    readonly pushFirst: boolean;
  }) => Effect.Effect<PullRequestSummary, GitHostError>;
  readonly update: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly revision: PullRequestRevision;
    readonly patch: PullRequestUpdatePatch;
    readonly baseline?: PullRequestUpdatePatch;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly addComment: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly body: string;
    readonly target: AddCommentTarget;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly editComment: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
    readonly body: string;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly deleteComment: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly submitReview: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly reviewId?: ReviewId;
    readonly event: ReviewSubmitEvent;
    readonly body: string;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly deletePendingReview: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly reviewId: ReviewId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly resolveThread: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly threadId: ReviewThreadId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly unresolveThread: (input: {
    readonly projectId: ProjectId;
    readonly number: PullRequestNumber;
    readonly threadId: ReviewThreadId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly notifyTurnEnded: (projectId: ProjectId) => Effect.Effect<void>;
  readonly evictProject: (projectId: ProjectId) => Effect.Effect<void>;
  readonly evictAll: () => Effect.Effect<void>;
}

const sortedEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
};

const detectConflictingFields = (
  patch: PullRequestUpdatePatch,
  fresh: PullRequestDetail,
  snapshot: PullRequestDetail | null,
  explicitBaseline?: PullRequestUpdatePatch,
): ReadonlyArray<string> => {
  const conflicts: string[] = [];
  if (patch.title !== undefined) {
    const base = explicitBaseline?.title ?? snapshot?.title;
    if (base !== undefined && fresh.title !== base) conflicts.push('title');
  }
  if (patch.body !== undefined) {
    const base = explicitBaseline?.body ?? snapshot?.body;
    if (base !== undefined && fresh.body !== base) conflicts.push('body');
  }
  if (patch.baseRef !== undefined) {
    const base = explicitBaseline?.baseRef ?? snapshot?.baseRef;
    if (base !== undefined && fresh.baseRef !== base) conflicts.push('baseRef');
  }
  if (patch.draft !== undefined) {
    const base =
      explicitBaseline?.draft ?? (snapshot !== null ? snapshot.state === 'draft' : undefined);
    if (base !== undefined && (fresh.state === 'draft') !== base) conflicts.push('draft');
  }
  if (patch.reviewers !== undefined) {
    const base = explicitBaseline?.reviewers ?? snapshot?.reviewers.map((r) => r.login);
    if (
      base !== undefined &&
      !sortedEqual(
        fresh.reviewers.map((r) => r.login),
        base,
      )
    ) {
      conflicts.push('reviewers');
    }
  }
  if (patch.assignees !== undefined) {
    const base = explicitBaseline?.assignees ?? snapshot?.assignees.map((a) => a.login);
    if (
      base !== undefined &&
      !sortedEqual(
        fresh.assignees.map((a) => a.login),
        base,
      )
    ) {
      conflicts.push('assignees');
    }
  }
  if (patch.labels !== undefined) {
    const base = explicitBaseline?.labels ?? snapshot?.labels.map((l) => l.name);
    if (
      base !== undefined &&
      !sortedEqual(
        fresh.labels.map((l) => l.name),
        base,
      )
    ) {
      conflicts.push('labels');
    }
  }
  if (patch.milestoneId !== undefined) {
    const base =
      explicitBaseline?.milestoneId !== undefined
        ? explicitBaseline.milestoneId
        : snapshot !== null
          ? (snapshot.milestone?.id ?? null)
          : undefined;
    if (base !== undefined && (fresh.milestone?.id ?? null) !== base) {
      conflicts.push('milestoneId');
    }
  }
  return conflicts;
};

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
    const branchOrigins = Option.getOrUndefined(yield* Effect.serviceOption(BranchOrigins));
    const settingsService = Option.getOrUndefined(yield* Effect.serviceOption(Settings));
    const acpClient = Option.getOrUndefined(yield* Effect.serviceOption(AcpClient));

    const pubsub = yield* PubSub.unbounded<ProjectPullRequestsState>();
    const syncLock = yield* Semaphore.make(1);
    const pollLock = yield* Semaphore.make(1);

    const states = new Map<ProjectId, ProjectPullRequestsState>();
    const pinsByProject = new Map<ProjectId, Map<PullRequestNumber, PullRequestSummary>>();
    const lastSyncedAtByProject = new Map<ProjectId, number>();
    const rateLimitResetByHost = new Map<GitHostKind, number>();
    const resolvedByProject = new Map<ProjectId, ResolvedProjectRemote>();
    const pushedHeadShas = new Set<string>();

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

    const revisionSnapshots = new Map<string, PullRequestDetail>();
    const snapshotKey = (
      projectId: ProjectId,
      number: PullRequestNumber,
      rev: PullRequestRevision,
    ): string => `${projectId}#${number}@${rev.headSha}:${rev.updatedAt}`;

    const recordSnapshot = (projectId: ProjectId, detail: PullRequestDetail): void => {
      const key = snapshotKey(projectId, detail.ref.number, detail.revision);
      revisionSnapshots.delete(key);
      revisionSnapshots.set(key, detail);
      if (revisionSnapshots.size > 50) {
        const firstKey = revisionSnapshots.keys().next().value;
        if (firstKey !== undefined) revisionSnapshots.delete(firstKey);
      }
    };

    const requireResolved = Effect.fnUntraced(function* (projectId: ProjectId) {
      let resolved = resolvedByProject.get(projectId);
      if (resolved === undefined) {
        const r = yield* resolveRemoteForProject(projectId);
        if (r._tag === 'Unavailable') {
          return yield* new GitHostError({ reason: 'NotFound', detail: r.state.detail });
        }
        resolved = r.resolved;
      }
      return resolved;
    });

    const syncDetailToState = Effect.fnUntraced(function* (
      projectId: ProjectId,
      detail: PullRequestDetail,
    ) {
      yield* prStore.saveDetail(projectId, detail);
      recordSnapshot(projectId, detail);
      const current = states.get(projectId);
      if (current?._tag === 'Available') {
        const nextSummaries = current.summaries.map((s) =>
          s.ref.number === detail.ref.number
            ? {
                ...s,
                title: detail.title,
                state: detail.state,
                baseRef: detail.baseRef,
                updatedAt: detail.updatedAt,
                reviewDecision: detail.reviewDecision,
                commentCount: detail.commentCount,
                unresolvedThreadCount: detail.unresolvedThreadCount,
              }
            : s,
        );
        yield* publishState({ ...current, summaries: nextSummaries });
      }
    });

    const getDetailInternal = Effect.fnUntraced(function* (
      projectId: ProjectId,
      number: PullRequestNumber,
      bypassEtag: boolean,
      checkPending: boolean,
    ) {
      const resolved = yield* requireResolved(projectId);
      const host = yield* registry.get(resolved.repo.host);
      const cached = yield* prStore.getDetail(projectId, number);

      if (!bypassEtag && cached !== null && !checkPending) {
        recordSnapshot(projectId, cached);
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
          recordSnapshot(projectId, forced.detail);
          return forced.detail;
        }
        return yield* new GitHostError({
          reason: 'NotFound',
          detail: `Pull request #${number} detail is not available.`,
        });
      }

      yield* prStore.saveDetail(projectId, res.detail);
      recordSnapshot(projectId, res.detail);
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

    const resolveProjectAndRemote = Effect.fnUntraced(function* (projectId: ProjectId) {
      const allProjects = yield* projects.list;
      const project = allProjects.find((p) => p.id === projectId);
      if (project === undefined) {
        return yield* new GitHostError({
          reason: 'NotFound',
          detail: `Project '${projectId}' was not found.`,
        });
      }
      const r = yield* resolveRemoteForProject(projectId);
      if (r._tag === 'Unavailable') {
        return yield* new GitHostError({ reason: 'NotFound', detail: r.state.detail });
      }
      return { project, resolved: r.resolved };
    });

    const prepareCreate: PullRequestsServiceShape['prepareCreate'] = Effect.fnUntraced(
      function* (input) {
        const { project, resolved } = yield* resolveProjectAndRemote(input.projectId);
        const worktreePath = input.worktreePath ?? project.path;
        const headBranchOut = yield* Effect.tryPromise(() =>
          runGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
        ).pipe(Effect.catch(() => Effect.succeed('')));
        const currentHeadBranch = headBranchOut.trim().length > 0 ? headBranchOut.trim() : null;
        const createdFromBranch =
          branchOrigins !== undefined && currentHeadBranch !== null
            ? yield* branchOrigins.get({ worktreePath, branch: currentHeadBranch })
            : null;

        const ctx = yield* Effect.tryPromise(() =>
          inspectCreateContext({
            worktreePath,
            targetRemoteName: resolved.targetRemoteName,
            headRemoteName: resolved.headRemoteName,
            ...(input.baseRef !== undefined ? { baseRefOverride: input.baseRef } : {}),
            createdFromBranch,
          }),
        ).pipe(
          Effect.mapError(
            (err) =>
              new GitHostError({
                reason: 'HostError',
                detail: err instanceof Error ? err.message : 'Failed to inspect Git branch state.',
              }),
          ),
        );

        const accountsState = yield* auth.getAccounts;
        const connected = accountsState.accounts.some(
          (a) => a.host === resolved.repo.host && a.status === 'connected',
        );
        const host = yield* registry.get(resolved.repo.host);

        const currentState = states.get(input.projectId);
        let existingOpenPr: PullRequestSummary | null = null;
        if (currentState?._tag === 'Available' && ctx.headRef !== null) {
          const link = matchWorktreeToPullRequest({
            worktreeBranch: ctx.headRef,
            worktreeHeadSha: ctx.headSha,
            isDetached: false,
            headRepo: resolved.headRepo,
            isFork: resolved.isFork,
            summaries: currentState.summaries,
          });
          if (link !== null && (link.primary.state === 'open' || link.primary.state === 'draft')) {
            existingOpenPr = link.primary;
          }
        }

        const blockers: CreatePrBlocker[] = [];
        if (!connected) {
          blockers.push({
            reason: 'NotAuthenticated',
            detail: 'Connect a GitHub account in Settings → Git hosts to create a Pull request.',
          });
        }
        if (ctx.headRef === null) {
          blockers.push({
            reason: 'DetachedHead',
            detail: 'Checkout a branch before creating a Pull request.',
          });
        } else if (ctx.aheadCount === 0) {
          blockers.push({
            reason: 'ZeroCommitsAhead',
            detail: `No commits ahead of ${ctx.baseRef}.`,
          });
        }
        if (existingOpenPr !== null) {
          blockers.push({
            reason: 'OpenPrExists',
            detail: `Pull request #${existingOpenPr.ref.number} is already open for ${ctx.headRef}.`,
          });
        }

        return {
          worktreePath,
          headRef: ctx.headRef,
          headSha: ctx.headSha,
          defaultBaseRef: ctx.defaultBaseRef,
          baseRef: ctx.baseRef,
          availableBaseRefs: [...ctx.availableBaseRefs],
          aheadCount: ctx.aheadCount,
          behindCount: ctx.behindCount,
          needsPush: ctx.needsPush,
          headRemoteName: resolved.headRemoteName,
          isFork: resolved.isFork,
          isDirty: ctx.isDirty,
          templateBody: ctx.templateBody,
          supportsDraft: host.capabilities.supportsDraft,
          blockers,
          existingOpenPr,
        };
      },
    );

    const draftCreate: PullRequestsServiceShape['draftCreate'] = Effect.fn(
      'PullRequests.draftCreate',
    )(function* (input): Effect.fn.Return<DraftPullRequestResult, GitHostError> {
      const { project, resolved } = yield* resolveProjectAndRemote(input.projectId);
      const worktreePath = input.worktreePath ?? project.path;
      const settings =
        settingsService !== undefined
          ? yield* settingsService.get
          : { pullRequests: DEFAULT_PULL_REQUEST_SETTINGS };
      const prSettings = settings.pullRequests ?? DEFAULT_PULL_REQUEST_SETTINGS;
      if (!prSettings.draftingEnabled) {
        return yield* new GitHostError({
          reason: 'ValidationFailed',
          detail: 'Pull request drafting is disabled in Settings.',
        });
      }
      if (acpClient === undefined) {
        return yield* new GitHostError({
          reason: 'UnsupportedCapability',
          detail: 'Agent runtime is unavailable for Pull request drafting.',
        });
      }

      const headBranchOut = yield* Effect.tryPromise(() =>
        runGit(worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      ).pipe(Effect.catch(() => Effect.succeed('')));
      const headRef = headBranchOut.trim();
      if (headRef.length === 0) {
        return yield* new GitHostError({
          reason: 'ValidationFailed',
          detail: 'Cannot draft a Pull request from a detached HEAD.',
        });
      }

      const entry = catalog.find((c) => c.id === prSettings.draftingAgent) ?? catalog[0];
      if (entry === undefined) {
        return yield* new GitHostError({
          reason: 'UnsupportedCapability',
          detail: 'No drafting Agent is configured.',
        });
      }

      const templateBody = yield* Effect.promise(() => detectPrTemplate(worktreePath));
      const draftInput = yield* Effect.tryPromise(() =>
        gatherDraftCreateInput({
          worktreePath,
          baseRef: input.baseRef,
          targetRemoteName: resolved.targetRemoteName,
          templateBody,
        }),
      ).pipe(
        Effect.mapError(
          (err) =>
            new GitHostError({
              reason: 'HostError',
              detail: err instanceof Error ? err.message : 'Failed to gather diff for drafting.',
            }),
        ),
      );

      const promptText = buildDraftCreatePrompt({
        headRef,
        baseRef: input.baseRef,
        context: draftInput,
      });
      const turnId = TurnId.make(`pr-draft-${randomUUID()}`);
      const result = yield* runIsolatedToolFreePrompt(
        entry,
        turnId,
        worktreePath,
        [{ _tag: 'text', text: promptText }],
        { model: prSettings.draftingModel },
      ).pipe(
        Effect.provideService(AcpClient, acpClient),
        Effect.mapError(
          (err) =>
            new GitHostError({
              reason: 'HostError',
              detail: err instanceof Error ? err.message : "Couldn't draft Pull request.",
            }),
        ),
      );

      if (
        result.unexpectedAction ||
        Exit.isFailure(result.promptExit) ||
        result.replyText.length === 0
      ) {
        return yield* new GitHostError({
          reason: 'HostError',
          detail: "Couldn't draft Pull request.",
        });
      }

      return parseDraftAgentReply(result.replyText, headRef);
    });

    const create: PullRequestsServiceShape['create'] = Effect.fn('PullRequests.create')(
      function* (input) {
        const { project, resolved } = yield* resolveProjectAndRemote(input.projectId);
        const worktreePath = input.worktreePath ?? project.path;
        const pathEnv = process.env['PATH'] ?? process.env['Path'] ?? '';

        if (input.pushFirst) {
          const headSha = yield* Effect.tryPromise(() =>
            runGit(worktreePath, ['rev-parse', '--verify', 'HEAD']),
          ).pipe(Effect.catch(() => Effect.succeed('')));
          const pushKey = `${resolved.headRemoteName}\0${input.headRef}\0${headSha}`;
          if (!pushedHeadShas.has(pushKey)) {
            const pushed = yield* Effect.tryPromise(() =>
              pushBranch(worktreePath, resolved.headRemoteName, 'git', pathEnv),
            ).pipe(
              Effect.mapError(
                (err) =>
                  new GitHostError({
                    reason: 'HostError',
                    detail: err instanceof Error ? err.message : 'Git push failed.',
                  }),
              ),
            );
            if (pushed._tag !== 'Done') {
              return yield* new GitHostError({
                reason: 'HostError',
                detail: 'detail' in pushed ? pushed.detail : 'Git push failed.',
              });
            }
            pushedHeadShas.add(pushKey);
          }
        }

        const host = yield* registry.get(resolved.repo.host);
        const headOwner = resolved.headRepo.canonicalPath.split('/')[0];
        const headParam =
          resolved.isFork && headOwner !== undefined
            ? `${headOwner}:${input.headRef}`
            : input.headRef;
        const created = yield* host.create({
          repo: resolved.repo,
          title: input.title,
          body: input.body,
          head: headParam,
          base: input.baseRef,
          draft: input.draft,
        });

        yield* syncProject(input.projectId, { bypassEtag: true }).pipe(Effect.ignore);
        return created;
      },
    );

    const update: PullRequestsServiceShape['update'] = Effect.fnUntraced(function* ({
      projectId,
      number,
      revision,
      patch,
      baseline,
    }) {
      const resolved = yield* requireResolved(projectId);
      const host = yield* registry.get(resolved.repo.host);
      const freshRes = yield* host.getDetail({
        repo: resolved.repo,
        number,
        bypassEtag: true,
        checkPending: false,
      });
      if (freshRes.notModified) {
        return yield* new GitHostError({
          reason: 'NotFound',
          detail: `Pull request #${number} detail is not available.`,
        });
      }
      const freshDetail = freshRes.detail;
      if (
        freshDetail.revision.headSha !== revision.headSha ||
        freshDetail.revision.updatedAt !== revision.updatedAt
      ) {
        const cached = yield* prStore.getDetail(projectId, number);
        const snapshot =
          revisionSnapshots.get(snapshotKey(projectId, number, revision)) ??
          (cached !== null &&
          cached.revision.headSha === revision.headSha &&
          cached.revision.updatedAt === revision.updatedAt
            ? cached
            : null);
        const conflictingFields = detectConflictingFields(patch, freshDetail, snapshot, baseline);
        if (conflictingFields.length > 0) {
          yield* syncDetailToState(projectId, freshDetail);
          return yield* new GitHostError({
            reason: 'Conflict',
            detail: `Remote Pull request changed on: ${conflictingFields.join(', ')}.`,
            conflictingFields,
            latestDetail: freshDetail,
          });
        }
      }

      const updated = yield* host.update({
        repo: resolved.repo,
        number,
        patch,
        currentDetail: freshDetail,
      });
      yield* syncDetailToState(projectId, updated);
      return updated;
    });

    const runDetailMutation = Effect.fnUntraced(function* (
      projectId: ProjectId,
      fn: (
        host: GitHost,
        repo: ResolvedProjectRemote['repo'],
      ) => Effect.Effect<PullRequestDetail, GitHostError>,
    ) {
      const resolved = yield* requireResolved(projectId);
      const host = yield* registry.get(resolved.repo.host);
      const updated = yield* fn(host, resolved.repo);
      yield* syncDetailToState(projectId, updated);
      return updated;
    });

    const addComment: PullRequestsServiceShape['addComment'] = ({
      projectId,
      number,
      body,
      target,
    }) =>
      runDetailMutation(projectId, (host, repo) => host.addComment({ repo, number, body, target }));

    const editComment: PullRequestsServiceShape['editComment'] = ({
      projectId,
      number,
      commentId,
      kind,
      body,
    }) =>
      runDetailMutation(projectId, (host, repo) =>
        host.editComment({ repo, number, commentId, kind, body }),
      );

    const deleteComment: PullRequestsServiceShape['deleteComment'] = ({
      projectId,
      number,
      commentId,
      kind,
    }) =>
      runDetailMutation(projectId, (host, repo) =>
        host.deleteComment({ repo, number, commentId, kind }),
      );

    const submitReview: PullRequestsServiceShape['submitReview'] = ({
      projectId,
      number,
      reviewId,
      event,
      body,
    }) =>
      runDetailMutation(projectId, (host, repo) =>
        host.submitReview({
          repo,
          number,
          ...(reviewId !== undefined ? { reviewId } : {}),
          event,
          body,
        }),
      );

    const deletePendingReview: PullRequestsServiceShape['deletePendingReview'] = ({
      projectId,
      number,
      reviewId,
    }) =>
      runDetailMutation(projectId, (host, repo) =>
        host.deletePendingReview({ repo, number, reviewId }),
      );

    const resolveThread: PullRequestsServiceShape['resolveThread'] = ({
      projectId,
      number,
      threadId,
    }) =>
      runDetailMutation(projectId, (host, repo) => host.resolveThread({ repo, number, threadId }));

    const unresolveThread: PullRequestsServiceShape['unresolveThread'] = ({
      projectId,
      number,
      threadId,
    }) =>
      runDetailMutation(projectId, (host, repo) =>
        host.unresolveThread({ repo, number, threadId }),
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
      prepareCreate,
      draftCreate,
      create,
      update,
      addComment,
      editComment,
      deleteComment,
      submitReview,
      deletePendingReview,
      resolveThread,
      unresolveThread,
      notifyTurnEnded,
      evictProject,
      evictAll,
    };
  }),
);
