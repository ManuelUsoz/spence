import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmSidebarImports } from '@ui/sidebar';
import { Effect, Schedule, Stream } from 'effect';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  Attention,
  SessionChange,
  SessionId,
  SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { ProjectsState } from './projects-state';
import { groupByDay, listed, sessionTitle, shortAge, type SessionGroup } from './session-groups';
import { SessionList, type SessionRow } from './session-list';
import { SettingsState } from './settings-state';

const listSessions = Effect.fnUntraced(function* (projectId: ProjectId) {
  const api = yield* DesktopApi;
  return yield* api['Session.list']({ projectId });
});

const sessionChanges = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return api['Session.changes']();
});

function metaOf(session: SessionSummary, openInTab: boolean, now: number, locale: string): string {
  const parts = [$localize`active ${shortAge(session.lastActivityAt, now, locale)}:age:`];
  if (session.attention === 'needsAnswer') parts.push($localize`waiting for your answer`);
  else if (session.attention === 'error') parts.push($localize`error`);
  if (openInTab) parts.push($localize`open in a Tab`);
  return parts.join(' · ');
}

/** A row with the time it is grouped by. */
type DatedRow = SessionRow & { readonly at: number };

type SessionsLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly sessions: ReadonlyArray<SessionSummary> };

/**
 * The One Project sidebar: a Project switcher, New Session and search, the current Project's Sessions grouped by day,
 * and the Settings gear at the foot. The current Project follows the active Tab; picking another one shows it.
 */
@Component({
  selector: 'app-sidebar',
  imports: [ActivityMark, HlmSidebarImports, HlmDropdownMenuImports, SessionList],
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
                [draft]="draft() !== null"
                [draftActive]="draft() !== null && draft()?.id === tabs.activeId()"
                (open)="openSession($event)"
                (openDraft)="newSession(project.id)"
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
  `,
})
export class AppSidebar {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  protected readonly tabs = inject(Tabs);
  protected readonly settings = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);

  private readonly aborts = new AbortController();
  private readonly loadingProjects = new Set<ProjectId>();
  private readonly projectSessions = signal<ReadonlyMap<ProjectId, SessionsLoad>>(new Map());

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

  constructor() {
    this.destroyRef.onDestroy(() => this.aborts.abort());
    effect(() => {
      for (const project of this.projects.ordered()) {
        this.ensureProjectLoaded(project.id);
      }
    });
    void this.subscribeChanges();
  }

  protected readonly sessions = computed((): SessionsLoad => {
    const current = this.current();
    if (current === null) return { status: 'loading' };
    return this.projectSessions().get(current.id) ?? { status: 'loading' };
  });

  protected readonly draft = computed(() => {
    const project = this.current();
    return project === null ? null : this.tabs.draftOf(project.id);
  });

  protected readonly otherProjectAttention = computed(() => {
    const currentId = this.current()?.id;
    const byProject = this.projectSessions();
    return this.projects.ordered().some((project) => {
      if (project.id === currentId) return false;
      const load = byProject.get(project.id);
      return (
        load?.status === 'loaded' &&
        load.sessions.some((session) => session.attention !== undefined)
      );
    });
  });

  protected projectMarks(projectId: ProjectId): {
    readonly attention?: Attention;
    readonly running: boolean;
  } {
    const load = this.projectSessions().get(projectId);
    if (load?.status !== 'loaded') return { running: false };
    let attention: Attention | undefined;
    let running = false;
    for (const session of load.sessions) {
      if (session.running === true) running = true;
      if (session.attention === 'needsAnswer') attention = 'needsAnswer';
      else if (session.attention === 'error' && attention === undefined) attention = 'error';
    }
    return attention === undefined ? { running } : { attention, running };
  }

  protected readonly groups = computed((): ReadonlyArray<SessionGroup<SessionRow>> => {
    const state = this.sessions();
    const project = this.current();
    if (state.status !== 'loaded' || project === null) return [];
    const query = this.query().trim().toLocaleLowerCase(this.locale);
    const now = Date.now();
    const active = this.tabs.active()?.session ?? null;
    const needsYou: DatedRow[] = [];
    const rest: DatedRow[] = [];
    for (const session of state.sessions) {
      const title = sessionTitle(session.title);
      if (query !== '' && !title.toLocaleLowerCase(this.locale).includes(query)) continue;
      const row: DatedRow = {
        id: session.id,
        title,
        meta: metaOf(session, this.tabs.isOpen(session.id), now, this.locale),
        active: session.id === active,
        ...(session.attention === undefined ? {} : { attention: session.attention }),
        ...(session.running === true ? { running: true } : {}),
        at: session.lastActivityAt,
      };
      if (session.attention !== undefined) needsYou.push(row);
      else rest.push(row);
    }
    const dayGroups = groupByDay(rest, (row) => row.at, now, this.locale);
    return needsYou.length === 0
      ? dayGroups
      : [{ label: $localize`Needs you`, items: needsYou }, ...dayGroups];
  });

  protected newSession(projectId: ProjectId): void {
    this.tabs.startDraft(projectId);
  }

  protected openSession(id: SessionId): void {
    const project = this.current();
    const state = this.sessions();
    if (project === null || state.status !== 'loaded') return;
    const session = state.sessions.find((candidate) => candidate.id === id);
    if (session === undefined) return;
    this.tabs.open({
      id,
      projectId: project.id,
      title: sessionTitle(session.title),
      ...(session.attention === undefined ? {} : { attention: session.attention }),
      ...(session.running === true ? { running: true } : {}),
    });
  }

  private ensureProjectLoaded(projectId: ProjectId): void {
    if (this.projectSessions().has(projectId) || this.loadingProjects.has(projectId)) return;
    void this.loadProject(projectId, false);
  }

  private async loadProject(projectId: ProjectId, force: boolean): Promise<void> {
    if (!force && this.loadingProjects.has(projectId)) return;
    this.loadingProjects.add(projectId);
    if (!this.projectSessions().has(projectId)) {
      this.setProjectLoad(projectId, { status: 'loading' });
    }
    const exit = await this.runtime.run(listSessions(projectId), { signal: this.aborts.signal });
    this.loadingProjects.delete(projectId);
    if (this.aborts.signal.aborted) return;
    if (exit._tag === 'Success') {
      this.setProjectLoad(projectId, { status: 'loaded', sessions: listed(exit.value) });
      return;
    }
    if (this.projectSessions().get(projectId)?.status !== 'loaded') {
      this.setProjectLoad(projectId, { status: 'failed' });
    }
  }

  private setProjectLoad(projectId: ProjectId, load: SessionsLoad): void {
    this.projectSessions.update((map) => {
      const next = new Map(map);
      next.set(projectId, load);
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
    const currentLoad = this.projectSessions().get(change.projectId);
    if (currentLoad?.status !== 'loaded') return;
    const index = currentLoad.sessions.findIndex((s) => s.id === change.sessionId);
    if (index === -1) {
      if (change.state.runningTurn !== undefined) {
        void this.loadProject(change.projectId, true);
      }
      return;
    }
    const nextSessions = currentLoad.sessions.map((existing, i): SessionSummary => {
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
    this.setProjectLoad(change.projectId, { status: 'loaded', sessions: listed(nextSessions) });
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
