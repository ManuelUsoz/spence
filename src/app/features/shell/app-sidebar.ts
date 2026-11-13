import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  HostListener,
  LOCALE_ID,
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmSidebarImports } from '@ui/sidebar';
import { toast } from '@ui/toast';
import { Effect, Schedule, Stream } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  Attention,
  SessionChange,
  SessionId,
  SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import type { ProjectOrder } from '../../../shared/settings/settings.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs, titleOf, type Tab } from '../../core/tabs';
import { AllProjectsList, type AllProjectsRow, type AllProjectsSection } from './all-projects-list';
import { ProjectSettingsState } from './project-settings-state';
import { ProjectsState } from './projects-state';
import {
  ALL_PROJECTS_CAP,
  archived,
  archivedCount,
  capSessions,
  groupByDay,
  listed,
  sessionTitle,
  shortAge,
  type SessionGroup,
} from './session-groups';
import { type RowClickEvent, SessionList, type SessionRow } from './session-list';
import { SessionsState, type SessionTarget } from './sessions-state';
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

const sessionChanges = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return api['Session.changes']();
});

function metaOf(session: SessionSummary, openInTab: boolean, now: number, locale: string): string {
  const parts = [$localize`active ${shortAge(session.lastActivityAt, now, locale)}:age:`];
  if (session.archivedAt === undefined) {
    if (session.attention === 'needsAnswer') parts.push($localize`waiting for your answer`);
    else if (session.attention === 'error') parts.push($localize`error`);
  }
  if (openInTab) parts.push($localize`open in a Tab`);
  return parts.join(' · ');
}
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

const displayTitle = (
  session: SessionSummary,
  tabs: ReadonlyArray<Tab>,
): { readonly title: string; readonly untitled: boolean } => {
  const tab = tabs.find((candidate) => candidate.session === session.id);
  return {
    title: tab !== undefined ? (tab.title ?? $localize`New Session`) : sessionTitle(session.title),
    untitled: tab !== undefined ? tab.title === null : titleOf(session.title) === null,
  };
};

interface SectionContext {
  readonly load: RawSessionsLoad;
  readonly draftId: string | null;
  readonly activeTabId: string | null;
  readonly activeSessionId: SessionId | null;
  readonly expanded: boolean;
  readonly archivedOpen: boolean;
  readonly selected: ReadonlySet<SessionId>;
  readonly tabs: ReadonlyArray<Tab>;
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
      archivedRows: [],
      archivedOpen: false,
      unarchivedCount: 0,
      totalCount: 0,
    };
  }

  const activeSessions = listed(ctx.load.raw);
  const archivedSessions = archived(ctx.load.raw);
  const draftVisible =
    ctx.draftId !== null &&
    (ctx.filter === '' ||
      projectMatches ||
      $localize`New Session`.toLocaleLowerCase(ctx.locale).includes(ctx.filter));

  const toRow = (session: SessionSummary, isArchived: boolean): AllProjectsRow => {
    const resolved = displayTitle(session, ctx.tabs);
    return {
      id: session.id,
      projectId: project.id,
      title: resolved.title,
      age: shortAge(session.lastActivityAt, ctx.now, ctx.locale),
      active: session.id === ctx.activeSessionId,
      untitled: resolved.untitled,
      selected: ctx.selected.has(session.id),
      archived: isArchived,
      ...(!isArchived && session.attention !== undefined ? { attention: session.attention } : {}),
      ...(!isArchived && session.running === true ? { running: true } : {}),
    };
  };

  let attention: Attention | undefined;
  let running = false;
  for (const session of activeSessions) {
    if (session.running === true) running = true;
    if (session.attention === 'needsAnswer') attention = 'needsAnswer';
    else if (session.attention === 'error' && attention === undefined) attention = 'error';
  }

  let visibleSessions: ReadonlyArray<SessionSummary>;
  let visibleArchived: ReadonlyArray<SessionSummary>;
  let hiddenCount = 0;
  if (ctx.filter !== '') {
    visibleSessions = projectMatches
      ? activeSessions
      : activeSessions.filter((session) =>
          displayTitle(session, ctx.tabs).title.toLocaleLowerCase(ctx.locale).includes(ctx.filter),
        );
    visibleArchived = projectMatches
      ? archivedSessions
      : archivedSessions.filter((session) =>
          displayTitle(session, ctx.tabs).title.toLocaleLowerCase(ctx.locale).includes(ctx.filter),
        );
    if (
      !projectMatches &&
      visibleSessions.length === 0 &&
      visibleArchived.length === 0 &&
      !draftVisible
    ) {
      return null;
    }
  } else {
    const capped = capSessions(activeSessions, {
      cap: ALL_PROJECTS_CAP,
      expanded: ctx.expanded,
      isPinned: (session) => session.id === ctx.activeSessionId || hasAttention(session),
    });
    visibleSessions = capped.visible;
    hiddenCount = capped.hiddenCount;
    visibleArchived = archivedSessions;
  }

  return {
    project,
    status: 'loaded',
    draft: draftVisible,
    draftActive: draftVisible && draftActive,
    rows: visibleSessions.map((session) => toRow(session, false)),
    hiddenCount,
    expanded: ctx.expanded,
    archivedCount: archivedCount(ctx.load.raw),
    archivedRows: visibleArchived.map((session) => toRow(session, true)),
    archivedOpen: ctx.archivedOpen,
    unarchivedCount: activeSessions.length,
    totalCount: ctx.load.raw.length,
    ...(attention === undefined ? {} : { attention }),
    ...(running ? { running: true } : {}),
  };
};

/**
 * The sidebar: One Project layout (switcher, New Session, search, day groups, Archived fold) or All Projects layout
 * (filter, sort control, all Projects as headings with capped recent Sessions and Archived folds), plus the Settings
 * gear at the foot.
 */
@Component({
  selector: 'app-sidebar',
  imports: [
    ActivityMark,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmContextMenuImports,
    HlmInputImports,
    SessionList,
    AllProjectsList,
  ],
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
          @if (renamingProject() === project.id) {
            <input
              #renameInput
              hlmInput
              data-testid="project-rename-input"
              class="h-11 w-full px-2 text-sm font-semibold"
              aria-label="Project name"
              i18n-aria-label
              [value]="renameDraft()"
              (input)="renameDraft.set($any($event.target).value)"
              (keydown.enter)="commitRename(project)"
              (keydown.escape)="cancelRename()"
              (blur)="commitRename(project)"
            />
          } @else {
            <button
              type="button"
              data-testid="current-project"
              class="hover:bg-sidebar-accent flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left"
              [hlmDropdownMenuTrigger]="switcher"
              [hlmContextMenuTrigger]="projectMenu"
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
              @if (otherProjectAttention()) {
                <span
                  data-testid="other-project-attention"
                  class="bg-[var(--attention)] size-2 shrink-0 rounded-full"
                  role="img"
                  aria-label="Another Project needs attention"
                  i18n-aria-label
                ></span>
              }
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
          }

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
            [selectedCount]="selectedIds().size"
            [selectedAllArchived]="selectedAllArchived()"
            [renamingProject]="renamingProject()"
            [renameDraft]="renameDraft()"
            (newSession)="newSession($event)"
            (rowClick)="onAllProjectsRowClick($event)"
            (rename)="renameSession($event.id, $event.title)"
            (openDraft)="newSession($event)"
            (toggleExpand)="toggleExpand($event)"
            (toggleArchived)="toggleAllProjectsArchived($event)"
            (clearSelection)="clearSelection()"
            (menuOpen)="openSession($event.id)"
            (menuArchive)="archiveFromRow($event)"
            (menuUnarchive)="unarchiveFromRow($event)"
            (menuDelete)="deleteFromRow($event)"
            (unarchiveAll)="unarchiveAllArchived($event)"
            (deleteAllArchived)="deleteAllArchived($event)"
            (locateProject)="locateProject($event)"
            (startProjectRename)="startRename($event)"
            (projectRenameDraft)="renameDraft.set($event)"
            (commitProjectRename)="commitRename($event)"
            (cancelProjectRename)="cancelRename()"
            (openProjectSettings)="projectSettings.show($event)"
            (archiveAllProject)="archiveAllProject($event)"
            (deleteAllProject)="deleteAllProject($event)"
            (removeProject)="removeProject($event)"
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
                [archived]="archivedRows()"
                [archivedOpen]="archivedOpen()"
                [selectedCount]="selectedIds().size"
                [selectedAllArchived]="selectedAllArchived()"
                [draft]="draft() !== null"
                [draftActive]="draft() !== null && draft()?.id === tabs.activeId()"
                (rowClick)="onRowClick($event)"
                (openDraft)="newSession(project.id)"
                (rename)="renameSession($event.id, $event.title)"
                (toggleArchived)="toggleArchived()"
                (clearSelection)="clearSelection()"
                (menuOpen)="openSession($event.id)"
                (menuArchive)="archiveFromRow($event)"
                (menuUnarchive)="unarchiveFromRow($event)"
                (menuDelete)="deleteFromRow($event)"
                (unarchiveAll)="unarchiveAllArchived()"
                (deleteAllArchived)="deleteAllArchived()"
              />
              @if (groups().length === 0 && archivedRows().length === 0 && draft() === null) {
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
            @let marks = projectMarks(project.id);
            @if (marks.attention; as attention) {
              <span class="shrink-0">
                <app-activity-mark [kind]="attention" />
              </span>
            }
            @if (marks.running) {
              <span class="shrink-0">
                <app-activity-mark kind="running" />
              </span>
            }
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

    <ng-template #projectMenu>
      @if (current(); as project) {
        <hlm-dropdown-menu class="w-52" data-testid="project-context-menu">
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-new-session"
            (triggered)="newSession(project.id)"
            i18n
          >
            New Session
          </button>
          @if (project.folderMissing) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="project-menu-locate"
              (triggered)="locateProject(project.id)"
              i18n
            >
              Locate folder…
            </button>
          }
          <hlm-dropdown-menu-separator />
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-rename"
            (triggered)="startRename(project)"
            i18n
          >
            Rename
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-settings"
            (triggered)="projectSettings.show(project)"
            i18n
          >
            Project settings
          </button>
          <hlm-dropdown-menu-separator />
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="project-menu-archive-all"
            [disabled]="unarchivedTargets().length === 0"
            (triggered)="archiveAllProject()"
            i18n
          >
            Archive all (<span class="tabular-nums">{{ unarchivedTargets().length }}</span
            >)
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="project-menu-delete-all"
            [disabled]="allTargets().length === 0"
            (triggered)="deleteAllProject()"
            i18n
          >
            Delete all (<span class="tabular-nums">{{ allTargets().length }}</span
            >)…
          </button>
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="project-menu-remove"
            (triggered)="removeProject(project)"
            i18n
          >
            Remove Project
          </button>
        </hlm-dropdown-menu>
      }
    </ng-template>
  `,
})
export class AppSidebar {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  protected readonly tabs = inject(Tabs);
  protected readonly settings = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);
  protected readonly projectSettings = inject(ProjectSettingsState);
  private readonly sessionsState = inject(SessionsState);

  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

  private readonly aborts = new AbortController();

  /** The Project last picked in the switcher; reset to the active Tab's Project whenever another Tab becomes active. */
  private readonly picked = linkedSignal<string | null, ProjectId | null>({
    source: () => this.tabs.active()?.id ?? null,
    computation: (activeId, previous) => {
      if (activeId === null) return previous?.value ?? null;
      return this.tabs.active()?.projectId ?? previous?.value ?? null;
    },
  });

  protected readonly current = computed((): Project | null => {
    const picked = this.projects.ordered().find((project) => project.id === this.picked());
    return picked ?? this.projects.lastUsed();
  });

  protected readonly searching = signal(false);
  protected readonly query = signal('');
  protected readonly filterQuery = signal('');
  private readonly expandedProjects = signal<ReadonlySet<ProjectId>>(new Set());
  private readonly allProjectsArchivedOpen = signal<ReadonlySet<ProjectId>>(new Set());
  private previousTabSessions = new Map<string, SessionId | null>();
  protected readonly renamingProject = signal<ProjectId | null>(null);
  protected readonly renameDraft = signal('');
  private renamingDone = false;

  protected readonly archivedOpen = linkedSignal<ProjectId | undefined, boolean>({
    source: () => this.current()?.id,
    computation: () => false,
  });

  private readonly selected = linkedSignal<
    { readonly project: ProjectId | undefined; readonly layout: string },
    ReadonlySet<SessionId>
  >({
    source: () => ({ project: this.current()?.id, layout: this.settings.sidebarLayout() }),
    computation: () => new Set(),
  });
  private anchorId: SessionId | null = null;

  private readonly loadIds = computed(
    (): ReadonlyArray<ProjectId> =>
      this.projects
        .ordered()
        .map((project) => project.id)
        .sort(),
    {
      equal: (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
    },
  );

  private readonly sessionRevision = computed(() =>
    JSON.stringify([
      this.sessionsState.version() + this.tabs.sessionsVersion(),
      this.tabs
        .tabs()
        .filter((tab) => tab.session !== null)
        .map((tab) => [tab.session, tab.title]),
    ]),
  );
  private readonly loaded = resource({
    params: () => {
      const ids = this.loadIds();
      return ids.length === 0 ? undefined : ids;
    },
    loader: async ({ params }) => {
      const exit = await this.runtime.run(listAllSessions(params));
      if (exit._tag === 'Success') {
        for (const [, projectExit] of exit.value) {
          if (projectExit._tag === 'Success') this.sessionsState.remember(projectExit.value);
        }
      }
      return exit;
    },
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
    return { status: 'loaded', sessions: load.raw };
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.aborts.abort());
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
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
    void this.subscribeChanges();
  }

  private readonly activeSummaries = computed(() => {
    const state = this.sessions();
    return state.status === 'loaded' ? listed(state.sessions) : [];
  });

  private readonly archivedSummaries = computed(() => {
    const state = this.sessions();
    return state.status === 'loaded' ? archived(state.sessions) : [];
  });

  private readonly loadedSessionsMap = computed(
    (): ReadonlyMap<
      SessionId,
      { readonly projectId: ProjectId; readonly session: SessionSummary }
    > => {
      const map = new Map<
        SessionId,
        { readonly projectId: ProjectId; readonly session: SessionSummary }
      >();
      for (const [projectId, load] of this.rawByProject()) {
        if (load.status !== 'loaded') continue;
        for (const session of load.raw) map.set(session.id, { projectId, session });
      }
      return map;
    },
  );

  /** Currently selected ids restricted to Sessions still present in the loaded layout. */
  protected readonly selectedIds = computed((): ReadonlySet<SessionId> => {
    const raw = this.selected();
    if (raw.size === 0) return new Set();
    const present = this.loadedSessionsMap();
    const valid = new Set<SessionId>();
    for (const id of raw) {
      if (present.has(id)) valid.add(id);
    }
    return valid;
  });

  protected readonly selectedAllArchived = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return false;
    const loaded = this.loadedSessionsMap();
    for (const id of ids) {
      if (loaded.get(id)?.session.archivedAt === undefined) return false;
    }
    return true;
  });

  protected readonly draft = computed(() => {
    const project = this.current();
    return project === null ? null : this.tabs.draftOf(project.id);
  });

  protected readonly otherProjectAttention = computed(() => {
    const currentId = this.current()?.id;
    const byProject = this.rawByProject();
    return this.projects.ordered().some((project) => {
      if (project.id === currentId) return false;
      const load = byProject.get(project.id);
      return (
        load?.status === 'loaded' &&
        listed(load.raw).some((session) => session.attention !== undefined)
      );
    });
  });

  protected projectMarks(projectId: ProjectId): {
    readonly attention?: Attention;
    readonly running: boolean;
  } {
    const load = this.rawByProject().get(projectId);
    if (load?.status !== 'loaded') return { running: false };
    let attention: Attention | undefined;
    let running = false;
    for (const session of listed(load.raw)) {
      if (session.running === true) running = true;
      if (session.attention === 'needsAnswer') attention = 'needsAnswer';
      else if (session.attention === 'error' && attention === undefined) attention = 'error';
    }
    return attention === undefined ? { running } : { attention, running };
  }

  protected readonly groups = computed((): ReadonlyArray<SessionGroup<SessionRow>> => {
    if (this.current() === null) return [];
    const now = Date.now();
    const rows = this.toRows(this.activeSummaries(), false, now);
    const needsYou = rows.filter((row) => row.attention !== undefined);
    const rest = rows.filter((row) => row.attention === undefined);
    const dayGroups = groupByDay(rest, (row) => row.at, now, this.locale);
    return needsYou.length === 0
      ? dayGroups
      : [{ label: $localize`Needs you`, items: needsYou }, ...dayGroups];
  });

  protected readonly archivedRows = computed((): ReadonlyArray<SessionRow> => {
    if (this.current() === null) return [];
    const now = Date.now();
    return this.toRows(this.archivedSummaries(), true, now);
  });

  /** Visible row ids in top-to-bottom order within `projectId`, used for Shift-click range selection. */
  private visibleIdsFor(projectId: ProjectId | null): ReadonlyArray<SessionId> {
    if (this.settings.sidebarLayout() === 'allProjects') {
      const section =
        projectId === null
          ? undefined
          : this.allProjectSections().find((candidate) => candidate.project.id === projectId);
      if (section === undefined) return [];
      return [
        ...section.rows.map((row) => row.id),
        ...(section.archivedOpen ? section.archivedRows.map((row) => row.id) : []),
      ];
    }
    const active = this.groups().flatMap((group) => group.items.map((row) => row.id));
    const folded = this.archivedOpen() ? this.archivedRows().map((row) => row.id) : [];
    return [...active, ...folded];
  }

  private selectionProject(selected: ReadonlySet<SessionId>): ProjectId | null {
    const first = selected.values().next().value;
    return first === undefined ? null : (this.loadedSessionsMap().get(first)?.projectId ?? null);
  }

  protected readonly unarchivedTargets = computed((): ReadonlyArray<SessionTarget> =>
    this.activeSummaries().map((s) => ({ id: s.id, title: sessionTitle(s.title) })),
  );

  protected readonly allTargets = computed((): ReadonlyArray<SessionTarget> => {
    const state = this.sessions();
    if (state.status !== 'loaded') return [];
    return state.sessions.map((s) => ({ id: s.id, title: sessionTitle(s.title) }));
  });

  private toRows(
    summaries: ReadonlyArray<SessionSummary>,
    isArchived: boolean,
    now: number,
  ): ReadonlyArray<DatedRow> {
    const query = this.query().trim().toLocaleLowerCase(this.locale);
    const active = this.tabs.active()?.session ?? null;
    const selected = this.selectedIds();
    const openTabs = this.tabs.tabs();
    return summaries.flatMap((session): DatedRow[] => {
      const resolved = displayTitle(session, openTabs);
      if (query !== '' && !resolved.title.toLocaleLowerCase(this.locale).includes(query)) return [];
      const row: DatedRow = {
        id: session.id,
        title: resolved.title,
        meta: metaOf(session, this.tabs.isOpen(session.id), now, this.locale),
        active: session.id === active,
        untitled: resolved.untitled,
        selected: selected.has(session.id),
        archived: isArchived,
        at: session.lastActivityAt,
        ...(!isArchived && session.attention !== undefined ? { attention: session.attention } : {}),
        ...(!isArchived && session.running === true ? { running: true } : {}),
      };
      return [row];
    });
  }

  @HostListener('window:keydown.escape')
  protected onWindowEscape(): void {
    if (this.sessionsState.confirm() !== null || this.renamingProject() !== null) return;
    if (this.selectedIds().size > 0) this.clearSelection();
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected onRowClick(event: RowClickEvent): void {
    if (this.handleSelectionClick(event, this.current()?.id ?? null)) return;
    this.openSession(event.id);
  }

  protected onAllProjectsRowClick(payload: {
    readonly projectId: ProjectId;
    readonly event: RowClickEvent;
  }): void {
    if (this.handleSelectionClick(payload.event, payload.projectId)) return;
    this.openProjectSession({ projectId: payload.projectId, sessionId: payload.event.id });
  }

  private handleSelectionClick(event: RowClickEvent, projectId: ProjectId | null): boolean {
    const selected = this.selectedIds();
    const currentProject = this.selectionProject(selected);
    const sameProject = currentProject === null || currentProject === projectId;
    if (event.shiftKey) {
      const visible = this.visibleIdsFor(projectId);
      const startId =
        sameProject && this.anchorId !== null && visible.includes(this.anchorId)
          ? this.anchorId
          : event.id;
      const a = visible.indexOf(startId);
      const b = visible.indexOf(event.id);
      if (a !== -1 && b !== -1) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        this.selected.set(new Set(visible.slice(from, to + 1)));
      }
      if (!sameProject) this.anchorId = event.id;
      return true;
    }
    if (event.ctrlKey || event.metaKey) {
      // Multi-select is scoped to one Project (spec 7.3); switching Projects starts a fresh selection.
      if (!sameProject) {
        this.selected.set(new Set([event.id]));
        this.anchorId = event.id;
        return true;
      }
      const next = new Set(selected);
      if (next.has(event.id)) {
        next.delete(event.id);
      } else {
        next.add(event.id);
        this.anchorId = event.id;
      }
      this.selected.set(next);
      return true;
    }
    this.clearSelection();
    this.anchorId = event.id;
    return false;
  }

  protected toggleArchived(): void {
    this.archivedOpen.update((open) => !open);
  }

  protected toggleAllProjectsArchived(projectId: ProjectId): void {
    this.allProjectsArchivedOpen.update((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  protected readonly allProjectSections = computed((): ReadonlyArray<AllProjectsSection> => {
    const rawMap = this.rawByProject();
    const expanded = this.expandedProjects();
    const archivedOpenSet = this.allProjectsArchivedOpen();
    const selected = this.selectedIds();
    const openTabs = this.tabs.tabs();
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
        archivedOpen: archivedOpenSet.has(project.id),
        selected,
        tabs: openTabs,
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
    const entry = this.loadedSessionsMap().get(id);
    if (entry === undefined) return;
    this.tabs.open({
      id,
      projectId: entry.projectId,
      title: titleOf(entry.session.title),
      ...(entry.session.attention === undefined ? {} : { attention: entry.session.attention }),
      ...(entry.session.running === true ? { running: true } : {}),
    });
  }

  protected async renameSession(id: SessionId, title: string): Promise<void> {
    if (await this.sessionsState.rename(id, title)) {
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
      ...(session.attention === undefined ? {} : { attention: session.attention }),
      ...(session.running === true ? { running: true } : {}),
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

  private async subscribeChanges(): Promise<void> {
    await this.runtime.run(
      Stream.unwrap(sessionChanges).pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            this.applyChange(change);
          }),
        ),
        Effect.retry(Schedule.spaced('500 millis')),
      ),
      { signal: this.aborts.signal },
    );
  }

  private applyChange(change: SessionChange): void {
    const currentLoad = this.rawByProject().get(change.projectId);
    if (currentLoad?.status !== 'loaded') return;
    const index = currentLoad.raw.findIndex((s) => s.id === change.sessionId);
    if (index === -1) {
      if (change.state.runningTurn !== undefined) {
        void this.refreshProjects([change.projectId]);
      }
      return;
    }
    const nextRaw = currentLoad.raw.map((existing, i): SessionSummary => {
      if (i !== index) return existing;
      const running = change.state.runningTurn !== undefined;
      const startedTurn = running && existing.running !== true;
      const { attention: _prevAttention, running: _prevRunning, ...base } = existing;
      return {
        ...base,
        title: change.state.title,
        ...(change.state.attention === undefined ? {} : { attention: change.state.attention }),
        ...(running ? { running: true } : {}),
        ...(startedTurn ? { lastActivityAt: Math.max(existing.lastActivityAt, Date.now()) } : {}),
      };
    });
    this.sessionsState.remember(nextRaw);
    this.refreshedSessions.update((current) => {
      const next = new Map(current);
      next.set(change.projectId, { status: 'loaded', raw: nextRaw });
      return next;
    });
  }

  private async refreshProjects(projectIds: ReadonlyArray<ProjectId>): Promise<void> {
    const exit = await this.runtime.run(listAllSessions(projectIds), {
      signal: this.aborts.signal,
    });
    if (this.aborts.signal.aborted || exit._tag !== 'Success') return;
    this.refreshedSessions.update((current) => {
      const next = new Map(current);
      for (const [projectId, projectExit] of exit.value) {
        if (projectExit._tag === 'Success') {
          this.sessionsState.remember(projectExit.value);
          next.set(projectId, { status: 'loaded', raw: projectExit.value });
        }
      }
      return next;
    });
  }

  private targetsForRow(row: SessionRow | AllProjectsRow): ReadonlyArray<SessionTarget> {
    const selected = this.selectedIds();
    if (selected.size > 1 && row.selected) {
      const loaded = this.loadedSessionsMap();
      const targets: SessionTarget[] = [];
      for (const id of selected) {
        const entry = loaded.get(id);
        if (entry !== undefined) {
          targets.push({ id, title: sessionTitle(entry.session.title) });
        }
      }
      return targets.length > 0 ? targets : [{ id: row.id, title: row.title }];
    }
    return [{ id: row.id, title: row.title }];
  }

  protected archiveFromRow(row: SessionRow | AllProjectsRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.archive(targets);
  }

  protected unarchiveFromRow(row: SessionRow | AllProjectsRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.unarchive(targets);
  }

  protected deleteFromRow(row: SessionRow | AllProjectsRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.delete(targets);
  }

  private rawForProject(projectId?: ProjectId): ReadonlyArray<SessionSummary> {
    if (projectId === undefined) {
      const state = this.sessions();
      return state.status === 'loaded' ? state.sessions : [];
    }
    const load = this.rawByProject().get(projectId);
    return load !== undefined && load.status === 'loaded' ? load.raw : [];
  }

  protected unarchiveAllArchived(projectId?: ProjectId): void {
    const targets = archived(this.rawForProject(projectId)).map((s) => ({
      id: s.id,
      title: sessionTitle(s.title),
    }));
    this.clearSelection();
    void this.sessionsState.unarchive(targets);
  }

  protected deleteAllArchived(projectId?: ProjectId): void {
    const targets = archived(this.rawForProject(projectId)).map((s) => ({
      id: s.id,
      title: sessionTitle(s.title),
    }));
    this.clearSelection();
    void this.sessionsState.delete(targets);
  }

  protected archiveAllProject(projectId?: ProjectId): void {
    const targets =
      projectId === undefined
        ? this.unarchivedTargets()
        : listed(this.rawForProject(projectId)).map((s) => ({
            id: s.id,
            title: sessionTitle(s.title),
          }));
    this.clearSelection();
    void this.sessionsState.archive(targets);
  }

  protected deleteAllProject(projectId?: ProjectId): void {
    const targets =
      projectId === undefined
        ? this.allTargets()
        : this.rawForProject(projectId).map((s) => ({
            id: s.id,
            title: sessionTitle(s.title),
          }));
    this.clearSelection();
    void this.sessionsState.delete(targets);
  }

  protected locateProject(id: ProjectId): void {
    void this.projects.locate(id);
  }

  protected startRename(project: Project): void {
    this.renamingDone = false;
    this.renameDraft.set(project.name);
    this.renamingProject.set(project.id);
  }

  protected cancelRename(): void {
    this.renamingDone = true;
    this.renamingProject.set(null);
  }

  protected async commitRename(project: Project): Promise<void> {
    if (this.renamingDone || this.renamingProject() !== project.id) return;
    this.renamingDone = true;
    const next = this.renameDraft();
    this.renamingProject.set(null);
    await this.projects.rename(project.id, next);
  }

  protected removeProject(project: Project): void {
    const ids = this.rawForProject(project.id).map((s) => s.id);
    void this.sessionsState.removeProject(project, ids);
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
