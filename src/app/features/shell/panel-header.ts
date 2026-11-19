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
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { HlmTooltipImports } from '@ui/tooltip';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { PaneId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { ChangesState } from '../../core/changes-view';
import { Keymap } from '../../core/keymap';
import { PanelRegistry, type PanelHeaderMeta } from '../../core/panel-registry';
import { SessionToolbar } from '../../core/session-toolbar';
import { Tabs, titleOf } from '../../core/tabs';
import { SessionsState, type SessionTarget } from './sessions-state';
import { wireEditorFocus } from './sidebar-keys';

/**
 * Compact 36px per-Panel header: Panel title (with inline Session rename), Worker parent link & status,
 * temporary Changes launcher, `⋯` Session actions menu (context, Compact, Clear, Switch Agent, Rename,
 * Archive, Delete), and a Close Panel control.
 */
@Component({
  selector: 'app-panel-header',
  imports: [AgentTile, HlmDropdownMenuImports, HlmKbdImports, HlmTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block shrink-0' },
  template: `
    <header
      class="border-border/60 flex h-9 min-w-0 items-center gap-1.5 border-b px-3 transition-colors"
      [class]="focused() ? 'bg-background' : 'bg-muted/20'"
      data-testid="panel-header"
    >
      @if (worker(); as crumb) {
        <button
          type="button"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring -ms-1.5 flex h-7 max-w-48 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none focus-visible:ring-2"
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
          <span class="truncate" data-testid="worker-parent-title">{{ parentTitle() }}</span>
        </button>
        <span aria-hidden="true" class="text-muted-foreground/60 shrink-0 text-xs select-none"
          >/</span
        >
      }

      @if (renaming()) {
        <input
          #titleEditor
          data-testid="panel-rename"
          class="bg-background border-input focus-visible:ring-ring h-7 min-w-0 flex-1 rounded-md border px-2 text-sm font-medium outline-none focus-visible:ring-2"
          [value]="rawSessionTitle() ?? ''"
          aria-label="Session title"
          i18n-aria-label
          (keydown.enter)="$event.preventDefault(); saveRename(titleEditor.value, true)"
          (blur)="saveRename(titleEditor.value, false)"
        />
      } @else {
        <span
          class="min-w-0 truncate text-sm font-medium"
          [class.flex-1]="worker() === null"
          [class.text-muted-foreground]="untitled()"
          data-testid="panel-title"
          (dblclick)="startRename()"
          >{{ title() }}</span
        >
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

      @if (changesSessionId() !== null && !changes.open()) {
        <button
          type="button"
          data-testid="open-changes"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs outline-none focus-visible:ring-2"
          (click)="openChanges()"
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
      }

      @if (paneId() !== null) {
        <button
          type="button"
          data-testid="panel-split-trigger"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
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

      @if (hasMenu()) {
        <button
          #actionsTrigger
          type="button"
          data-testid="session-actions-trigger"
          class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
          aria-label="Session actions"
          i18n-aria-label
          aria-haspopup="menu"
          [hlmTooltip]="actionsTip"
          [hlmDropdownMenuTrigger]="actionsMenu"
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
            <circle cx="5" cy="12" r="1" />
            <circle cx="12" cy="12" r="1" />
            <circle cx="19" cy="12" r="1" />
          </svg>
        </button>
      }

      <button
        type="button"
        data-testid="panel-close"
        aria-label="Close Panel"
        i18n-aria-label
        class="hover:bg-accent text-muted-foreground hover:text-foreground focus-visible:ring-ring flex size-7 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2"
        (mousedown)="$event.stopPropagation()"
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

    <ng-template #actionsMenu>
      <hlm-dropdown-menu class="w-72 rounded-xl" data-testid="session-actions-menu">
        @if (toolbarEntry(); as entry) {
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
        @if (keptSessionId() !== null) {
          @if (toolbarEntry()) {
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
export class PanelHeader {
  readonly panel = input.required<WorkspacePanel>();
  readonly paneId = input<PaneId | null>(null);
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
  readonly canSplit = input(true);

  protected readonly keymap = inject(Keymap);
  protected readonly changes = inject(ChangesState);
  private readonly toolbar = inject(SessionToolbar);
  private readonly registry = inject(PanelRegistry);
  private readonly tabs = inject(Tabs);
  private readonly sessionsState = inject(SessionsState);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly renaming = signal(false);
  private readonly titleEditor = viewChild<ElementRef<HTMLInputElement>>('titleEditor');
  private readonly actionsTrigger = viewChild<ElementRef<HTMLButtonElement>>('actionsTrigger');

  private readonly isSessionPanel = computed(() => this.panel().spec._tag === 'Session');

  /** Kept SessionId (`null` for drafts and non-Session Panels): eligible for Rename, Archive, and Delete. */
  protected readonly keptSessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    if (spec._tag !== 'Session' || spec.draft === true || spec.sessionId === undefined) return null;
    return spec.sessionId;
  });

  /** Live SessionId (including drafts once main started them): binds SessionToolbar and temporary Changes. */
  private readonly liveSessionId = computed((): SessionId | null => {
    const spec = this.panel().spec;
    return spec._tag === 'Session' ? (spec.sessionId ?? null) : null;
  });

  protected readonly changesSessionId = computed((): SessionId | null => this.liveSessionId());

  protected readonly toolbarEntry = computed(() => this.toolbar.entryFor(this.liveSessionId()));

  protected readonly worker = computed(() => this.toolbarEntry()?.worker?.() ?? null);

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

  /** A draft has no kept Session to rename or archive, but its live Session still has context actions. */
  protected readonly hasMenu = computed(
    () => this.isSessionPanel() && (this.keptSessionId() !== null || this.toolbarEntry() !== null),
  );

  protected readonly archived = computed(() => {
    const id = this.keptSessionId();
    return id !== null && this.sessionsState.isArchived(id);
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
    this.keymap.register({
      binding: { mod: true, shift: true, key: 'k' },
      when: () => this.focused() && this.hasMenu() && !this.keymap.modalOpen(),
      run: () => {
        this.actionsTrigger()?.nativeElement.click();
        return true;
      },
      destroyRef: this.destroyRef,
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

  protected openChanges(): void {
    this.tabs.focusPanel(this.panel().id);
    this.changes.show();
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
    const id = this.keptSessionId();
    return id === null ? null : { id, title: this.title() };
  }
}
