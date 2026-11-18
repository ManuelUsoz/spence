import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmBreadcrumbImports } from '@ui/breadcrumb';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmSidebarImports } from '@ui/sidebar';
import { HlmTooltipImports } from '@ui/tooltip';
import { ChangesState, changesSessionOf } from '../../core/changes-view';
import { Keymap } from '../../core/keymap';
import { RemoteDevices } from '../../core/remote-devices';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs, titleOf } from '../../core/tabs';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { Project } from '../../../shared/projects/projects.rpc';
import { ProjectsState } from './projects-state';
import { SessionsState, type SessionTarget } from './sessions-state';
import { SettingsState } from './settings-state';
import { wireEditorFocus } from './sidebar-keys';

/**
 * The 48px bar above the open Session: the sidebar trigger, a Project / Session breadcrumb (the title renamed in place) and the ⋯
 * Session actions menu: context use, compact, clear, switch Agent or Model, rename, archive and delete.
 * Fork is not here; it belongs to a Turn.
 */
@Component({
  selector: 'app-top-bar',
  imports: [
    AgentTile,
    HlmBreadcrumbImports,
    HlmSidebarImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    HlmTooltipImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <header class="border-border/60 flex h-12 min-w-0 items-center gap-2 border-b px-3">
      <button hlmSidebarTrigger srOnlyText="Toggle sidebar" i18n-srOnlyText></button>
      @if (settings.open()) {
        <nav hlmBreadcrumb aria-label="Breadcrumb" class="min-w-0 flex-1">
          <ol hlmBreadcrumbList class="flex-nowrap text-sm">
            @if (tab() === null) {
              <li hlmBreadcrumbItem class="min-w-0">
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-2 h-7 max-w-64 truncate rounded-lg px-2 outline-none focus-visible:ring-2"
                  data-testid="settings-back"
                  (click)="settings.set(false)"
                >
                  {{ project()?.name ?? 'Spence' }}
                </button>
              </li>
              <li hlmBreadcrumbSeparator></li>
            } @else {
              @if (project(); as current) {
                <li hlmBreadcrumbItem class="min-w-0">
                  <span class="max-w-48 truncate" data-testid="topbar-project">{{
                    current.name
                  }}</span>
                </li>
                <li hlmBreadcrumbSeparator></li>
              }
            }
            @if (tab(); as active) {
              <li hlmBreadcrumbItem class="min-w-0">
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-2 h-7 max-w-64 truncate rounded-lg px-2 outline-none focus-visible:ring-2"
                  data-testid="settings-back"
                  (click)="settings.set(false)"
                >
                  {{ title() }}
                </button>
              </li>
              <li hlmBreadcrumbSeparator></li>
            }
            <li hlmBreadcrumbItem>
              <h1 hlmBreadcrumbPage class="font-medium" data-testid="topbar-title" i18n>
                Settings
              </h1>
            </li>
          </ol>
        </nav>
        <span class="text-muted-foreground hidden shrink-0 text-xs sm:inline" i18n
          >Changes apply at once</span
        >
      } @else if (tab(); as active) {
        <nav
          hlmBreadcrumb
          aria-label="Breadcrumb"
          class="min-w-0"
          [class.flex-1]="worker() === null"
        >
          <ol hlmBreadcrumbList class="flex-nowrap text-sm">
            @if (worker(); as crumb) {
              <li hlmBreadcrumbItem class="shrink-0">
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-2 flex h-7 max-w-64 items-center gap-1.5 rounded-lg px-2 outline-none focus-visible:ring-2"
                  data-testid="worker-parent"
                  title="Back to the parent Session"
                  i18n-title
                  (click)="openSession(crumb.parentId)"
                >
                  <svg
                    aria-hidden="true"
                    class="size-[13px] shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                  <span class="truncate" data-testid="worker-parent-title">{{
                    parentTitle()
                  }}</span>
                </button>
              </li>
              <li hlmBreadcrumbSeparator></li>
            } @else if (project(); as current) {
              <li hlmBreadcrumbItem class="shrink-0">
                <span class="max-w-48 truncate" data-testid="topbar-project">{{
                  current.name
                }}</span>
              </li>
              <li hlmBreadcrumbSeparator></li>
            }
            @if (showingChanges()) {
              <li hlmBreadcrumbItem class="min-w-0">
                <button
                  type="button"
                  class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -mx-2 h-7 max-w-64 truncate rounded-lg px-2 outline-none focus-visible:ring-2"
                  data-testid="changes-back"
                  (click)="changes.set(false)"
                >
                  {{ title() }}
                </button>
              </li>
              <li hlmBreadcrumbSeparator></li>
              <li hlmBreadcrumbItem>
                <h1 hlmBreadcrumbPage class="font-medium" data-testid="topbar-title" i18n>
                  Changes
                </h1>
              </li>
            } @else {
              <li hlmBreadcrumbItem class="min-w-0 flex-1">
                @if (renaming()) {
                  <input
                    #titleEditor
                    data-testid="topbar-rename"
                    class="bg-background border-input focus-visible:ring-ring h-8 min-w-0 flex-1 rounded-lg border px-2.5 text-sm font-medium outline-none focus-visible:ring-2"
                    [value]="active.title ?? ''"
                    aria-label="Session title"
                    i18n-aria-label
                    (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
                    (blur)="saveRename(titleEditor.value, false)"
                  />
                } @else {
                  <h1
                    hlmBreadcrumbPage
                    class="min-w-0 truncate font-medium"
                    [class.text-muted-foreground]="active.title === null"
                    data-testid="topbar-title"
                  >
                    {{ title() }}
                  </h1>
                }
              </li>
            }
          </ol>
        </nav>
        @if (deviceName(); as device) {
          <span
            class="border-border text-muted-foreground flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs"
            data-testid="device-chip"
            title="This Session runs on {{ device }}"
            i18n-title
          >
            <span aria-hidden="true" class="bg-online size-1.5 shrink-0 rounded-full"></span>
            <span class="truncate">{{ device }}</span>
          </span>
        }
        @if (worker(); as crumb) {
          <span
            class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap"
            data-testid="worker-kind"
          >
            <app-agent-tile [agentId]="crumb.agentId" [name]="crumb.agentName" size="sm" />
            @if (crumb.modelName ?? crumb.agentName; as model) {
              <span i18n>Worker · {{ model }}</span>
            }
          </span>
          @if (crumb.working) {
            <span
              class="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
              data-testid="worker-working"
            >
              <span
                aria-hidden="true"
                class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
              ></span>
              <span i18n>Working</span>
            </span>
          }
          @if (crumb.waitingAncestorId; as waitingId) {
            <button
              type="button"
              class="focus-visible:ring-ring flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--attention)_16%,transparent)] px-2.5 text-xs text-[var(--attention)] outline-none focus-visible:ring-2"
              data-testid="parent-needs-you"
              (click)="openSession(waitingId)"
            >
              <span aria-hidden="true" class="size-1.5 rounded-full bg-[var(--attention)]"></span>
              <span i18n>Parent needs you</span>
            </button>
          }
          <div class="flex-1"></div>
        }
        @if (changesSession() !== null && !showingChanges()) {
          <button
            type="button"
            data-testid="open-changes"
            class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm outline-none focus-visible:ring-2"
            (click)="changes.show()"
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
              <circle cx="6" cy="6" r="2" />
              <circle cx="6" cy="18" r="2" />
              <path d="M6 8v8" />
              <path d="M13 6h3a2 2 0 0 1 2 2v7" />
              <path d="m15 8-2-2 2-2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
            <span i18n>Changes</span>
          </button>
        }
        @if (hasMenu()) {
          <button
            #actionsTrigger
            type="button"
            data-testid="session-actions-trigger"
            class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-8 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
            aria-label="Session actions"
            i18n-aria-label
            aria-haspopup="menu"
            [hlmTooltip]="actionsTip"
            [hlmDropdownMenuTrigger]="actionsMenu"
          >
            <svg
              class="size-[18px]"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="5" cy="12" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
            </svg>
          </button>
        }
      } @else {
        <div class="flex-1"></div>
      }
    </header>

    <ng-template #actionsMenu>
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="session-actions-menu">
        @if (toolbar.entry(); as entry) {
          @let context = entry.context();
          <div class="flex flex-col gap-1.5 px-2.5 pt-1.5 pb-2" data-testid="session-context">
            <div class="text-muted-foreground flex justify-between text-xs tabular-nums">
              <span i18n>Context</span>
              <span data-testid="session-context-label">{{ context.label }}</span>
            </div>
            @if (context.fraction !== null) {
              <div class="bg-accent h-1 overflow-hidden rounded-full" aria-hidden="true">
                <div
                  class="bg-muted-foreground h-full rounded-full"
                  [style.width.%]="context.fraction * 100"
                ></div>
              </div>
            }
          </div>
          @for (action of entry.actions(); track action.id) {
            <button
              type="button"
              hlmDropdownMenuItem
              class="h-auto min-h-8 py-1.5"
              [disabled]="action.disabled"
              [attr.data-testid]="'session-action-' + action.id"
              (triggered)="entry.run(action.operation)"
            >
              <span class="flex min-w-0 flex-1 flex-col text-left">
                <span>{{ action.label }}</span>
                @if (action.disabled && action.reason; as reason) {
                  <span
                    class="text-muted-foreground text-xs leading-4 font-normal"
                    data-testid="session-action-reason"
                    >{{ reason }}</span
                  >
                }
              </span>
              @if (action.command; as command) {
                <span class="text-muted-foreground font-mono text-xs">{{ command }}</span>
              }
            </button>
          }
        }
        @if (sessionId() !== null) {
          @if (toolbar.entry()) {
            <hlm-dropdown-menu-separator />
          }
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-rename"
            (triggered)="startRename()"
            i18n
          >
            Rename
          </button>
          @if (archived()) {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-unarchive"
              (triggered)="unarchive()"
              i18n
            >
              Unarchive
            </button>
          } @else {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-archive"
              (triggered)="archive()"
              i18n
            >
              Archive
            </button>
          }
          <button
            type="button"
            hlmDropdownMenuItem
            variant="destructive"
            data-testid="menu-delete"
            (triggered)="remove()"
            i18n
          >
            Delete…
          </button>
        }
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #actionsTip>
      <span class="inline-flex items-center gap-1.5">
        <span i18n>Session actions</span>
        <kbd hlmKbd class="font-mono font-normal">{{
          keymap.format({ mod: true, shift: true, key: 'k' })
        }}</kbd>
      </span>
    </ng-template>
  `,
})
export class TopBar {
  protected readonly keymap = inject(Keymap);
  protected readonly toolbar = inject(SessionToolbar);
  protected readonly settings = inject(SettingsState);
  protected readonly changes = inject(ChangesState);
  private readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);
  private readonly sessionsState = inject(SessionsState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renaming = signal(false);
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');
  private readonly actionsTrigger = viewChild<ElementRef<HTMLButtonElement>>('actionsTrigger');

  protected readonly tab = this.tabs.active;
  private readonly devices = inject(RemoteDevices);
  /** The Remote device the open Session runs on, by name; `null` for a Local Session. */
  protected readonly deviceName = computed((): string | null => {
    const device = this.tab()?.device;
    return device === undefined ? null : (this.devices.nameOf(device) ?? null);
  });
  /** The root crumb: the open Session's Project, else the last used one. */
  protected readonly project = computed((): Project | null => {
    const id = this.tab()?.projectId;
    return this.projects.ordered().find((p) => p.id === id) ?? this.projects.lastUsed();
  });
  protected readonly sessionId = computed(() => this.tab()?.session ?? null);
  /** Set while the open Session is a Worker: its Parent, Agent and state. */
  protected readonly worker = computed(() => this.toolbar.entry()?.worker?.() ?? null);
  protected readonly parentTitle = computed(() => {
    const id = this.worker()?.parentId;
    if (id === undefined) return '';
    const live = this.tabs.liveState(id);
    const known = live === undefined ? null : titleOf(live.title);
    return known ?? this.sessionsState.titleFor(id, $localize`Parent Session`);
  });
  protected readonly changesSession = computed(() => {
    const tab = this.tab();
    return tab === null ? null : changesSessionOf(tab);
  });
  /** Changes replaces the thread only for a Tab with a Session; the shell shows the same. */
  protected readonly showingChanges = computed(
    () => this.changes.open() && this.changesSession() !== null,
  );
  /** A draft has no kept Session to rename or archive, but its live Session still has context actions. */
  protected readonly hasMenu = computed(
    () => this.sessionId() !== null || this.toolbar.entry() !== null,
  );
  protected readonly title = computed(() => this.tab()?.title ?? $localize`New Session`);
  protected readonly archived = computed(() => {
    const id = this.sessionId();
    return id !== null && this.sessionsState.isArchived(id);
  });

  constructor() {
    wireEditorFocus(this.titleEditor);
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.renaming(),
      run: () => this.renaming.set(false),
      destroyRef: this.destroyRef,
    });
    this.keymap.register({
      binding: { mod: true, shift: true, key: 'k' },
      when: () => this.hasMenu() && !this.keymap.modalOpen(),
      run: () => {
        this.actionsTrigger()?.nativeElement.click();
        return true;
      },
      destroyRef: this.destroyRef,
    });
  }

  /** Opens a Session of the open Worker's lineage in a Tab, in the Project of the open one. */
  protected openSession(id: string): void {
    const active = this.tab();
    if (active === null) return;
    const sessionId = id as SessionId;
    this.tabs.open({
      id: sessionId,
      projectId: active.projectId,
      title: this.sessionsState.titleFor(sessionId, this.parentTitle()),
    });
  }

  protected startRename(): void {
    if (this.sessionId() !== null) this.renaming.set(true);
  }

  protected saveRename(title: string, restoreFocus: boolean): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const id = this.sessionId();
    const active = this.tab();
    if (id === null || active === null) return;
    if (title.trim() !== (active.title ?? '')) void this.sessionsState.rename(id, title);
    if (restoreFocus) queueMicrotask(() => this.actionsTrigger()?.nativeElement.focus());
  }

  protected archive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.archive([target]);
  }

  protected unarchive(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.unarchive([target]);
  }

  protected remove(): void {
    const target = this.target();
    if (target !== null) void this.sessionsState.delete([target]);
  }

  private target(): SessionTarget | null {
    const id = this.sessionId();
    return id === null ? null : { id, title: this.title() };
  }
}
