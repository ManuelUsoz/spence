import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  signal,
  untracked,
} from '@angular/core';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmSidebarImports } from '@ui/sidebar';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId, SessionSummary } from '../../../shared/sessions/sessions.rpc';
import type { ProjectOrder } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs, titleOf } from '../../core/tabs';
import { AllProjectsList, type AllProjectsSection } from './all-projects-list';
import { ProjectsState } from './projects-state';
import {
  ALL_PROJECTS_CAP,
  archivedCount,
  capSessions,
  groupByDay,
  listed,
  sessionTitle,
  shortAge,
  type SessionGroup,
} from './session-groups';
import { SessionList, type SessionRow } from './session-list';
import { SettingsState } from './settings-state';

const listSessions = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.list']({ projectId });
});

const listProjectEntry = Effect.fnUntraced(function* (projectId: ProjectId) {
  const exit = yield* Effect.exit(listSessions(projectId));
  return [projectId, exit] as const;
});

const listAllSessions = (projectIds: ReadonlyArray<ProjectId>) =>
  Effect.all(projectIds.map(listProjectEntry), { concurrency: 'unbounded' });

const updateProjectOrder = Effect.fnUntraced(function* (projectOrder: ProjectOrder) {
  const api = yield* DesktopApi;
  return yield* api['Settings.update']({ patch: { projectOrder } });
});

/** A row with the time it is grouped by. */
type DatedRow = SessionRow & { readonly at: number };

type RawSessionsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly raw: ReadonlyArray<SessionSummary> };

type SessionsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly sessions: ReadonlyArray<SessionSummary> };

const hasAttention = (session: SessionSummary & { readonly attention?: unknown }): boolean =>
  session.attention !== undefined;

interface SectionContext {
  readonly load: RawSessionsLoad;
  readonly draftId: string | null;
  readonly activeTabId: string | null;
  readonly activeSessionId: SessionId | null;
  readonly expanded: boolean;
  readonly filter: string;
  readonly locale: string;
  readonly now: number;
}

const buildAllProjectsSection = (
  project: Project,
  ctx: SectionContext,
): AllProjectsSection | null => {
  const projectMatches =
    ctx.filter === '' || project.name.toLocaleLowerCase(ctx.locale).includes(ctx.filter);
  const draftActive = ctx.draftId !== null && ctx.draftId === ctx.activeTabId;

  if (ctx.load.status !== 'loaded') {
    if (ctx.filter !== '' && !projectMatches) return null;
    return {
      project,
      status: ctx.load.status,
      draft: ctx.draftId !== null,
      draftActive,
      rows: [],
      hiddenCount: 0,
      expanded: false,
      archivedCount: 0,
    };
  }

  const activeSessions = listed(ctx.load.raw);
  const draftVisible =
    ctx.draftId !== null &&
    (ctx.filter === '' ||
      projectMatches ||
      $localize`New Session`.toLocaleLowerCase(ctx.locale).includes(ctx.filter));

  let visibleSessions: ReadonlyArray<SessionSummary>;
  let hiddenCount = 0;
  if (ctx.filter !== '') {
    visibleSessions = projectMatches
      ? activeSessions
      : activeSessions.filter((session) =>
          sessionTitle(session.title).toLocaleLowerCase(ctx.locale).includes(ctx.filter),
        );
    if (!projectMatches && visibleSessions.length === 0 && !draftVisible) return null;
  } else {
    const capped = capSessions(activeSessions, {
      cap: ALL_PROJECTS_CAP,
      expanded: ctx.expanded,
      isPinned: (session) => session.id === ctx.activeSessionId || hasAttention(session),
    });
    visibleSessions = capped.visible;
    hiddenCount = capped.hiddenCount;
  }

  return {
    project,
    status: 'loaded',
    draft: draftVisible,
    draftActive: draftVisible && draftActive,
    rows: visibleSessions.map((session) => ({
      id: session.id,
      title: sessionTitle(session.title),
      age: shortAge(session.lastActivityAt, ctx.now, ctx.locale),
      active: session.id === ctx.activeSessionId,
    })),
    hiddenCount,
    expanded: ctx.expanded,
    archivedCount: archivedCount(ctx.load.raw),
  };
};

/**
 * The sidebar: One Project layout (switcher, New Session, search, day groups) or All Projects layout (filter,
 * sort control, all Projects as headings with capped recent Sessions), plus the Settings gear at the foot.
 */
@Component({
  selector: 'app-sidebar',
  imports: [HlmSidebarImports, HlmDropdownMenuImports, SessionList, AllProjectsList],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-sidebar
      collapsible="offcanvas"
      srOnlySheetTitle="Sidebar"
      i18n-srOnlySheetTitle
      srOnlySheetDescription="Displays the mobile sidebar."
      i18n-srOnlySheetDescription
    >
      <div hlmSidebarHeader>
        @switch (projects.state().status) {
          @case ('loading') {
            <p class="text-muted-foreground px-2 py-1 text-sm" i18n>Loading…</p>
          }
          @case ('failed') {
            <p class="text-destructive px-2 py-1 text-sm" data-testid="projects-failed" i18n>
              Could not load Projects.
            </p>
          }
        }
        @if (settings.sidebarLayout() === 'allProjects' && projects.ordered().length > 0) {
          <div class="flex items-center gap-1">
            <input
              hlmSidebarInput
              data-testid="all-projects-filter"
              class="min-w-0 flex-1"
              placeholder="Filter Projects and Sessions"
              i18n-placeholder
              aria-label="Filter Projects and Sessions"
              i18n-aria-label
              [value]="filterQuery()"
              (input)="filterQuery.set($any($event.target).value)"
              (keydown.escape)="clearFilter()"
            />
            <button
              type="button"
              data-testid="project-order-trigger"
              class="hover:bg-sidebar-accent text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md border"
              [hlmDropdownMenuTrigger]="sortMenu"
              aria-label="Sort Projects"
              i18n-aria-label
              title="Sort Projects"
              i18n-title
            >
              <svg
                class="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16" />
              </svg>
            </button>
          </div>
        } @else if (current(); as project) {
          <button
            type="button"
            data-testid="current-project"
            class="hover:bg-sidebar-accent flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left"
            [hlmDropdownMenuTrigger]="switcher"
          >
            <span
              class="bg-sidebar-primary text-sidebar-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase"
              aria-hidden="true"
              >{{ project.name.slice(0, 1) }}</span
            >
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-sm font-semibold">{{ project.name }}</span>
              @if (project.folderMissing) {
                <span class="text-destructive truncate text-xs" i18n>Folder missing</span>
              } @else {
                <span
                  class="text-muted-foreground truncate font-mono text-[11px]"
                  data-testid="project-path"
                  >{{ project.path }}</span
                >
              }
            </span>
            <!-- Slot: the dot when another Project has Attention (Attention issue). -->
            <svg
              class="text-muted-foreground size-3.5 shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>

          <div class="mt-2 flex gap-1">
            <button
              type="button"
              data-testid="new-session"
              class="hover:bg-sidebar-accent flex h-8 flex-1 items-center gap-2 rounded-md border px-2 text-left text-sm"
              (click)="newSession(project.id)"
            >
              <svg
                class="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span i18n>New Session</span>
            </button>
            <button
              type="button"
              data-testid="search-sessions"
              class="hover:bg-sidebar-accent text-muted-foreground flex size-8 items-center justify-center rounded-md border"
              [class.bg-sidebar-accent]="searching()"
              [attr.aria-pressed]="searching()"
              aria-label="Search this Project"
              i18n-aria-label
              title="Search this Project"
              i18n-title
              (click)="toggleSearch()"
            >
              <svg
                class="size-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" />
              </svg>
            </button>
          </div>
          @if (searching()) {
            <input
              hlmSidebarInput
              data-testid="session-search"
              class="mt-2"
              placeholder="Search titles"
              i18n-placeholder
              aria-label="Search this Project"
              i18n-aria-label
              [value]="query()"
              (input)="query.set($any($event.target).value)"
              (keydown.escape)="toggleSearch()"
            />
          }
        } @else if (projects.state().status === 'loaded') {
          <p class="text-muted-foreground px-2 py-1 text-sm" data-testid="no-projects" i18n>
            No Projects yet.
          </p>
          <button
            type="button"
            data-testid="add-project"
            class="hover:bg-sidebar-accent flex h-8 items-center gap-2 rounded-md border px-2 text-left text-sm"
            (click)="addProject()"
          >
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span i18n>Add Project</span>
          </button>
        }
      </div>

      <div hlmSidebarContent class="px-2">
        @if (settings.sidebarLayout() === 'allProjects' && projects.ordered().length > 0) {
          <app-all-projects-list
            [sections]="allProjectSections()"
            [emptyMessage]="allProjectsEmptyMessage()"
            (newSession)="newSession($event)"
            (openSession)="openProjectSession($event)"
            (openDraft)="newSession($event)"
            (toggleExpand)="toggleExpand($event)"
          />
        } @else if (current(); as project) {
          @switch (sessions().status) {
            @case ('loading') {
              <p class="text-muted-foreground px-2 py-1 text-sm" i18n>Loading…</p>
            }
            @case ('failed') {
              <p class="text-destructive px-2 py-1 text-sm" data-testid="sessions-failed" i18n>
                Could not load Sessions.
              </p>
            }
            @case ('loaded') {
              <app-session-list
                [groups]="groups()"
                [draft]="draft() !== null"
                [draftActive]="draft() !== null && draft()?.id === tabs.activeId()"
                (open)="openSession($event)"
                (openDraft)="newSession(project.id)"
                (rename)="renameSession($event.id, $event.title)"
              />
              @if (groups().length === 0 && draft() === null) {
                @if (query().trim() === '') {
                  <p
                    class="font-display text-muted-foreground px-2 py-6 text-center text-xl"
                    data-testid="sessions-empty"
                    i18n
                  >
                    No Sessions in {{ project.name }} yet.
                  </p>
                } @else {
                  <p
                    class="text-muted-foreground px-2 py-6 text-center text-sm"
                    data-testid="sessions-empty"
                    i18n
                  >
                    No Sessions match.
                  </p>
                }
              }
            }
          }
        }
      </div>

      <div hlmSidebarFooter class="flex-row items-center justify-between">
        <button
          type="button"
          data-testid="open-settings"
          class="hover:bg-sidebar-accent text-muted-foreground inline-flex size-8 items-center justify-center rounded-md"
          aria-label="Settings"
          i18n-aria-label
          title="Settings"
          i18n-title
          (click)="settings.show()"
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        @if (settings.sidebarLayout() === 'allProjects' && projects.ordered().length > 0) {
          <button
            type="button"
            data-testid="add-project"
            class="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs"
            (click)="addProject()"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span i18n>Add Project</span>
          </button>
        }
      </div>
    </hlm-sidebar>

    <ng-template #switcher>
      <hlm-dropdown-menu class="w-64" data-testid="project-menu">
        @for (project of projects.ordered(); track project.id) {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-option"
            (triggered)="pick(project.id)"
          >
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <!-- Slots: Attention dot and running mark (Tabs/Attention issue). -->
            @if (project.folderMissing) {
              <svg
                class="text-destructive size-3.5 shrink-0"
                data-testid="folder-missing"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                role="img"
                aria-label="Folder missing"
                i18n-aria-label
              >
                <path
                  d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2zM9.5 10.5l5 5M14.5 10.5l-5 5"
                />
              </svg>
            }
            <svg
              class="size-3.5 shrink-0"
              [style.visibility]="project.id === current()?.id ? 'visible' : 'hidden'"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
        }
        <hlm-dropdown-menu-separator />
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="add-project"
          (triggered)="addProject()"
        >
          <svg
            class="size-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span i18n>Add Project</span>
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #sortMenu>
      <hlm-dropdown-menu class="w-48" data-testid="project-order-menu">
        <hlm-dropdown-menu-label i18n>Project order</hlm-dropdown-menu-label>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="sort-by-lastUsed"
          (triggered)="
            setProjectOrder({ by: 'lastUsed', direction: projects.projectOrder().direction })
          "
        >
          <span class="flex-1" i18n>Last used</span>
          <svg
            class="size-3.5 shrink-0"
            [style.visibility]="projects.projectOrder().by === 'lastUsed' ? 'visible' : 'hidden'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="sort-by-name"
          (triggered)="
            setProjectOrder({ by: 'name', direction: projects.projectOrder().direction })
          "
        >
          <span class="flex-1" i18n>Name</span>
          <svg
            class="size-3.5 shrink-0"
            [style.visibility]="projects.projectOrder().by === 'name' ? 'visible' : 'hidden'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <hlm-dropdown-menu-separator />
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="sort-direction-desc"
          (triggered)="setProjectOrder({ by: projects.projectOrder().by, direction: 'desc' })"
        >
          <span class="flex-1" i18n>Descending</span>
          <svg
            class="size-3.5 shrink-0"
            [style.visibility]="projects.projectOrder().direction === 'desc' ? 'visible' : 'hidden'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="sort-direction-asc"
          (triggered)="setProjectOrder({ by: projects.projectOrder().by, direction: 'asc' })"
        >
          <span class="flex-1" i18n>Ascending</span>
          <svg
            class="size-3.5 shrink-0"
            [style.visibility]="projects.projectOrder().direction === 'asc' ? 'visible' : 'hidden'"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class AppSidebar {
  private readonly runtime = inject(EffectRuntime);
  private readonly locale = inject(LOCALE_ID);
  protected readonly tabs = inject(Tabs);
  protected readonly settings = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);

  /** The Project last picked in the switcher; reset to the active Tab's Project whenever the active Tab changes. */
  private readonly picked = linkedSignal<ReturnType<Tabs['active']>, ProjectId | null>({
    source: this.tabs.active,
    computation: (tab, previous) => tab?.projectId ?? previous?.value ?? null,
  });

  protected readonly current = computed((): Project | null => {
    const picked = this.projects.ordered().find((project) => project.id === this.picked());
    return picked ?? this.projects.lastUsed();
  });

  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly filterQuery = signal('');
  private readonly expandedProjects = signal<ReadonlySet<ProjectId>>(new Set());
  private previousTabSessions = new Map<string, SessionId | null>();

  private readonly loadIds = computed(
    (): ReadonlyArray<ProjectId> => {
      if (this.settings.sidebarLayout() === 'allProjects') {
        return this.projects
          .ordered()
          .map((project) => project.id)
          .sort();
      }
      const current = this.current();
      return current === null ? [] : [current.id];
    },
    {
      equal: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
    },
  );

  private readonly sessionRevision = computed(() =>
    JSON.stringify(
      this.tabs
        .tabs()
        .filter((tab) => tab.session !== null)
        .map((tab) => [tab.session, tab.title]),
    ),
  );
  private readonly loaded = resource({
    params: () => {
      const ids = this.loadIds();
      return ids.length === 0 ? undefined : ids;
    },
    loader: ({ params }) => this.runtime.run(listAllSessions(params)),
  });

  /** Silent per-Project refreshes (e.g. when a draft Tab becomes a kept Session), reset on full load. */
  private readonly refreshedSessions = linkedSignal<
    ReturnType<typeof this.loaded.value>,
    ReadonlyMap<ProjectId, RawSessionsLoad>
  >({
    source: () => (this.loaded.hasValue() ? this.loaded.value() : undefined),
    computation: () => new Map(),
  });

  private readonly rawByProject = computed((): ReadonlyMap<ProjectId, RawSessionsLoad> => {
    const map = new Map<ProjectId, RawSessionsLoad>();
    const ids = this.loadIds();
    const refreshed = this.refreshedSessions();
    if (this.loaded.isLoading() || !this.loaded.hasValue()) {
      for (const id of ids) {
        map.set(id, refreshed.get(id) ?? { status: 'loading' });
      }
      return map;
    }
    const exit = this.loaded.value();
    if (exit === undefined) {
      for (const id of ids) map.set(id, refreshed.get(id) ?? { status: 'loading' });
      return map;
    }
    if (exit._tag === 'Failure') {
      for (const id of ids) map.set(id, refreshed.get(id) ?? { status: 'failed' });
      return map;
    }
    for (const [projectId, projectExit] of exit.value) {
      map.set(
        projectId,
        refreshed.get(projectId) ??
          (projectExit._tag === 'Success'
            ? { status: 'loaded', raw: projectExit.value }
            : { status: 'failed' }),
      );
    }
    return map;
  });

  protected readonly sessions = computed((): SessionsLoad => {
    const project = this.current();
    if (project === null) return { status: 'loading' };
    const load = this.rawByProject().get(project.id);
    if (load === undefined || load.status === 'loading') return { status: 'loading' };
    if (load.status === 'failed') return { status: 'failed' };
    return { status: 'loaded', sessions: listed(load.raw) };
  });

  constructor() {
    let seen = false;
    effect(() => {
      this.sessionRevision();
      if (!seen) {
        seen = true;
        return;
      }
      const ids = untracked(() => this.loadIds());
      if (ids.length > 0) untracked(() => void this.refreshProjects(ids));
    });
    effect(() => {
      const tabs = this.tabs.tabs();
      const keptProjectIds: ProjectId[] = [];
      for (const tab of tabs) {
        const previous = this.previousTabSessions.get(tab.id);
        if (previous === null && tab.session !== null) {
          keptProjectIds.push(tab.projectId);
        }
      }
      this.previousTabSessions = new Map(tabs.map((tab) => [tab.id, tab.session]));
      if (keptProjectIds.length > 0) {
        untracked(() => void this.refreshProjects(keptProjectIds));
      }
    });
  }

  protected readonly draft = computed(() => {
    const project = this.current();
    return project === null ? null : this.tabs.draftOf(project.id);
  });

  protected readonly groups = computed((): ReadonlyArray<SessionGroup<SessionRow>> => {
    const state = this.sessions();
    const project = this.current();
    if (state.status !== 'loaded' || project === null) return [];
    const query = this.query().trim().toLocaleLowerCase(this.locale);
    const now = Date.now();
    const active = this.tabs.active()?.session ?? null;
    const rows = state.sessions.flatMap((session): DatedRow[] => {
      const tab = this.tabs.tabs().find((candidate) => candidate.session === session.id);
      const title =
        tab !== undefined ? (tab.title ?? $localize`New Session`) : sessionTitle(session.title);
      if (query !== '' && !title.toLocaleLowerCase(this.locale).includes(query)) return [];
      const age = $localize`active ${shortAge(session.lastActivityAt, now, this.locale)}:age:`;
      const meta = this.tabs.isOpen(session.id) ? `${age} · ${$localize`open in a Tab`}` : age;
      return [
        {
          id: session.id,
          title,
          meta,
          active: session.id === active,
          at: session.lastActivityAt,
          untitled: tab !== undefined ? tab.title === null : titleOf(session.title) === null,
        },
      ];
    });
    return groupByDay(rows, (row) => row.at, now, this.locale);
  });

  protected readonly allProjectSections = computed((): ReadonlyArray<AllProjectsSection> => {
    const rawMap = this.rawByProject();
    const expanded = this.expandedProjects();
    const activeSessionId = this.tabs.active()?.session ?? null;
    const activeTabId = this.tabs.activeId();
    const filter = this.filterQuery().trim().toLocaleLowerCase(this.locale);
    const now = Date.now();

    return this.projects.ordered().flatMap((project) => {
      const section = buildAllProjectsSection(project, {
        load: rawMap.get(project.id) ?? { status: 'loading' },
        draftId: this.tabs.draftOf(project.id)?.id ?? null,
        activeTabId,
        activeSessionId,
        expanded: expanded.has(project.id),
        filter,
        locale: this.locale,
        now,
      });
      return section === null ? [] : [section];
    });
  });

  protected readonly allProjectsEmptyMessage = computed((): string | null =>
    this.filterQuery().trim() !== '' && this.allProjectSections().length === 0
      ? $localize`No Sessions match.`
      : null,
  );

  protected newSession(projectId: ProjectId): void {
    this.tabs.startDraft(projectId);
  }

  protected openSession(id: SessionId): void {
    const project = this.current();
    const state = this.sessions();
    if (project === null || state.status !== 'loaded') return;
    const session = state.sessions.find((candidate) => candidate.id === id);
    if (session === undefined) return;
    this.tabs.open({ id, projectId: project.id, title: titleOf(session.title) });
  }

  protected async renameSession(id: SessionId, title: string): Promise<void> {
    const exit = await this.runtime.run(
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return yield* api['Session.rename']({ sessionId: id, title });
      }),
    );
    if (exit._tag === 'Success') {
      const ids = this.loadIds();
      if (ids.length > 0) void this.refreshProjects(ids);
    }
  }

  protected openProjectSession(target: {
    readonly projectId: ProjectId;
    readonly sessionId: SessionId;
  }): void {
    const load = this.rawByProject().get(target.projectId);
    if (load === undefined || load.status !== 'loaded') return;
    const session = load.raw.find((candidate) => candidate.id === target.sessionId);
    if (session === undefined) return;
    this.tabs.open({
      id: target.sessionId,
      projectId: target.projectId,
      title: titleOf(session.title),
    });
  }

  protected toggleExpand(projectId: ProjectId): void {
    this.expandedProjects.update((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  private async refreshProjects(projectIds: ReadonlyArray<ProjectId>): Promise<void> {
    const exit = await this.runtime.run(listAllSessions(projectIds));
    if (exit._tag !== 'Success') return;
    this.refreshedSessions.update((current) => {
      const next = new Map(current);
      for (const [projectId, projectExit] of exit.value) {
        if (projectExit._tag === 'Success') {
          next.set(projectId, { status: 'loaded', raw: projectExit.value });
        }
      }
      return next;
    });
  }

  protected pick(id: ProjectId): void {
    this.picked.set(id);
    this.query.set('');
  }

  protected toggleSearch(): void {
    this.searching.update((searching) => !searching);
    if (!this.searching()) this.query.set('');
  }

  protected clearFilter(): void {
    this.filterQuery.set('');
  }

  protected async addProject(): Promise<void> {
    const project = await this.projects.add();
    if (project !== null) this.pick(project.id);
  }

  protected async setProjectOrder(order: ProjectOrder): Promise<void> {
    const exit = await this.runtime.run(updateProjectOrder(order));
    if (exit._tag === 'Failure') {
      toast.error($localize`Could not change the setting.`);
      return;
    }
    this.projects.orderChanged(exit.value.projectOrder);
  }
}
