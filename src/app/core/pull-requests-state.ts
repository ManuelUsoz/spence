import { DestroyRef, Injectable, InjectionToken, inject, signal, type Type } from '@angular/core';
import { Effect, Stream } from 'effect';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  CheckRollupStatus,
  CheckRunId,
  ProjectPullRequestsState,
  PullRequestNumber,
  PullRequestSummary,
  ReviewThreadId,
  WorktreePullRequestLink,
} from '../../shared/pull-requests/pull-requests.rpc';
import type { ComposerPullRequestAttachment, SessionId } from '../../shared/sessions/sessions.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

const normalizePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Maps a PR check rollup status to its theme-token indicator dot class. */
export const checkRollupDotClass = (status: CheckRollupStatus): string => {
  switch (status) {
    case 'passing':
      return 'bg-diff-add';
    case 'failing':
      return 'bg-destructive';
    case 'pending':
      return 'bg-attention';
    case 'none':
      return 'bg-muted-foreground/40';
  }
};

/** Injection token for the dedicated Pull requests page component, avoiding shell -> feature imports. */
export const PULL_REQUESTS_PAGE_VIEW = new InjectionToken<Type<unknown> | null>(
  'PULL_REQUESTS_PAGE_VIEW',
  { providedIn: 'root', factory: () => null },
);

export type PendingSessionPrAction =
  | {
      readonly _tag: 'referenceInSession';
      readonly attachment: ComposerPullRequestAttachment;
      readonly seq: number;
    }
  | {
      readonly _tag: 'startSessionFromPr';
      readonly projectId: ProjectId;
      readonly pr: PullRequestSummary;
      readonly targetRemoteName: string;
      readonly seq: number;
    };

export interface PendingPrWorktreeStart {
  readonly pr: PullRequestSummary;
  readonly targetRemoteName: string;
}

/** Shared renderer state for Project Pull requests, Worktree PR links, and PR page navigation. */
@Injectable({ providedIn: 'root' })
export class PullRequestsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private actionSeq = 0;

  private readonly statesByProject = signal<ReadonlyMap<ProjectId, ProjectPullRequestsState>>(
    new Map(),
  );
  readonly activeProjectId = signal<ProjectId | null>(null);
  readonly prPageOpen = signal(false);
  readonly selectedPrNumber = signal<PullRequestNumber | null>(null);
  readonly selectedThreadId = signal<ReviewThreadId | null>(null);
  readonly selectedCheckId = signal<CheckRunId | null>(null);
  readonly createRequested = signal<{ readonly worktreePath: string | null } | null>(null);
  readonly openSettingsRequested = signal(0);
  readonly pendingSessionAction = signal<PendingSessionPrAction | null>(null);
  readonly pendingAttachmentsBySession = signal<
    ReadonlyMap<SessionId, ReadonlyArray<ComposerPullRequestAttachment>>
  >(new Map());
  readonly pendingDraftAttachmentsByProject = signal<
    ReadonlyMap<ProjectId, ReadonlyArray<ComposerPullRequestAttachment>>
  >(new Map());
  readonly pendingDraftWorktreeByProject = signal<ReadonlyMap<ProjectId, PendingPrWorktreeStart>>(
    new Map(),
  );
  readonly focusComposerRequested = signal(0);

  constructor() {
    const controller = new AbortController();
    void this.runtime.run(
      Stream.unwrap(DesktopApi.use((api) => Effect.succeed(api['PullRequests.changes']()))).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            this.statesByProject.update((prev) => {
              const next = new Map(prev);
              next.set(state.projectId, state);
              return next;
            });
          }),
        ),
        Effect.ignore,
      ),
      { signal: controller.signal },
    );
    this.destroyRef.onDestroy(() => controller.abort());
  }

  stateForProject(projectId: ProjectId | null): ProjectPullRequestsState | null {
    if (projectId === null) return null;
    return this.statesByProject().get(projectId) ?? null;
  }

  openCountForProject(projectId: ProjectId | null): number {
    const state = this.stateForProject(projectId);
    if (state?._tag !== 'Available') return 0;
    return state.summaries.filter((s) => s.state === 'open' || s.state === 'draft').length;
  }

  linkForWorktree(
    projectId: ProjectId | null,
    worktreePath: string | null,
  ): WorktreePullRequestLink | null {
    const state = this.stateForProject(projectId);
    if (state?._tag !== 'Available' || worktreePath === null) return null;
    const direct = state.worktreeLinks[worktreePath];
    if (direct !== undefined) return direct;
    const target = normalizePath(worktreePath);
    for (const [key, value] of Object.entries(state.worktreeLinks)) {
      if (normalizePath(key) === target) return value;
    }
    return null;
  }

  loadProject(projectId: ProjectId): void {
    void this.runtime.run(
      DesktopApi.use((api) => api['PullRequests.getProjectState']({ projectId })).pipe(
        Effect.tap((state) =>
          Effect.sync(() => {
            this.statesByProject.update((prev) => {
              const next = new Map(prev);
              next.set(projectId, state);
              return next;
            });
          }),
        ),
        Effect.ignore,
      ),
    );
  }

  refreshProject(projectId: ProjectId): void {
    void this.runtime.run(
      DesktopApi.use((api) => api['PullRequests.refreshProject']({ projectId })).pipe(
        Effect.tap((state) =>
          Effect.sync(() => {
            this.statesByProject.update((prev) => {
              const next = new Map(prev);
              next.set(projectId, state);
              return next;
            });
          }),
        ),
        Effect.ignore,
      ),
    );
  }

  linkForBranch(
    branch: string,
    projectId: ProjectId | null = this.activeProjectId(),
  ): WorktreePullRequestLink | null {
    if (branch.length === 0) return null;
    const state = this.stateForProject(projectId);
    if (state?._tag !== 'Available') return null;
    for (const link of Object.values(state.worktreeLinks)) {
      if (link.primary.headRef === branch) return link;
    }
    return null;
  }

  setActiveView(view: {
    readonly projectId: ProjectId | null;
    readonly prPageOpen: boolean;
    readonly activePrNumber: PullRequestNumber | null;
  }): void {
    this.activeProjectId.set(view.projectId);
    void this.runtime.run(
      DesktopApi.use((api) => api['PullRequests.setActiveView'](view)).pipe(Effect.ignore),
    );
  }

  openPrPage(
    projectId: ProjectId | null,
    prNumber: PullRequestNumber | null = null,
    target?: { readonly threadId?: ReviewThreadId; readonly checkId?: CheckRunId },
  ): void {
    this.createRequested.set(null);
    this.selectedPrNumber.set(prNumber);
    this.selectedThreadId.set(target?.threadId ?? null);
    this.selectedCheckId.set(target?.checkId ?? null);
    this.prPageOpen.set(true);
    if (projectId !== null) {
      this.loadProject(projectId);
      this.setActiveView({ projectId, prPageOpen: true, activePrNumber: prNumber });
    }
  }

  openCreatePr(projectId: ProjectId | null, worktreePath: string | null = null): void {
    this.selectedPrNumber.set(null);
    this.createRequested.set({ worktreePath });
    this.prPageOpen.set(true);
    if (projectId !== null) {
      this.loadProject(projectId);
      this.setActiveView({ projectId, prPageOpen: true, activePrNumber: null });
    }
  }

  clearCreateRequest(): void {
    this.createRequested.set(null);
  }

  closePrPage(projectId: ProjectId | null): void {
    this.prPageOpen.set(false);
    this.selectedPrNumber.set(null);
    this.selectedThreadId.set(null);
    this.selectedCheckId.set(null);
    this.setActiveView({ projectId, prPageOpen: false, activePrNumber: null });
  }

  requestOpenSettings(): void {
    this.openSettingsRequested.update((n) => n + 1);
  }

  referenceInSession(attachment: ComposerPullRequestAttachment): void {
    this.closePrPage(attachment.projectId);
    this.pendingSessionAction.set({
      _tag: 'referenceInSession',
      attachment,
      seq: ++this.actionSeq,
    });
  }

  startSessionFromPr(projectId: ProjectId, pr: PullRequestSummary, targetRemoteName: string): void {
    this.closePrPage(projectId);
    this.pendingSessionAction.set({
      _tag: 'startSessionFromPr',
      projectId,
      pr,
      targetRemoteName,
      seq: ++this.actionSeq,
    });
  }

  consumeSessionAction(): PendingSessionPrAction | null {
    const action = this.pendingSessionAction();
    if (action !== null) this.pendingSessionAction.set(null);
    return action;
  }

  queueAttachmentForSession(sessionId: SessionId, attachment: ComposerPullRequestAttachment): void {
    this.pendingAttachmentsBySession.update((prev) => {
      const next = new Map(prev);
      next.set(sessionId, [...(prev.get(sessionId) ?? []), attachment]);
      return next;
    });
    this.focusComposerRequested.update((n) => n + 1);
  }

  consumeAttachmentsForSession(sessionId: SessionId): ReadonlyArray<ComposerPullRequestAttachment> {
    const list = this.pendingAttachmentsBySession().get(sessionId);
    if (list === undefined || list.length === 0) return [];
    this.pendingAttachmentsBySession.update((prev) => {
      const next = new Map(prev);
      next.delete(sessionId);
      return next;
    });
    return list;
  }

  queueDraftAttachmentForProject(
    projectId: ProjectId,
    attachment: ComposerPullRequestAttachment,
  ): void {
    this.pendingDraftAttachmentsByProject.update((prev) => {
      const next = new Map(prev);
      next.set(projectId, [...(prev.get(projectId) ?? []), attachment]);
      return next;
    });
    this.focusComposerRequested.update((n) => n + 1);
  }

  consumeDraftAttachmentsForProject(
    projectId: ProjectId,
  ): ReadonlyArray<ComposerPullRequestAttachment> {
    const list = this.pendingDraftAttachmentsByProject().get(projectId);
    if (list === undefined || list.length === 0) return [];
    this.pendingDraftAttachmentsByProject.update((prev) => {
      const next = new Map(prev);
      next.delete(projectId);
      return next;
    });
    return list;
  }

  setPendingDraftWorktreeForProject(projectId: ProjectId, start: PendingPrWorktreeStart): void {
    this.pendingDraftWorktreeByProject.update((prev) => {
      const next = new Map(prev);
      next.set(projectId, start);
      return next;
    });
  }

  consumePendingDraftWorktreeForProject(projectId: ProjectId): PendingPrWorktreeStart | null {
    const item = this.pendingDraftWorktreeByProject().get(projectId) ?? null;
    if (item !== null) {
      this.pendingDraftWorktreeByProject.update((prev) => {
        const next = new Map(prev);
        next.delete(projectId);
        return next;
      });
    }
    return item;
  }
}
