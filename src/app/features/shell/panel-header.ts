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
import { ActivityMark } from '@ui/activity-mark';
import { AgentTile } from '@ui/agent-tile';
import { HlmBadgeImports } from '@ui/badge';
import { HlmButtonImports } from '@ui/button';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmInputImports } from '@ui/input';
import { HlmTooltipImports } from '@ui/tooltip';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { PaneId, TabId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { Keymap } from '../../core/keymap';
import { PanelRegistry, type PanelHeaderMeta } from '../../core/panel-registry';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs, titleOf } from '../../core/tabs';
import { PanelSessionActions } from './panel-session-actions';
import { PanelSessionPicker } from './panel-session-picker';
import { SessionsState } from './sessions-state';
import { wireEditorFocus } from './sidebar-keys';
import { WorkspaceDragService } from './workspace-drag';

const INTERACTIVE_DRAG_IGNORE = 'button, input, a, select, [role="combobox"], [role="menuitem"]';

/**
 * Compact 36px per-Panel header: Panel title (with inline Session rename), Worker parent link & status,
 * Session `Changes` & `Workers` launchers, bound Session display + re-bind picker for `Changes`/`Workers`
 * Panels, `⋯` Session actions menu, and a Close Panel control.
 */
@Component({
  selector: 'app-panel-header',
  imports: [
    ActivityMark,
    AgentTile,
    HlmBadgeImports,
    HlmButtonImports,
    HlmDropdownMenuImports,
    HlmInputImports,
    HlmTooltipImports,
    PanelSessionActions,
    PanelSessionPicker,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <header
      class="border-border/60 flex h-9 min-w-0 items-center gap-1.5 border-b px-3 transition-colors"
      [class]="headerClasses()"
      data-testid="panel-header"
      [attr.data-dragging]="dragging() ? 'true' : null"
      (pointerdown)="onHeaderPointerDown($event)"
    >
      @if (stacked()) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="panel-collapse-toggle"
          class="text-muted-foreground -ms-1.5"
          [attr.aria-expanded]="!panel().collapsed"
          [attr.aria-label]="panel().collapsed ? expandPanelLabel : collapsePanelLabel"
          [disabled]="!panel().collapsed && !canCollapse()"
          (mousedown)="$event.stopPropagation()"
          (focusin)="$event.stopPropagation()"
          (click)="toggleCollapsed($event)"
        >
          <svg
            aria-hidden="true"
            class="size-3.5 shrink-0 transition-transform"
            [class.rotate-90]="!panel().collapsed"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      }

      @if (worker(); as crumb) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          data-testid="worker-parent"
          class="text-muted-foreground -ms-1.5 max-w-48 px-1.5 font-normal"
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
          <span class="truncate" data-testid="worker-parent-title">{{ parentTitle() }}</span>
        </button>
        <span aria-hidden="true" class="text-muted-foreground/60 shrink-0 text-xs select-none"
          >/</span
        >
      }

      @if (collapsedActivity(); as activity) {
        <span data-testid="panel-activity-indicator" class="shrink-0">
          <app-activity-mark [kind]="activity" />
        </span>
      }

      @if (renaming()) {
        <input
          #titleEditor
          hlmInput
          data-testid="panel-rename"
          class="bg-background h-7 min-w-0 flex-1 text-sm font-medium md:text-sm"
          [value]="rawSessionTitle() ?? ''"
          aria-label="Session title"
          i18n-aria-label
          (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
          (blur)="saveRename(titleEditor.value, false)"
        />
      } @else {
        <span
          class="min-w-0 truncate text-sm font-medium"
          [class.flex-1]="worker() === null && boundSessionId() === null"
          [class.text-muted-foreground]="untitled()"
          data-testid="panel-title"
          (dblclick)="startRename()"
          >{{ title() }}</span
        >
      }

      @if (boundSessionId(); as boundId) {
        <app-panel-session-picker
          [panelId]="panel().id"
          [projectId]="projectId()"
          [boundSessionId]="boundId"
        />
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

      @if (liveSessionId(); as sid) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          data-testid="open-changes"
          class="text-muted-foreground gap-1.5 font-normal"
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
          <span i18n>Changes</span>
        </button>
        <button
          hlmBtn
          type="button"
          variant="ghost"
          data-testid="open-workers"
          class="text-muted-foreground gap-1.5 font-normal"
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
          <span i18n>Workers</span>
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
      }

      @if (paneId() !== null) {
        <button
          hlmBtn
          type="button"
          variant="ghost"
          size="icon"
          data-testid="panel-split-trigger"
          class="text-muted-foreground"
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
        [paneId]="paneId()"
        [keptSessionId]="keptSessionId()"
        [liveSessionId]="liveSessionId()"
        [focused]="focused()"
        [title]="title()"
        (startRename)="startRename()"
      />

      <button
        hlmBtn
        type="button"
        variant="ghost"
        size="icon"
        data-testid="panel-close"
        aria-label="Close Panel"
        i18n-aria-label
        class="text-muted-foreground"
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
  readonly stacked = input(false);
  readonly canCollapse = input(false);

  protected readonly collapsePanelLabel = $localize`Collapse Panel`;
  protected readonly expandPanelLabel = $localize`Expand Panel`;

  private readonly keymap = inject(Keymap);
  private readonly toolbar = inject(SessionToolbar);
  private readonly registry = inject(PanelRegistry);
  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);
  private readonly drag = inject(WorkspaceDragService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renaming = signal(false);
  protected readonly dragging = computed(() => this.drag.draggingPanelId() === this.panel().id);
  protected readonly headerClasses = computed(() => {
    const base = this.focused() ? 'bg-background' : 'bg-muted/20';
    const dragTone = this.dragging() ? ' opacity-60 cursor-grabbing' : '';
    const select = this.renaming() ? '' : ' select-none';
    return `${base}${dragTone}${select}`;
  });
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');
  private readonly actionsMenu = viewChild(PanelSessionActions);

  protected readonly isSessionPanel = computed(() => this.panel().spec._tag === 'Session');

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

  /** Pinned SessionId for `Changes` and `Workers` Panels. */
  protected readonly boundSessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    return spec._tag === 'Changes' || spec._tag === 'Workers' ? spec.sessionId : null;
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
  protected readonly collapsedActivity = computed(() =>
    this.panel().collapsed ? this.tabs.panelActivity(this.panel()) : null,
  );

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

  protected openSession(id: SessionId): void {
    const live = this.tabs.liveState(id);
    const known = live === undefined ? null : titleOf(live.title);
    this.tabs.open({
      id,
      projectId: this.projectId(),
      title: known ?? this.sessionsState.titleFor(id, this.parentTitle()),
    });
  }

  protected openChanges(sessionId: SessionId): void {
    this.tabs.openChangesPanel(sessionId, this.paneId() ?? undefined, this.projectId());
  }

  protected openWorkers(sessionId: SessionId): void {
    this.tabs.openWorkersPanel(sessionId, this.paneId() ?? undefined, this.projectId());
  }

  protected split(side: 'right' | 'bottom'): void {
    const paneId = this.paneId();
    if (paneId === null || !this.canSplit()) return;
    this.tabs.splitPane(paneId, side);
  }

  protected toggleCollapsed(event: MouseEvent): void {
    event.stopPropagation();
    this.tabs.togglePanelCollapsed(this.panel().id);
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
