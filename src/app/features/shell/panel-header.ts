import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { AgentTile } from '@ui/agent-tile';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmTooltipImports } from '@ui/tooltip';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { PaneId, TabId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { BrowserPaneState } from '../../core/browser-pane';
import { Keymap } from '../../core/keymap';
import { PanelRegistry, type PanelHeaderMeta } from '../../core/panel-registry';
import { RemoteDevices } from '../../core/remote-devices';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs, titleOf } from '../../core/tabs';
import { PanelSessionActions } from './panel-session-actions';
import { ProjectsState } from './projects-state';
import { SessionsState } from './sessions-state';
import { wireEditorFocus } from './sidebar-keys';
import { WorkspaceDragService } from './workspace-drag';

const INTERACTIVE_DRAG_IGNORE = 'button, input, a, select, [role="combobox"], [role="menuitem"]';

/**
 * Borderless floating per-Pane control row over the Session chat: hides duplicate Session titles
 * and `×` close on 1-Pane Tabs while keeping compact translucent action pills (`Changes`, `Workers`,
 * `Split`, `⋯`), and surfaces per-Pane title/drag handle + `×` whenever a Tab is split (2–4 Panes).
 */
@Component({
  selector: 'app-panel-header',
  imports: [
    AgentTile,
    HlmBadgeImports,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmTooltipImports,
    PanelSessionActions,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <header
      class="@container/panel-header flex h-10 min-w-0 items-center justify-between gap-2 px-3 transition-opacity"
      [class]="headerClasses()"
      data-testid="panel-header"
      [attr.data-dragging]="dragging() ? 'true' : null"
      (pointerdown)="onHeaderPointerDown($event)"
    >
      <div class="flex min-w-0 flex-1 items-center gap-1.5">
        @if (worker(); as crumb) {
          <div
            class="border-border/40 bg-background/70 pointer-events-auto flex h-7 max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-full border px-2 shadow-2xs backdrop-blur-md"
          >
            <button
              hlmBtn
              type="button"
              variant="ghost"
              size="sm"
              data-testid="worker-parent"
              class="text-muted-foreground -ms-1 h-6 min-w-7 max-w-44 shrink rounded-full px-1.5 font-normal"
              title="Back to the parent Session"
              i18n-title
              (click)="openSession(crumb.parentId, true)"
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
              <span class="min-w-0 truncate" data-testid="worker-parent-title">{{
                parentTitle()
              }}</span>
            </button>
            <span aria-hidden="true" class="text-muted-foreground/60 shrink-0 text-xs select-none"
              >/</span
            >
            @if (renaming()) {
              <input
                #titleEditor
                hlmInput
                data-testid="panel-rename"
                class="bg-background/90 h-5 min-w-28 flex-1 text-xs font-medium"
                [value]="rawSessionTitle() ?? ''"
                aria-label="Session title"
                i18n-aria-label
                (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
                (blur)="saveRename(titleEditor.value, false)"
              />
            } @else {
              <span
                class="min-w-0 truncate text-xs font-medium"
                [class.text-muted-foreground]="untitled()"
                data-testid="panel-title"
                (dblclick)="startRename()"
                >{{ title() }}</span
              >
            }
            <span
              class="text-muted-foreground flex shrink-0 items-center gap-1 text-xs whitespace-nowrap"
              data-testid="worker-kind"
            >
              <app-agent-tile [agentId]="crumb.agentId" [name]="crumb.agentName" size="sm" />
              @if (crumb.modelName ?? crumb.agentName; as model) {
                <span i18n>Worker · {{ model }}</span>
              }
            </span>
            @if (crumb.working) {
              <span
                class="text-muted-foreground flex shrink-0 items-center gap-1 text-xs"
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
                class="focus-visible:ring-ring flex h-5 shrink-0 items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,var(--attention)_16%,transparent)] px-2 text-xs text-[var(--attention)] outline-none focus-visible:ring-2"
                data-testid="parent-needs-you"
                (click)="openSession(waitingId)"
              >
                <span aria-hidden="true" class="size-1.5 rounded-full bg-[var(--attention)]"></span>
                <span i18n>Parent needs you</span>
              </button>
            }
          </div>
        } @else if (renaming()) {
          <input
            #titleEditor
            hlmInput
            data-testid="panel-rename"
            class="bg-background/90 pointer-events-auto h-7 max-w-64 min-w-0 flex-1 rounded-full px-3 text-xs font-medium backdrop-blur-md"
            [value]="rawSessionTitle() ?? ''"
            aria-label="Session title"
            i18n-aria-label
            (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
            (blur)="saveRename(titleEditor.value, false)"
          />
        } @else if (showVisibleTitle()) {
          <span
            class="border-border/40 bg-background/70 pointer-events-auto inline-flex h-7 max-w-64 min-w-0 items-center rounded-full border px-2.5 text-xs font-medium shadow-2xs backdrop-blur-md"
            [class.cursor-grab]="isSplit()"
          >
            <span
              class="min-w-0 truncate"
              [class.text-muted-foreground]="untitled()"
              data-testid="panel-title"
              (dblclick)="startRename()"
              >{{ title() }}</span
            >
          </span>
        } @else {
          <span
            class="sr-only"
            [class.text-muted-foreground]="untitled()"
            data-testid="panel-title"
            (dblclick)="startRename()"
            >{{ title() }}</span
          >
        }
      </div>

      <div
        class="border-border/40 bg-background/70 pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-full border p-0.5 shadow-2xs backdrop-blur-md"
      >
        @if (deviceName(); as device) {
          <span
            class="border-border/60 text-muted-foreground flex h-6 max-w-40 shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs"
            data-testid="device-chip"
            title="This Session runs on {{ device }}"
            i18n-title
          >
            <span
              aria-hidden="true"
              class="size-1.5 shrink-0 rounded-full"
              [class]="deviceOnline() ? 'bg-online' : 'bg-muted-foreground'"
            ></span>
            <span class="truncate">{{ device }}</span>
          </span>
        }

        @if (liveSessionId(); as sid) {
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            data-testid="open-changes"
            class="text-muted-foreground gap-1.5 rounded-full font-normal"
            (click)="openChanges(sid)"
          >
            <svg
              class="size-3.5"
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
            <span [class]="compactWorkerLabel()" i18n>Changes</span>
          </button>
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            data-testid="open-workers"
            class="text-muted-foreground gap-1.5 rounded-full font-normal"
            (click)="openWorkers(sid)"
          >
            <svg
              aria-hidden="true"
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 8V4H8" />
              <rect width="16" height="12" x="4" y="8" rx="2" />
              <path d="M2 14h2" />
              <path d="M20 14h2" />
              <path d="M15 13v2" />
              <path d="M9 13v2" />
            </svg>
            <span [class]="compactWorkerLabel()" i18n>Workers</span>
            @if (activeWorkerCount() > 0) {
              <span
                hlmBadge
                variant="secondary"
                class="h-4 min-w-4 px-1 text-[10px] tabular-nums"
                data-testid="open-workers-count"
                >{{ activeWorkerCount() }}</span
              >
            }
          </button>
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="sm"
            data-testid="toggle-browser"
            class="text-muted-foreground gap-1.5 rounded-full font-normal"
            [class.bg-accent]="browserOpen()"
            [class.text-foreground]="browserOpen()"
            [disabled]="browserRemote()"
            [attr.aria-pressed]="browserRemote() ? null : browserOpen()"
            [title]="browserTitle()"
            (click)="toggleBrowser(sid)"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M3.6 9h16.8" />
              <path d="M3.6 15h16.8" />
              <path d="M12 3a14.5 14.5 0 0 0 0 18" />
              <path d="M12 3a14.5 14.5 0 0 1 0 18" />
            </svg>
            <span [class]="compactWorkerLabel()" i18n>Browser</span>
          </button>
        }

        @if (paneId() !== null) {
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="panel-split-trigger"
            class="text-muted-foreground rounded-full"
            aria-label="Split Pane"
            i18n-aria-label
            aria-haspopup="menu"
            [hlmTooltip]="splitTip"
            [hlmDropdownMenuTrigger]="splitMenu"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="M12 3v18" />
            </svg>
          </button>
        }

        <app-panel-session-actions
          [isSessionPanel]="isSessionPanel()"
          [panel]="panel()"
          [projectId]="projectId()"
          [projectName]="projectName()"
          [keptSessionId]="keptSessionId()"
          [liveSessionId]="liveSessionId()"
          [focused]="focused()"
          [title]="title()"
          (startRename)="startRename()"
        />

        @if (showCloseButton()) {
          <button
            hlmBtn
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="panel-close"
            aria-label="Close Panel"
            i18n-aria-label
            class="text-muted-foreground rounded-full"
            (mousedown)="$event.stopPropagation()"
            (focusin)="$event.stopPropagation()"
            (click)="closePanel($event)"
          >
            <svg
              class="size-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        }
      </div>
    </header>

    <ng-template #splitMenu>
      <hlm-dropdown-menu class="w-52 rounded-xl" data-testid="panel-split-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          class="h-auto min-h-8 py-1.5"
          data-testid="panel-split-right"
          [disabled]="!canSplit()"
          (triggered)="split('right')"
        >
          <span class="flex min-w-0 flex-1 flex-col text-left">
            <span i18n>Split right</span>
            @if (!canSplit()) {
              <span
                class="text-muted-foreground text-xs leading-4 font-normal"
                data-testid="panel-split-reason"
                i18n
                >Up to 4 Panes per Tab</span
              >
            }
          </span>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          class="h-auto min-h-8 py-1.5"
          data-testid="panel-split-down"
          [disabled]="!canSplit()"
          (triggered)="split('bottom')"
        >
          <span class="flex min-w-0 flex-1 flex-col text-left">
            <span i18n>Split down</span>
            @if (!canSplit()) {
              <span
                class="text-muted-foreground text-xs leading-4 font-normal"
                data-testid="panel-split-reason"
                i18n
                >Up to 4 Panes per Tab</span
              >
            }
          </span>
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #splitTip>
      <span i18n>Split Pane</span>
    </ng-template>
  `,
})
export class PanelHeader {
  readonly tabId = input<TabId | null>(null);
  readonly panel = input.required<WorkspacePanel>();
  readonly paneId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
  readonly canSplit = input(true);
  readonly isSplit = input(true);

  private readonly keymap = inject(Keymap);
  private readonly browser = inject(BrowserPaneState);
  private readonly toolbar = inject(SessionToolbar);
  private readonly registry = inject(PanelRegistry);
  private readonly tabs = inject(Tabs);
  private readonly projects = inject(ProjectsState);
  private readonly devices = inject(RemoteDevices);
  private readonly sessionsState = inject(SessionsState);
  private readonly drag = inject(WorkspaceDragService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renaming = signal(false);
  protected readonly dragging = computed(() => this.drag.draggingPanelId() === this.panel().id);

  protected readonly isSessionPanel = computed(() => this.panel().spec._tag === 'Session');

  protected readonly hasDistinctTabTitle = computed((): boolean => {
    const tid = this.tabId();
    if (tid === null) return false;
    const tab = this.tabs.tabs().find((candidate) => candidate.id === tid);
    const custom = tab?.customTitle?.trim();
    return custom !== undefined && custom !== '' && custom !== this.title();
  });

  protected readonly showVisibleTitle = computed(
    () =>
      this.isSplit() ||
      !this.isSessionPanel() ||
      this.worker() !== null ||
      this.hasDistinctTabTitle(),
  );

  protected readonly showCloseButton = computed(() => this.isSplit() || !this.isSessionPanel());

  protected readonly headerClasses = computed(() => {
    const focusTone =
      !this.isSplit() || this.focused()
        ? ''
        : ' opacity-65 group-hover/pane:opacity-100 focus-within:opacity-100';
    const dragTone = this.dragging() ? ' opacity-60 cursor-grabbing' : '';
    const select = this.renaming() ? '' : ' select-none';
    return `${focusTone}${dragTone}${select}`;
  });
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');
  private readonly actionsMenu = viewChild(PanelSessionActions);

  private readonly device = computed(
    () => this.tabs.projectDevice(this.projectId()) ?? this.projects.deviceOf(this.projectId()),
  );
  /** The Remote device the Panel runs on, by name; `null` for a Local Session. */
  protected readonly deviceName = computed((): string | null => {
    const device = this.device();
    return device === undefined ? null : (this.devices.nameOf(device) ?? null);
  });
  /** Whether the Panel's Remote device is connected now; its chip dims while offline. */
  protected readonly deviceOnline = computed(() => {
    const device = this.device();
    return device !== undefined && this.devices.isOnline(device);
  });
  protected readonly browserRemote = computed(() => this.device() !== undefined);
  protected readonly browserOpen = computed(
    () => !this.browserRemote() && this.browser.isOpen(this.liveSessionId()),
  );
  protected readonly browserTitle = computed(() =>
    this.browserRemote()
      ? $localize`Browser is not available for remote Sessions`
      : $localize`Toggle Browser`,
  );

  /** Kept SessionId (`null` for drafts and non-Session Panels): eligible for Rename, Archive, and Delete. */
  protected readonly keptSessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    if (spec._tag !== 'Session' || spec.draft === true || spec.sessionId === undefined) return null;
    return spec.sessionId;
  });

  /** Live SessionId (including drafts once main started them): binds SessionToolbar and Changes/Workers launchers. */
  protected readonly liveSessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    return spec._tag === 'Session' ? (spec.sessionId ?? null) : null;
  });

  protected readonly activeWorkerCount = computed((): number => {
    const sid = this.liveSessionId();
    if (sid === null) return 0;
    return (this.tabs.liveState(sid)?.workers ?? []).filter(
      (worker) => worker.state === 'running' || worker.state === 'requiresAction',
    ).length;
  });

  protected readonly worker = computed(
    () => this.toolbar.entryFor(this.liveSessionId())?.worker?.() ?? null,
  );

  protected readonly compactWorkerLabel = computed(() =>
    this.worker() === null ? '' : '@max-[460px]/panel-header:sr-only',
  );

  protected readonly parentTitle = computed(() => {
    const id = this.worker()?.parentId;
    if (id === undefined) return '';
    const live = this.tabs.liveState(id);
    const known = live === undefined ? null : titleOf(live.title);
    return known ?? this.sessionsState.titleFor(id, $localize`Parent Session`);
  });

  private readonly headerMeta = computed((): PanelHeaderMeta => {
    const panel = this.panel();
    const def = this.registry.get(panel.spec._tag);
    if (def?.headerMeta !== undefined) {
      return def.headerMeta(
        {
          panel,
          projectId: this.projectId(),
          projectName: this.projectName(),
          focused: this.focused(),
        },
        (id) => this.tabs.sessionStatus(id)?.title ?? null,
      );
    }
    const fallback = this.tabs.panelTitle(panel);
    if (fallback !== null) return { title: fallback, untitled: false };
    if (panel.spec._tag === 'Session') return { title: $localize`New Session`, untitled: true };
    return { title: panel.spec._tag, untitled: false };
  });

  protected readonly title = computed(() => this.headerMeta().title);
  protected readonly untitled = computed(() => this.headerMeta().untitled === true);

  protected readonly rawSessionTitle = computed((): string | null => {
    const id = this.keptSessionId();
    return id === null ? null : (this.tabs.sessionStatus(id)?.title ?? null);
  });

  constructor() {
    wireEditorFocus(this.titleEditor);
    effect(() => {
      this.panel().id;
      this.keptSessionId();
      untracked(() => this.renaming.set(false));
    });
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.renaming(),
      run: () => this.renaming.set(false),
      destroyRef: this.destroyRef,
    });
  }

  protected onHeaderPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.renaming()) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_DRAG_IGNORE) !== null) {
      return;
    }
    const tabId = this.tabId();
    const paneId = this.paneId();
    if (tabId === null || paneId === null) return;
    this.drag.beginPanelDrag({
      pointerId: typeof event.pointerId === 'number' ? event.pointerId : null,
      clientX: event.clientX,
      clientY: event.clientY,
      tabId,
      paneId,
      panelId: this.panel().id,
    });
  }

  protected openSession(id: SessionId, fromWorker = false): void {
    const live = this.tabs.liveState(id);
    const known = live === undefined ? null : titleOf(live.title);
    const session = {
      id,
      projectId: this.projectId(),
      title: known ?? this.sessionsState.titleFor(id, this.parentTitle()),
    };
    if (fromWorker) this.tabs.returnToParent(session, this.panel().id);
    else this.tabs.open(session);
  }

  protected openChanges(sessionId: SessionId): void {
    this.tabs.openChangesPanel(sessionId, this.paneId() ?? undefined, this.projectId());
  }

  protected openWorkers(sessionId: SessionId): void {
    this.tabs.openWorkersPanel(sessionId, this.paneId() ?? undefined, this.projectId());
  }

  protected toggleBrowser(sessionId: SessionId): void {
    if (!this.browserRemote()) void this.browser.toggle(sessionId);
  }

  protected split(side: 'right' | 'bottom'): void {
    const paneId = this.paneId();
    if (paneId === null || !this.canSplit()) return;
    this.tabs.splitPane(paneId, side);
  }

  protected closePanel(event: MouseEvent): void {
    event.stopPropagation();
    this.tabs.closePanel(this.panel().id);
  }

  protected startRename(): void {
    if (this.keptSessionId() !== null) this.renaming.set(true);
  }

  protected saveRename(title: string, restoreFocus: boolean): void {
    if (!this.renaming()) return;
    this.renaming.set(false);
    const id = this.keptSessionId();
    if (id === null) return;
    if (title.trim() !== (this.rawSessionTitle() ?? '')) {
      void this.sessionsState.rename(id, title);
    }
    if (restoreFocus) queueMicrotask(() => this.actionsMenu()?.focusTrigger());
  }
}
