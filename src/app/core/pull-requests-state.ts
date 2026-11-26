import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Effect, Stream } from 'effect';
import type { ProjectId } from '../../shared/projects/projects.rpc';
import type {
  ProjectPullRequestsState,
  PullRequestNumber,
  WorktreePullRequestLink,
} from '../../shared/pull-requests/pull-requests.rpc';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';

const normalizePath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** Shared renderer state for Project Pull requests, Worktree PR links, and PR page navigation. */
@Injectable({ providedIn: 'root' })
export class PullRequestsState {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);

  private readonly statesByProject = signal<ReadonlyMap<ProjectId, ProjectPullRequestsState>>(
    new Map(),
  );
  readonly activeProjectId = signal<ProjectId | null>(null);
  readonly prPageOpen = signal(false);
  readonly selectedPrNumber = signal<PullRequestNumber | null>(null);

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

  openPrPage(projectId: ProjectId | null, prNumber: PullRequestNumber | null = null): void {
    this.selectedPrNumber.set(prNumber);
    this.prPageOpen.set(true);
    if (projectId !== null) {
      this.loadProject(projectId);
      this.setActiveView({ projectId, prPageOpen: true, activePrNumber: prNumber });
    }
  }

  closePrPage(projectId: ProjectId | null): void {
    this.prPageOpen.set(false);
    this.selectedPrNumber.set(null);
    this.setActiveView({ projectId, prPageOpen: false, activePrNumber: null });
  }
}
