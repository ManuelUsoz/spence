import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  Injector,
  type ElementRef,
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
import { HlmKbdImports } from '@ui/kbd';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmTooltipImports } from '@ui/tooltip';
import { Effect, Schedule, Stream } from 'effect';
import type { DeviceId } from '../../../shared/devices/devices.rpc';
import type { Project, ProjectId } from '../../../shared/projects/projects.rpc';
import type {
  Attention,
  LiveState,
  SessionChange,
  SessionId,
  SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import type { PanelId } from '../../../shared/tabs/tabs.rpc';
import { allTabPanels, MAX_PANES_PER_TAB } from '../../../shared/tabs/workspace-layout';
import { DesktopApi } from '../../core/desktop-api';
import { onDevice } from '../../core/device-scope';
import { EffectRuntime } from '../../core/effect-runtime';
import { RemoteDevices } from '../../core/remote-devices';
import { isTextInputTarget, Keymap } from '../../core/keymap';
import { Tabs, titleOf, type OpenSession } from '../../core/tabs';
import { type DeviceProject, ProjectsState } from './projects-state';
import {
  archived,
  capSessions,
  groupTodayEarlier,
  listed,
  SESSION_CAP,
  sessionTitle,
  shortAge,
  type SessionGroup,
} from './session-groups';
import { type RowClickEvent, SessionList, type SessionRow } from './session-list';
import { SessionsState, type SessionTarget } from './sessions-state';
import { SettingsState } from './settings-state';
import { wireEditorFocus } from './sidebar-keys';

const listSessions = (projectId: ProjectId, device: DeviceId | undefined) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    return yield* api['Session.list']({ projectId });
  }).pipe(onDevice(device));

/** Each Project's Sessions, asked of the Device the Project belongs to. */
const listAllSessions = (
  projectIds: ReadonlyArray<ProjectId>,
  deviceOf: (projectId: ProjectId) => DeviceId | undefined,
) =>
  Effect.all(
    projectIds.map((projectId) =>
      Effect.map(
        Effect.exit(listSessions(projectId, deviceOf(projectId))),
        (exit) => [projectId, exit] as const,
      ),
    ),
    { concurrency: 'unbounded' },
  );

const sessionChanges = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return api['Session.changes']();
});

/** Why a Session sits in "Needs you": the second line of its row. */
const reasonOf = (session: SessionSummary): string | undefined => {
  if (session.archivedAt !== undefined) return undefined;
  if (session.attention === 'needsAnswer') return $localize`Waiting for your answer`;
  if (session.attention === 'error') return $localize`Stopped with an error`;
  return undefined;
};
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

const displayTitle = (
  session: SessionSummary,
  live: LiveState | undefined,
): { readonly title: string; readonly untitled: boolean } => {
  const resolved = live !== undefined ? titleOf(live.title) : titleOf(session.title);
  return {
    title: resolved ?? $localize`New Session`,
    untitled: resolved === null,
  };
};

/**
 * The sidebar: the Project selector, search and New Session on top, the Project's Sessions below as Needs you, Today
 * and Earlier groups (capped, with Show more) and an Archived fold, and Settings at the foot.
 */
@Component({
  selector: 'app-sidebar',
  imports: [
    ActivityMark,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmContextMenuImports,
    HlmInputImports,
    HlmKbdImports,
    HlmTooltipImports,
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
      <div hlmSidebarHeader class="gap-1 p-2">
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
              (keydown.enter)="$event.preventDefault(); commitRename(project, true)"
              (blur)="commitRename(project, false)"
            />
          } @else {
            <button
              #switcherTrigger
              type="button"
              data-testid="current-project"
              class="hover:bg-sidebar-accent focus-visible:ring-ring flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none focus-visible:ring-2"
              [hlmTooltip]="switcherTip"
              position="right"
              [hlmDropdownMenuTrigger]="switcher"
              [hlmContextMenuTrigger]="projectMenu"
            >
              <span
                class="bg-sidebar-primary text-sidebar-primary-foreground flex size-[26px] shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase"
                aria-hidden="true"
                >{{ project.name.slice(0, 1) }}</span
              >
              <span class="flex min-w-0 flex-1 flex-col leading-tight">
                <span class="truncate text-sm font-semibold">{{ project.name }}</span>
                @if (deviceName(project); as device) {
                  <span
                    class="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs"
                    data-testid="project-device"
                  >
                    <span
                      aria-hidden="true"
                      class="bg-online size-1.5 shrink-0 rounded-full"
                    ></span>
                    <span class="truncate">{{ device }}</span>
                  </span>
                } @else if (project.folderMissing) {
                  <span class="text-destructive truncate text-xs" i18n>Folder missing</span>
                } @else {
                  <span
                    class="text-muted-foreground truncate font-mono text-xs"
                    data-testid="project-path"
                    >{{ project.path }}</span
                  >
                }
              </span>
              @if (otherProjectAttention()) {
                <span
                  data-testid="other-project-attention"
                  class="size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
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
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />
              </svg>
            </button>
          }

          <div class="flex items-center gap-1 pt-1.5">
            <div class="relative min-w-0 flex-1">
              <svg
                class="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5" />
              </svg>
              <input
                #sessionSearchInput
                hlmSidebarInput
                data-testid="session-search"
                class="w-full rounded-lg pl-8"
                placeholder="Search"
                i18n-placeholder
                aria-label="Search this Project"
                i18n-aria-label
                [hlmTooltip]="searchTip"
                position="right"
                [value]="query()"
                (input)="query.set($any($event.target).value)"
              />
            </div>
            <button
              type="button"
              data-testid="new-session"
              class="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-lg outline-none focus-visible:ring-2"
              [hlmTooltip]="newSessionTip"
              position="right"
              aria-label="New Session"
              i18n-aria-label
              (click)="newSession(project.id)"
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
                <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <path d="M18.4 2.6a2.1 2.1 0 1 1 3 3L12 15l-4 1 1-4Z" />
              </svg>
            </button>
          </div>
        } @else if (projects.state().status === 'loaded') {
          <p class="text-muted-foreground px-2 py-1 text-sm" data-testid="no-projects" i18n>
            No Projects yet.
          </p>
          <button
            type="button"
            data-testid="add-project"
            class="hover:bg-sidebar-accent focus-visible:ring-ring flex h-8 items-center gap-2 rounded-lg border px-2 text-left text-sm outline-none focus-visible:ring-2"
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
          @for (device of devices.online(); track device.id) {
            <button
              type="button"
              data-testid="add-project-remote"
              class="hover:bg-sidebar-accent focus-visible:ring-ring flex h-8 items-center gap-2 rounded-lg border px-2 text-left text-sm outline-none focus-visible:ring-2"
              (click)="addProject(device.id)"
            >
              <svg
                class="size-4 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              <span class="truncate" i18n>Add Project on {{ device.name }}</span>
            </button>
          }
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
                [hiddenCount]="hiddenCount()"
                [archived]="archivedRows()"
                [archivedOpen]="archivedOpen()"
                [selectedCount]="selectedIds().size"
                [selectedAllArchived]="selectedAllArchived()"
                (rowClick)="onRowClick($event)"
                (toggleSelect)="toggleSelect($event, project.id)"
                (extendSelection)="extendSelection($event, project.id)"
                (deleteKey)="archiveFromDelete($event)"
                (rename)="renameSession($event.id, $event.title)"
                (showMore)="showAll.set(true)"
                (toggleArchived)="toggleArchived()"
                (clearSelection)="clearSelection()"
                (menuOpen)="openSession($event.id)"
                (menuOpenInNewTab)="openSession($event.id)"
                (menuOpenInSplit)="openSessionInSplit($event.id)"
                (menuAddToStack)="openSessionInStack($event.id)"
                (menuArchive)="archiveFromRow($event)"
                (menuUnarchive)="unarchiveFromRow($event)"
                (menuDelete)="deleteFromRow($event)"
                (unarchiveAll)="unarchiveAllArchived()"
                (deleteAllArchived)="deleteAllArchived()"
              />
              @if (groups().length === 0 && archivedRows().length === 0) {
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

      <div hlmSidebarFooter class="p-2">
        <button
          type="button"
          data-testid="open-settings"
          class="hover:bg-sidebar-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-[34px] w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm outline-none focus-visible:ring-2"
          (click)="settings.toggle()"
        >
          <svg
            class="size-4 shrink-0"
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
          <span class="flex-1" i18n>Settings</span>
          <kbd class="text-muted-foreground font-mono text-xs">{{
            keymap.format({ mod: true, key: ',' })
          }}</kbd>
        </button>
      </div>
    </hlm-sidebar>

    <ng-template #switcher>
      <hlm-dropdown-menu class="w-72" data-testid="project-menu">
        @for (group of projectGroups(); track group.device ?? 'local') {
          @if (projects.hasRemote()) {
            <div
              class="text-muted-foreground flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs font-medium"
              data-testid="project-group"
            >
              @if (group.device !== undefined) {
                <span
                  aria-hidden="true"
                  class="bg-online size-1.5 shrink-0 rounded-full"
                  data-testid="project-group-online"
                ></span>
              }
              @if (group.name; as name) {
                <span class="truncate" data-testid="project-group-name">{{ name }}</span>
              } @else {
                <span class="truncate" data-testid="project-group-name" i18n>This Device</span>
              }
              @if (groupNeedsYou(group.projects)) {
                <span
                  data-testid="project-group-attention"
                  class="ml-auto size-1.5 shrink-0 rounded-full bg-[var(--attention)]"
                  role="img"
                  aria-label="Needs you"
                  i18n-aria-label
                ></span>
              }
            </div>
            @if (group.status === 'loading') {
              <p class="text-muted-foreground px-2 py-1 text-xs" i18n>Loading…</p>
            } @else if (group.status === 'failed') {
              <p class="text-destructive px-2 py-1 text-xs" data-testid="project-group-failed" i18n>
                Could not load its Projects.
              </p>
            }
          }
          @for (project of group.projects; track project.id) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="project-option"
              class="h-auto gap-2.5 py-1.5"
              (triggered)="pick(project.id)"
            >
              <span
                class="flex size-[26px] shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase"
                [class]="
                  project.id === current()?.id
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                    : 'bg-muted text-muted-foreground'
                "
                aria-hidden="true"
                >{{ project.name.slice(0, 1) }}</span
              >
              <span class="flex min-w-0 flex-1 flex-col leading-tight">
                <span class="truncate font-medium" data-testid="project-option-name">{{
                  project.name
                }}</span>
                <span
                  class="text-muted-foreground truncate font-mono text-xs"
                  data-testid="project-option-path"
                  >{{ project.path }}</span
                >
              </span>
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
          <span i18n>Add Project…</span>
        </button>
        @for (device of devices.online(); track device.id) {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="add-project-remote"
            (triggered)="addProject(device.id)"
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
            <span class="truncate" i18n>Add Project on {{ device.name }}…</span>
          </button>
        }
        @if (current(); as project) {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="switcher-project-settings"
            (triggered)="settings.showProject(project.id)"
            i18n
          >
            Project settings
          </button>
        }
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
            (triggered)="settings.showProject(project.id)"
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

    <ng-template #newSessionTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>New Session</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: 'n' }) }}</kbd>
      </span>
    </ng-template>

    <ng-template #searchTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Search this Project</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: 'k' }) }}</kbd>
      </span>
    </ng-template>

    <ng-template #switcherTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Switch Project</span>
        <kbd hlmKbd class="font-mono font-normal">{{ keymap.format({ mod: true, key: 'p' }) }}</kbd>
      </span>
    </ng-template>
  `,
})
export class AppSidebar {
  private readonly runtime = inject(EffectRuntime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);
  protected readonly keymap = inject(Keymap);
  protected readonly tabs = inject(Tabs);
  protected readonly settings = inject(SettingsState);
  protected readonly projects = inject(ProjectsState);
  private readonly sessionsState = inject(SessionsState);
  protected readonly devices = inject(RemoteDevices);
  private readonly injector = inject(Injector);

  private readonly renameInput = viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly switcherTrigger = viewChild<ElementRef<HTMLButtonElement>>('switcherTrigger');
  private readonly sessionSearchInput =
    viewChild<ElementRef<HTMLInputElement>>('sessionSearchInput');

  private readonly aborts = new AbortController();
  private readonly pendingSwitcherFocus = signal(false);

  /** The selector's groups; with no Remote device, only the Local one, unnamed. */
  protected readonly projectGroups = computed(() => this.projects.groups());

  /** The Remote device a Project belongs to, by name; `null` for a Local Project. */
  protected deviceName(project: DeviceProject): string | null {
    return project.device === undefined ? null : (this.devices.nameOf(project.device) ?? null);
  }

  protected readonly current = computed((): DeviceProject | null => {
    const activeId = this.tabs.activeProjectId();
    const ordered = this.projects.ordered();
    const matched =
      activeId === null ? undefined : ordered.find((project) => project.id === activeId);
    // With no Local Project yet, a connected Remote device's Project is shown rather than nothing.
    return matched ?? this.projects.lastUsed() ?? ordered[0] ?? null;
  });

  protected readonly query = signal('');
  private previousTabPanels = new Map<PanelId, boolean>();
  protected readonly renamingProject = signal<ProjectId | null>(null);
  protected readonly renameDraft = signal('');
  private renamingDone = false;

  protected readonly archivedOpen = linkedSignal<ProjectId | undefined, boolean>({
    source: () => this.current()?.id,
    computation: () => false,
  });

  /** Whether "Show more" revealed every Session; folds back when another Project is picked. */
  protected readonly showAll = linkedSignal<ProjectId | undefined, boolean>({
    source: () => this.current()?.id,
    computation: () => false,
  });

  private readonly selected = linkedSignal<ProjectId | undefined, ReadonlySet<SessionId>>({
    source: () => this.current()?.id,
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
        .allTabs()
        .flatMap((tab) =>
          allTabPanels(tab).flatMap((panel) =>
            panel.spec._tag === 'Session' &&
            panel.spec.draft !== true &&
            panel.spec.sessionId !== undefined
              ? [
                  [
                    panel.spec.sessionId,
                    this.tabs.sessionStatus(panel.spec.sessionId)?.title ?? null,
                  ],
                ]
              : [],
          ),
        ),
    ]),
  );
  private readonly loaded = resource({
    params: () => {
      const ids = this.loadIds();
      return ids.length === 0 ? undefined : ids;
    },
    loader: async ({ params }) => {
      const exit = await this.runtime.run(
        listAllSessions(params, (id) => this.projects.deviceOf(id)),
      );
      if (exit._tag === 'Success') {
        for (const [projectId, projectExit] of exit.value) {
          if (projectExit._tag === 'Success') {
            this.sessionsState.remember(projectExit.value, projectId);
          }
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
    this.registerShortcuts();
    wireEditorFocus(this.renameInput);
    effect(() => {
      if (!this.pendingSwitcherFocus() || this.renamingProject() !== null) return;
      const trigger = this.switcherTrigger()?.nativeElement;
      if (trigger !== undefined) {
        untracked(() => this.pendingSwitcherFocus.set(false));
        trigger.focus({ preventScroll: true });
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
      if (!this.tabs.restored()) return;
      const projectState = this.projects.state();
      if (projectState.status !== 'loaded') return;
      const activeId = this.tabs.activeProjectId();
      const known =
        activeId !== null &&
        (this.tabs.projectDevice(activeId) !== undefined ||
          this.projects.ordered().some((p) => p.id === activeId));
      if (known) return;
      const fallback = this.projects.lastUsed() ?? this.projects.ordered()[0] ?? null;
      if (fallback !== null) {
        untracked(() => this.tabs.switchProject(fallback.id));
      }
    });
    effect(() => {
      const keptProjectIds = new Set<ProjectId>();
      const nextPanels = new Map<PanelId, boolean>();
      for (const project of this.tabs.workspace().projects) {
        for (const tab of project.tabs) {
          for (const panel of allTabPanels(tab)) {
            if (panel.spec._tag !== 'Session') continue;
            const isKept = panel.spec.draft !== true && panel.spec.sessionId !== undefined;
            nextPanels.set(panel.id, isKept);
            if (this.previousTabPanels.get(panel.id) === false && isKept) {
              keptProjectIds.add(project.projectId);
            }
          }
        }
      }
      this.previousTabPanels = nextPanels;
      if (keptProjectIds.size > 0) {
        untracked(() => void this.refreshProjects([...keptProjectIds]));
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

  /** A Device's "Needs you": one of its Projects has a listed Session calling for Attention. */
  protected groupNeedsYou(projects: ReadonlyArray<DeviceProject>): boolean {
    return projects.some((project) => this.projectMarks(project.id).attention !== undefined);
  }

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

  /** Needs you first, then the capped rest (the open Session and running ones stay past the cap) by day. */
  private readonly layout = computed(() => {
    if (this.current() === null) return { groups: [], hiddenCount: 0 };
    const now = Date.now();
    const rows = this.toRows(this.activeSummaries(), false, now);
    const needsYou = rows.filter((row) => row.attention !== undefined);
    const rest = rows.filter((row) => row.attention === undefined);
    const capped = capSessions(rest, {
      cap: SESSION_CAP,
      expanded: this.showAll() || this.query().trim() !== '',
      isPinned: (row) => row.active || row.running === true,
    });
    const dayGroups = groupTodayEarlier(capped.visible, (row) => row.at, now);
    return {
      groups:
        needsYou.length === 0
          ? dayGroups
          : [{ label: $localize`Needs you`, items: needsYou }, ...dayGroups],
      hiddenCount: capped.hiddenCount,
    };
  });

  protected readonly groups = computed(
    (): ReadonlyArray<SessionGroup<SessionRow>> => this.layout().groups,
  );
  protected readonly hiddenCount = computed(() => this.layout().hiddenCount);

  protected readonly archivedRows = computed((): ReadonlyArray<SessionRow> => {
    if (this.current() === null) return [];
    const now = Date.now();
    return this.toRows(this.archivedSummaries(), true, now);
  });

  /** Visible row ids in top-to-bottom order, used for Shift-click range selection. */
  private visibleIds(): ReadonlyArray<SessionId> {
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
    const active = this.tabs.highlighted();
    const selected = this.selectedIds();
    const activeTab = this.tabs.activeTab();
    const canSplitActive = activeTab === null || this.tabs.paneCount(activeTab) < MAX_PANES_PER_TAB;
    return summaries.flatMap((session): DatedRow[] => {
      const resolved = displayTitle(session, this.tabs.liveState(session.id));
      if (query !== '' && !resolved.title.toLocaleLowerCase(this.locale).includes(query)) return [];
      const row: DatedRow = {
        id: session.id,
        title: resolved.title,
        age: shortAge(session.lastActivityAt, now, this.locale),
        ...(reasonOf(session) === undefined ? {} : { reason: reasonOf(session) }),
        active: session.id === active,
        untitled: resolved.untitled,
        selected: selected.has(session.id),
        archived: isArchived,
        canOpenInSplit: canSplitActive || this.tabs.isOpen(session.id),
        at: session.lastActivityAt,
        ...(!isArchived && session.attention !== undefined ? { attention: session.attention } : {}),
        ...(!isArchived && session.running === true ? { running: true } : {}),
      };
      return [row];
    });
  }

  private registerShortcuts(): void {
    const destroyRef = this.destroyRef;
    this.keymap.register({
      binding: { mod: true, key: 'n' },
      run: () => {
        const project = this.current();
        if (project !== null) this.newSession(project.id);
        else void this.addProject();
      },
      destroyRef,
    });
    this.keymap.register({
      binding: { mod: true, key: 'k' },
      when: () => this.current() !== null,
      run: () => this.focusSearch(),
      destroyRef,
    });
    this.keymap.register({
      binding: { mod: true, key: 'p' },
      when: () => this.current() !== null,
      run: () => this.switcherTrigger()?.nativeElement.click(),
      destroyRef,
    });

    this.keymap.register({
      binding: { mod: true, key: 'a' },
      when: () => this.isSidebarListFocused(),
      run: () => this.selectAllFocusedProject(),
      destroyRef,
    });

    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.renamingProject() !== null,
      run: () => this.cancelRename(true),
      destroyRef,
    });

    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.isSearchFocused(),
      run: () => this.leaveSearch(),
      destroyRef,
    });

    this.keymap.registerEscape({
      layer: 'selection',
      when: () => this.selectedIds().size > 0,
      run: () => this.clearSelection(),
      destroyRef,
    });
  }

  private isSearchFocused(): boolean {
    const input = this.sessionSearchInput()?.nativeElement;
    return input !== undefined && this.document.activeElement === input;
  }

  private isSidebarListFocused(): boolean {
    const active = this.document.activeElement;
    if (!(active instanceof HTMLElement) || isTextInputTarget(active)) return false;
    return active.closest('app-session-list') !== null;
  }

  private selectAllFocusedProject(): void {
    const visible = this.visibleIds();
    if (visible.length === 0) return;
    this.selected.set(new Set(visible));
    this.anchorId = visible[0] ?? null;
  }

  /** Mod+K: focus the search field, selecting what is typed; a second press hands focus back. */
  private focusSearch(): void {
    const input = this.sessionSearchInput()?.nativeElement;
    if (input === undefined) return;
    if (this.document.activeElement === input) {
      this.leaveSearch();
      return;
    }
    input.focus();
    input.select();
  }

  /** Esc in the search field: clear it, then give focus back to the open Session's row. */
  private leaveSearch(): void {
    if (this.query() !== '') this.query.set('');
    else this.sessionSearchInput()?.nativeElement.blur();
  }

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected toggleSelect(id: SessionId, projectId: ProjectId): void {
    this.handleSelectionClick({ id, ctrlKey: true, metaKey: false, shiftKey: false }, projectId);
  }

  protected extendSelection(
    range: { readonly from: SessionId; readonly to: SessionId },
    projectId: ProjectId,
  ): void {
    const selected = this.selectedIds();
    const currentProject = this.selectionProject(selected);
    const sameProject = currentProject === null || currentProject === projectId;
    const visible = this.visibleIds();
    if (
      !sameProject ||
      selected.size === 0 ||
      this.anchorId === null ||
      !visible.includes(this.anchorId)
    ) {
      this.anchorId = range.from;
    }
    const a = visible.indexOf(this.anchorId);
    const b = visible.indexOf(range.to);
    if (a !== -1 && b !== -1) {
      const [start, end] = a <= b ? [a, b] : [b, a];
      this.selected.set(new Set(visible.slice(start, end + 1)));
    }
  }

  protected archiveFromDelete(row: SessionRow): void {
    const selected = this.selectedIds();
    const loaded = this.loadedSessionsMap();
    if (selected.size > 0 && row.selected) {
      const targets: SessionTarget[] = [];
      for (const id of selected) {
        const entry = loaded.get(id);
        if (entry !== undefined && entry.session.archivedAt === undefined) {
          targets.push({ id, title: sessionTitle(entry.session.title) });
        }
      }
      if (targets.length === 0) return;
      this.clearSelection();
      void this.sessionsState.archive(targets);
      return;
    }
    if (row.archived) return;
    this.clearSelection();
    void this.sessionsState.archive([{ id: row.id, title: row.title }]);
  }

  protected onRowClick(event: RowClickEvent): void {
    if (this.handleSelectionClick(event, this.current()?.id ?? null)) return;
    this.openSession(event.id);
  }

  private handleSelectionClick(event: RowClickEvent, projectId: ProjectId | null): boolean {
    const selected = this.selectedIds();
    const currentProject = this.selectionProject(selected);
    const sameProject = currentProject === null || currentProject === projectId;
    if (event.shiftKey) {
      const visible = this.visibleIds();
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

  protected newSession(projectId: ProjectId): void {
    this.tabs.startDraft(projectId, this.projects.deviceOf(projectId));
  }

  private toOpenSession(id: SessionId): OpenSession | null {
    const entry = this.loadedSessionsMap().get(id);
    if (entry === undefined) return null;
    const device = this.projects.deviceOf(entry.projectId);
    return {
      id,
      ...(device === undefined ? {} : { device }),
      projectId: entry.projectId,
      title: titleOf(entry.session.title),
      ...(entry.session.attention === undefined ? {} : { attention: entry.session.attention }),
      ...(entry.session.running === true ? { running: true } : {}),
    };
  }

  protected openSession(id: SessionId): void {
    const session = this.toOpenSession(id);
    if (session !== null) this.tabs.open(session);
  }

  protected openSessionInSplit(id: SessionId): void {
    const session = this.toOpenSession(id);
    if (session !== null) this.tabs.openSessionInSplit(session);
  }

  protected openSessionInStack(id: SessionId): void {
    const session = this.toOpenSession(id);
    if (session !== null) this.tabs.openSessionInStack(session);
  }

  protected async renameSession(id: SessionId, title: string): Promise<void> {
    if (await this.sessionsState.rename(id, title)) {
      const ids = this.loadIds();
      if (ids.length > 0) void this.refreshProjects(ids);
    }
  }

  /** Follows the Session changes of the Local device and of every connected Remote device. */
  private async subscribeChanges(): Promise<void> {
    this.devices.forEachOnline((device, signal) => {
      void this.followChanges(device, signal);
    }, this.injector);
    await this.followChanges(undefined, this.aborts.signal);
  }

  private async followChanges(device: DeviceId | undefined, signal: AbortSignal): Promise<void> {
    await this.runtime.run(
      Stream.unwrap(sessionChanges).pipe(
        Stream.runForEach((change) =>
          Effect.sync(() => {
            this.applyChange(change);
          }),
        ),
        onDevice(device),
        Effect.retry(Schedule.spaced('500 millis')),
      ),
      { signal },
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
    this.sessionsState.remember(nextRaw, change.projectId);
    this.refreshedSessions.update((current) => {
      const next = new Map(current);
      next.set(change.projectId, { status: 'loaded', raw: nextRaw });
      return next;
    });
  }

  private async refreshProjects(projectIds: ReadonlyArray<ProjectId>): Promise<void> {
    const exit = await this.runtime.run(
      listAllSessions(projectIds, (id) => this.projects.deviceOf(id)),
      {
        signal: this.aborts.signal,
      },
    );
    if (this.aborts.signal.aborted || exit._tag !== 'Success') return;
    this.refreshedSessions.update((current) => {
      const next = new Map(current);
      for (const [projectId, projectExit] of exit.value) {
        if (projectExit._tag === 'Success') {
          this.sessionsState.remember(projectExit.value, projectId);
          next.set(projectId, { status: 'loaded', raw: projectExit.value });
        }
      }
      return next;
    });
  }

  private targetsForRow(row: SessionRow): ReadonlyArray<SessionTarget> {
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

  protected cancelRename(restoreFocus = false): void {
    this.renamingDone = true;
    this.renamingProject.set(null);
    if (restoreFocus) this.pendingSwitcherFocus.set(true);
  }

  protected async commitRename(project: Project, restoreFocus = false): Promise<void> {
    if (this.renamingDone || this.renamingProject() !== project.id) return;
    this.renamingDone = true;
    const next = this.renameDraft();
    this.renamingProject.set(null);
    if (restoreFocus) this.pendingSwitcherFocus.set(true);
    await this.projects.rename(project.id, next);
  }

  protected removeProject(project: Project): void {
    const ids = this.rawForProject(project.id).map((s) => s.id);
    void this.sessionsState.removeProject(project, ids);
  }

  protected pick(id: ProjectId): void {
    this.tabs.switchProject(id);
    this.query.set('');
  }

  protected async addProject(device?: DeviceId): Promise<void> {
    const project = await this.projects.add(device);
    if (project !== null) this.pick(project.id);
  }
}
