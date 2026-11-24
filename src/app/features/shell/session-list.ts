import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmTooltipImports } from '@ui/tooltip';
import type { LiveActivity, SessionId, SessionStatus } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';
import {
  ActivityTooltipContent,
  activityTooltipStatus,
  secondTicker,
  type ActivityTooltipStatus,
} from './activity-tooltip';
import { SessionContextMenu } from './session-context-menu';
import type { SessionGroup } from './session-groups';
import {
  createRovingFocus,
  wireEditorFocus,
  wirePendingFocus,
  type RovingItem,
} from './sidebar-keys';

/** One row: the title, a trailing age, and a second line only when the Session needs you. */
export interface SessionRow {
  readonly id: SessionId;
  readonly title: string;
  /** Short time since the last activity ("5m", "2h"). */
  readonly age: string;
  /** Why the Session needs you; shown as the second line. */
  readonly reason?: string;
  readonly active: boolean;
  readonly untitled?: boolean;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly canOpenInSplit?: boolean;
  readonly status: SessionStatus;
  readonly activity?: LiveActivity;
  readonly blockedTarget?: string;
  readonly errorSummary?: string;
  readonly workers?: ReadonlyArray<SidebarWorkerRow>;
  readonly workerActive?: boolean;
}

export interface SidebarWorkerRow {
  readonly id: SessionId;
  readonly ancestors: ReadonlyArray<SessionId>;
  readonly canOpenInSplit: boolean;
  readonly title: string;
  readonly status: string;
  readonly needsPermission: boolean;
  readonly running?: boolean;
  readonly activity?: LiveActivity;
  readonly blockedTarget?: string;
  readonly errorSummary?: string;
  readonly active: boolean;
  readonly workers: ReadonlyArray<SidebarWorkerRow>;
}

export interface RowClickEvent {
  readonly id: SessionId;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * A Project's Sessions as labelled groups of compact rows, a "Show more"
 * button when the list is capped, and a collapsed-by-default Archived fold at the bottom.
 */
@Component({
  selector: 'app-session-list',
  imports: [
    NgTemplateOutlet,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmTooltipImports,
    SessionContextMenu,
    ActivityMark,
    ActivityTooltipContent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col',
  },
  template: `
    @for (group of groups(); track group.label) {
      <div class="text-muted-foreground px-2 pt-3.5 pb-1 text-xs" data-testid="session-group">
        {{ group.label }}
      </div>
      @for (row of group.items; track row.id) {
        <ng-container *ngTemplateOutlet="sessionRow; context: { $implicit: row }" />
      }
    }

    @if (hiddenCount() > 0) {
      <button
        #rovingItem
        type="button"
        data-testid="show-more"
        data-roving-key="show-more"
        [attr.tabindex]="roving.tabIndex('show-more')"
        class="text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-ring mt-1 flex h-[30px] w-full items-center rounded-md px-2 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
        (focus)="roving.focusedKey.set('show-more')"
        (keydown)="onRovingKeydown($event, 'show-more')"
        (click)="showMore.emit()"
        i18n
      >
        Show {{ hiddenCount() }} more
      </button>
    }

    @if (archived().length > 0) {
      <div class="mt-2">
        <button
          #rovingItem
          type="button"
          data-testid="archived-fold"
          data-roving-key="archived-fold"
          [attr.tabindex]="roving.tabIndex('archived-fold')"
          class="text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
          [attr.aria-expanded]="archivedOpen()"
          [hlmContextMenuTrigger]="archivedFoldMenu"
          (focus)="roving.focusedKey.set('archived-fold')"
          (keydown)="onRovingKeydown($event, 'archived-fold')"
          (click)="toggleArchived.emit()"
        >
          <svg
            class="size-3.5 shrink-0 transition-transform"
            [class.rotate-90]="archivedOpen()"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="m9 18 6-6-6-6" />
          </svg>
          <span i18n
            >Archived (<span class="tabular-nums">{{ archived().length }}</span
            >)</span
          >
        </button>
        @if (archivedOpen()) {
          <div class="mt-0.5 flex flex-col" data-testid="archived-list">
            @for (row of archived(); track row.id) {
              <ng-container *ngTemplateOutlet="sessionRow; context: { $implicit: row }" />
            }
          </div>
        }
      </div>
    }

    <ng-template #sessionRow let-row>
      @if (editing() === row.id) {
        <input
          #editor
          data-testid="session-rename"
          class="bg-background w-full rounded-md px-2 py-1 text-sm"
          [value]="row.untitled ? '' : row.title"
          aria-label="Session title"
          i18n-aria-label
          (keydown.enter)="$event.preventDefault(); save(row, editor.value, true)"
          (blur)="save(row, editor.value, false)"
        />
      } @else {
        <ng-template #sessionTip>
          <app-activity-tooltip-content [title]="row.title" [status]="sessionTipStatus(row)" />
        </ng-template>
        <button
          #rovingItem
          #sessionRowBtn
          type="button"
          data-testid="session-row"
          [attr.data-roving-key]="row.id"
          [attr.tabindex]="roving.tabIndex(row.id)"
          [attr.data-archived]="row.archived ? 'true' : null"
          [attr.data-session-id]="row.id"
          [attr.aria-current]="row.active && !row.workerActive ? 'page' : null"
          [attr.aria-selected]="row.selected"
          [attr.data-selected]="row.selected ? 'true' : null"
          [class]="rowClasses(row)"
          [hlmTooltip]="sessionTip"
          position="right"
          [hlmContextMenuTrigger]="sessionMenu"
          [hlmContextMenuTriggerData]="{ $implicit: row.id }"
          (focus)="roving.focusedKey.set(row.id)"
          (keydown)="onRovingKeydown($event, row.id, row)"
          (click)="onRowClick(row.id, $event)"
          (dblclick)="startRename(row.id)"
        >
          <span class="flex w-full items-center gap-2">
            @if (!row.archived && (row.status === 'blocked' || row.status === 'error')) {
              <app-activity-mark [kind]="row.status" />
            }
            <span class="flex min-w-0 flex-1 flex-col">
              <span
                class="truncate"
                [class.text-muted-foreground]="row.archived || row.untitled"
                data-testid="session-title"
                >{{ row.title }}</span
              >
              @if (row.reason; as reason) {
                <span
                  class="truncate text-xs leading-4"
                  [class]="
                    row.status === 'error' ? 'text-[var(--destructive)]' : 'text-[var(--attention)]'
                  "
                  data-testid="session-meta"
                  >{{ reason }}</span
                >
              }
            </span>
            @if (!row.archived && row.status === 'working') {
              <app-activity-mark kind="working" />
            } @else if (row.archived || row.status === 'idle') {
              <span class="text-muted-foreground text-xs tabular-nums" data-testid="session-age">{{
                row.age
              }}</span>
            }
          </span>
        </button>
      }
      <ng-container *ngTemplateOutlet="workerRows; context: { $implicit: row.workers }" />
    </ng-template>

    <ng-template #workerRows let-workers>
      @if (workers?.length > 0) {
        <ul
          class="border-sidebar-border ms-3 min-w-0 border-s ps-1.5"
          data-testid="sidebar-workers"
        >
          @for (worker of workers; track worker.id) {
            <li class="min-w-0">
              <ng-template #workerTip>
                <app-activity-tooltip-content
                  [title]="worker.title"
                  [status]="workerTipStatus(worker)"
                />
              </ng-template>
              <button
                #rovingItem
                type="button"
                data-testid="sidebar-worker-row"
                [attr.data-roving-key]="worker.id"
                [attr.tabindex]="roving.tabIndex(worker.id)"
                [attr.aria-current]="worker.active ? 'page' : null"
                [hlmTooltip]="workerTip"
                position="right"
                [hlmContextMenuTrigger]="workerMenu"
                [hlmContextMenuTriggerData]="{ $implicit: worker }"
                [class.bg-sidebar-accent]="worker.active"
                class="hover:bg-sidebar-accent focus-visible:ring-ring flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-start text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
                (focus)="roving.focusedKey.set(worker.id)"
                (keydown)="onRovingKeydown($event, worker.id)"
                (click)="workerOpen.emit(worker)"
              >
                <span class="min-w-0 flex-1 truncate">{{ worker.title }}</span>
                <span
                  class="max-w-1/2 shrink-0 truncate"
                  [class]="
                    worker.needsPermission
                      ? 'text-[var(--attention)]'
                      : worker.running
                        ? 'text-[var(--working)]'
                        : 'text-muted-foreground'
                  "
                  [title]="worker.status"
                  data-testid="sidebar-worker-status"
                  >{{ worker.status }}</span
                >
              </button>
              <ng-container
                *ngTemplateOutlet="workerRows; context: { $implicit: worker.workers }"
              />
            </li>
          }
        </ul>
      }
    </ng-template>

    <ng-template #workerMenu let-worker>
      <hlm-dropdown-menu class="w-52">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="worker-open-in-split"
          [disabled]="!worker.canOpenInSplit"
          (triggered)="workerOpenInSplit.emit(worker)"
          i18n
        >
          Open in split
        </button>
      </hlm-dropdown-menu>
    </ng-template>

    <ng-template #sessionMenu let-rowId>
      @if (rowById(rowId); as row) {
        <app-session-context-menu
          [archived]="row.archived"
          [selected]="row.selected"
          [selectedCount]="selectedCount()"
          [selectedAllArchived]="selectedAllArchived()"
          [canOpenInSplit]="row.canOpenInSplit !== false"
          (open)="menuOpen.emit(row)"
          (openInNewTab)="menuOpenInNewTab.emit(row)"
          (openInSplit)="menuOpenInSplit.emit(row)"
          (rename)="startRename(row.id)"
          (archive)="menuArchive.emit(row)"
          (unarchive)="menuUnarchive.emit(row)"
          (delete)="menuDelete.emit(row)"
        />
      }
    </ng-template>

    <ng-template #archivedFoldMenu>
      <hlm-dropdown-menu class="w-48" data-testid="archived-fold-menu">
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="archived-menu-unarchive-all"
          (triggered)="unarchiveAll.emit()"
          i18n
        >
          Unarchive all (<span class="tabular-nums">{{ archived().length }}</span
          >)
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          variant="destructive"
          data-testid="archived-menu-delete-all"
          (triggered)="deleteAllArchived.emit()"
          i18n
        >
          Delete all (<span class="tabular-nums">{{ archived().length }}</span
          >)…
        </button>
      </hlm-dropdown-menu>
    </ng-template>
  `,
})
export class SessionList {
  readonly groups = input.required<ReadonlyArray<SessionGroup<SessionRow>>>();
  /** Sessions the cap hides behind "Show more". */
  readonly hiddenCount = input(0);
  readonly archived = input<ReadonlyArray<SessionRow>>([]);
  readonly archivedOpen = input(false);
  readonly selectedCount = input(0);
  readonly selectedAllArchived = input(false);

  readonly rowClick = output<RowClickEvent>();
  readonly workerOpen = output<SidebarWorkerRow>();
  readonly workerOpenInSplit = output<SidebarWorkerRow>();
  readonly toggleSelect = output<SessionId>();
  readonly extendSelection = output<{ readonly from: SessionId; readonly to: SessionId }>();
  readonly deleteKey = output<SessionRow>();
  readonly rename = output<{ readonly id: SessionId; readonly title: string }>();
  readonly showMore = output();
  readonly toggleArchived = output();
  readonly clearSelection = output();
  readonly menuOpen = output<SessionRow>();
  readonly menuOpenInNewTab = output<SessionRow>();
  readonly menuOpenInSplit = output<SessionRow>();
  readonly menuArchive = output<SessionRow>();
  readonly menuUnarchive = output<SessionRow>();
  readonly menuDelete = output<SessionRow>();
  readonly unarchiveAll = output();
  readonly deleteAllArchived = output();

  private readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly now = secondTicker(this.destroyRef);
  protected readonly editing = signal<SessionId | null>(null);
  private readonly pendingFocusId = signal<SessionId | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly rowButtons = viewChildren<ElementRef<HTMLButtonElement>>('sessionRowBtn');
  private readonly rovingElements = viewChildren<ElementRef<HTMLButtonElement>>('rovingItem');

  private readonly rovingItems = computed((): ReadonlyArray<RovingItem> => {
    const items: RovingItem[] = [];
    const addWorkers = (workers: ReadonlyArray<SidebarWorkerRow>): void => {
      for (const worker of workers) {
        items.push({ key: worker.id, active: worker.active });
        addWorkers(worker.workers);
      }
    };
    const addSession = (row: SessionRow): void => {
      items.push({ key: row.id, sessionId: row.id, active: row.active && !row.workerActive });
      addWorkers(row.workers ?? []);
    };
    for (const group of this.groups()) {
      for (const row of group.items) {
        addSession(row);
      }
    }
    if (this.hiddenCount() > 0) items.push({ key: 'show-more' });
    if (this.archived().length > 0) {
      items.push({ key: 'archived-fold' });
      if (this.archivedOpen()) {
        for (const row of this.archived()) {
          addSession(row);
        }
      }
    }
    return items;
  });

  protected readonly roving = createRovingFocus({
    items: this.rovingItems,
    elements: this.rovingElements,
    isEditing: () => this.editing() !== null,
  });

  constructor() {
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.editing() !== null,
      run: () => this.cancel(true),
      destroyRef: this.destroyRef,
    });
    wireEditorFocus(this.editor);
    wirePendingFocus({
      pendingId: this.pendingFocusId,
      isEditing: () => this.editing() !== null,
      elements: this.rowButtons,
      attribute: 'data-session-id',
      onFocused: (id) => this.roving.focusedKey.set(id),
    });
  }

  protected onRovingKeydown(event: KeyboardEvent, key: string, row?: SessionRow): void {
    this.roving.handleKeydown(event, {
      key,
      ...(row === undefined ? {} : { sessionId: row.id }),
      onToggleSelect: () => {
        if (row !== undefined) this.toggleSelect.emit(row.id);
      },
      onExtendSelection: (to) => {
        if (row !== undefined) this.extendSelection.emit({ from: row.id, to });
      },
      onStartRename: () => {
        if (row !== undefined) this.startRename(row.id);
      },
      onDelete: () => {
        if (row !== undefined) this.deleteKey.emit(row);
      },
    });
  }

  /** Opens inline rename for the given Session row (double-click, F2, or context menu). */
  startRename(id: SessionId): void {
    this.editing.set(id);
  }

  protected save(row: SessionRow, title: string, restoreFocus: boolean): void {
    if (this.editing() !== row.id) return;
    this.editing.set(null);
    if (restoreFocus) this.pendingFocusId.set(row.id);
    const trimmed = title.trim();
    const initial = row.untitled ? '' : row.title;
    if (trimmed !== initial) this.rename.emit({ id: row.id, title });
  }

  protected cancel(restoreFocus = false): void {
    const id = this.editing();
    this.editing.set(null);
    if (restoreFocus && id !== null) this.pendingFocusId.set(id);
  }

  protected rowById(id: SessionId): SessionRow | undefined {
    for (const group of this.groups()) {
      const match = group.items.find((row) => row.id === id);
      if (match !== undefined) return match;
    }
    return this.archived().find((row) => row.id === id);
  }

  protected onRowClick(id: SessionId, event: MouseEvent): void {
    this.rowClick.emit({
      id,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  }

  protected sessionTipStatus(row: SessionRow): ActivityTooltipStatus | null {
    if (row.archived) return null;
    return activityTooltipStatus(
      {
        status: row.status,
        ...(row.activity === undefined ? {} : { activity: row.activity }),
        ...(row.blockedTarget === undefined ? {} : { blockedTarget: row.blockedTarget }),
        ...(row.errorSummary === undefined ? {} : { errorSummary: row.errorSummary }),
      },
      this.now(),
    );
  }

  protected workerTipStatus(worker: SidebarWorkerRow): ActivityTooltipStatus | null {
    const status: SessionStatus = worker.needsPermission
      ? 'blocked'
      : worker.running === true
        ? 'working'
        : 'idle';
    return activityTooltipStatus(
      {
        status,
        ...(worker.activity === undefined ? {} : { activity: worker.activity }),
        ...(worker.blockedTarget === undefined ? {} : { blockedTarget: worker.blockedTarget }),
        ...(worker.errorSummary === undefined ? {} : { errorSummary: worker.errorSummary }),
        fallbackStatus: worker.status,
      },
      this.now(),
    );
  }

  protected rowClasses(row: SessionRow): string {
    const base =
      'flex min-h-[30px] shrink-0 flex-col justify-center rounded-md px-2 py-1 text-left text-sm select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
    if (row.selected) {
      return row.active
        ? `${base} bg-primary/15 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/50 font-medium`
        : `${base} bg-primary/15 ring-1 ring-inset ring-primary/40`;
    }
    if (row.active) return `${base} bg-sidebar-accent text-sidebar-accent-foreground font-medium`;
    return `${base} text-foreground/80 hover:bg-sidebar-accent`;
  }
}
