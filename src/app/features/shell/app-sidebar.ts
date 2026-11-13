import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  HostListener,
  LOCALE_ID,
  computed,
  effect,
  inject,
  linkedSignal,
  resource,
  signal,
  viewChild,
} from '@angular/core';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmSidebarImports } from '@ui/sidebar';
import { Effect } from 'effect';
import { ProjectId, type Project } from '../../../shared/projects/projects.rpc';
import type { SessionId, SessionSummary } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { ProjectSettingsState } from './project-settings-state';
import { ProjectsState } from './projects-state';
import {
  archived,
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

/** A row with the time it is grouped by. */
type DatedRow = SessionRow & { readonly at: number };

type SessionsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly sessions: ReadonlyArray<SessionSummary> };

/**
 * The One Project sidebar: a Project switcher, New Session and search, the current Project's Sessions grouped by day
 * plus an Archived fold, and the Settings gear at the foot. The current Project follows the active Tab; picking
 * another one shows it.
 */
@Component({
  selector: 'app-sidebar',
  imports: [
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmContextMenuImports,
    HlmInputImports,
    SessionList,
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
        @if (current(); as project) {
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
        @if (current(); as project) {
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

      <div hlmSidebarFooter>
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
  private readonly locale = inject(LOCALE_ID);
  protected readonly tabs = inject(Tabs);
  protected readonly settings = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);
  protected readonly projectSettings = inject(ProjectSettingsState);
  private readonly sessionsState = inject(SessionsState);

  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');

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
  protected readonly renamingProject = signal<ProjectId | null>(null);
  protected readonly renameDraft = signal('');
  private renamingDone = false;

  protected readonly archivedOpen = linkedSignal<ProjectId | undefined, boolean>({
    source: () => this.current()?.id,
    computation: () => false,
  });

  private readonly selected = linkedSignal<ProjectId | undefined, ReadonlySet<SessionId>>({
    source: () => this.current()?.id,
    computation: () => new Set(),
  });
  private anchorId: SessionId | null = null;

  constructor() {
    effect(() => {
      const input = this.renameInput()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
  }

  private readonly loaded = resource({
    params: () => {
      const id = this.current()?.id;
      if (id === undefined) return undefined;
      return `${id}\0${this.sessionsState.version() + this.tabs.sessionsVersion()}`;
    },
    loader: async ({ params }) => {
      const id = ProjectId.make(params.slice(0, params.indexOf('\0')));
      const exit = await this.runtime.run(listSessions(id));
      if (exit._tag === 'Success') this.sessionsState.remember(exit.value);
      return exit;
    },
  });

  protected readonly sessions = computed((): SessionsLoad => {
    if (this.loaded.isLoading()) return { status: 'loading' };
    const exit = this.loaded.hasValue() ? this.loaded.value() : undefined;
    if (exit === undefined) return { status: 'loading' };
    return exit._tag === 'Success'
      ? { status: 'loaded', sessions: exit.value }
      : { status: 'failed' };
  });

  private readonly activeSummaries = computed(() => {
    const state = this.sessions();
    return state.status === 'loaded' ? listed(state.sessions) : [];
  });

  private readonly archivedSummaries = computed(() => {
    const state = this.sessions();
    return state.status === 'loaded' ? archived(state.sessions) : [];
  });

  /** Currently selected ids restricted to Sessions still in this Project. */
  protected readonly selectedIds = computed((): ReadonlySet<SessionId> => {
    const state = this.sessions();
    const raw = this.selected();
    if (state.status !== 'loaded' || raw.size === 0) return new Set();
    const present = new Set(state.sessions.map((s) => s.id));
    const valid = new Set<SessionId>();
    for (const id of raw) {
      if (present.has(id)) valid.add(id);
    }
    return valid;
  });

  protected readonly selectedAllArchived = computed(() => {
    const ids = this.selectedIds();
    if (ids.size === 0) return false;
    const archivedIds = new Set(this.archivedSummaries().map((s) => s.id));
    for (const id of ids) {
      if (!archivedIds.has(id)) return false;
    }
    return true;
  });

  protected readonly draft = computed(() => {
    const project = this.current();
    return project === null ? null : this.tabs.draftOf(project.id);
  });

  protected readonly groups = computed((): ReadonlyArray<SessionGroup<SessionRow>> => {
    if (this.current() === null) return [];
    const now = Date.now();
    return groupByDay(
      this.toRows(this.activeSummaries(), false, now),
      (row) => row.at,
      now,
      this.locale,
    );
  });

  protected readonly archivedRows = computed((): ReadonlyArray<SessionRow> => {
    if (this.current() === null) return [];
    const now = Date.now();
    return this.toRows(this.archivedSummaries(), true, now);
  });

  /** Visible row ids in top-to-bottom order, used for Shift-click range selection. */
  private readonly visibleIds = computed((): ReadonlyArray<SessionId> => {
    const active = this.groups().flatMap((group) => group.items.map((row) => row.id));
    const folded = this.archivedOpen() ? this.archivedRows().map((row) => row.id) : [];
    return [...active, ...folded];
  });

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
    return summaries.flatMap((session): DatedRow[] => {
      const title = sessionTitle(session.title);
      if (query !== '' && !title.toLocaleLowerCase(this.locale).includes(query)) return [];
      const age = $localize`active ${shortAge(session.lastActivityAt, now, this.locale)}:age:`;
      const meta = this.tabs.isOpen(session.id) ? `${age} · ${$localize`open in a Tab`}` : age;
      return [
        {
          id: session.id,
          title,
          meta,
          active: session.id === active,
          selected: selected.has(session.id),
          archived: isArchived,
          at: session.lastActivityAt,
        },
      ];
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
    if (event.shiftKey) {
      const visible = this.visibleIds();
      const startId =
        this.anchorId !== null && visible.includes(this.anchorId) ? this.anchorId : event.id;
      const a = visible.indexOf(startId);
      const b = visible.indexOf(event.id);
      if (a !== -1 && b !== -1) {
        const [from, to] = a <= b ? [a, b] : [b, a];
        this.selected.set(new Set(visible.slice(from, to + 1)));
      }
      return;
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(this.selectedIds());
      if (next.has(event.id)) {
        next.delete(event.id);
      } else {
        next.add(event.id);
        this.anchorId = event.id;
      }
      this.selected.set(next);
      return;
    }
    this.clearSelection();
    this.anchorId = event.id;
    this.openSession(event.id);
  }

  protected toggleArchived(): void {
    this.archivedOpen.update((open) => !open);
  }

  protected newSession(projectId: ProjectId): void {
    this.tabs.startDraft(projectId);
  }

  protected openSession(id: SessionId): void {
    const project = this.current();
    const state = this.sessions();
    if (project === null || state.status !== 'loaded') return;
    const session = state.sessions.find((candidate) => candidate.id === id);
    if (session === undefined) return;
    this.tabs.open({ id, projectId: project.id, title: sessionTitle(session.title) });
  }

  private targetsForRow(row: SessionRow): ReadonlyArray<SessionTarget> {
    const selected = this.selectedIds();
    if (selected.size > 1 && row.selected) {
      const state = this.sessions();
      if (state.status !== 'loaded') return [{ id: row.id, title: row.title }];
      return state.sessions
        .filter((s) => selected.has(s.id))
        .map((s) => ({ id: s.id, title: sessionTitle(s.title) }));
    }
    return [{ id: row.id, title: row.title }];
  }

  protected archiveFromRow(row: SessionRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.archive(targets);
  }

  protected unarchiveFromRow(row: SessionRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.unarchive(targets);
  }

  protected deleteFromRow(row: SessionRow): void {
    const targets = this.targetsForRow(row);
    this.clearSelection();
    void this.sessionsState.delete(targets);
  }

  protected unarchiveAllArchived(): void {
    const targets = this.archivedSummaries().map((s) => ({
      id: s.id,
      title: sessionTitle(s.title),
    }));
    this.clearSelection();
    void this.sessionsState.unarchive(targets);
  }

  protected deleteAllArchived(): void {
    const targets = this.archivedSummaries().map((s) => ({
      id: s.id,
      title: sessionTitle(s.title),
    }));
    this.clearSelection();
    void this.sessionsState.delete(targets);
  }

  protected archiveAllProject(): void {
    const targets = this.unarchivedTargets();
    this.clearSelection();
    void this.sessionsState.archive(targets);
  }

  protected deleteAllProject(): void {
    const targets = this.allTargets();
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
    const ids = this.allTargets().map((t) => t.id);
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

  protected async addProject(): Promise<void> {
    const project = await this.projects.add();
    if (project !== null) this.pick(project.id);
  }
}
