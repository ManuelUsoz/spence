import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import type { Attention, SessionId } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';
import type { SessionGroup } from './session-groups';
import {
  adjacentRovingItem,
  openContextMenuFor,
  resolveRovingKey,
  type RovingItem,
} from './sidebar-keys';

/** One two-line row: the title, then a muted meta line. */
export interface SessionRow {
  readonly id: SessionId;
  readonly title: string;
  readonly meta: string;
  readonly active: boolean;
  readonly untitled?: boolean;
  readonly selected: boolean;
  readonly archived: boolean;
  readonly attention?: Attention;
  readonly running?: boolean;
}

export interface RowClickEvent {
  readonly id: SessionId;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * A Project's Sessions as labelled groups of two-line rows, with an optional draft placeholder on top and a
 * collapsed-by-default Archived fold at the bottom.
 */
@Component({
  selector: 'app-session-list',
  imports: [
    NgTemplateOutlet,
    HlmContextMenuImports,
    HlmDropdownMenuImports,
    HlmKbdImports,
    ActivityMark,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col',
  },
  template: `
    @if (draft()) {
      <button
        #rovingItem
        type="button"
        data-testid="draft-row"
        data-roving-key="draft"
        [attr.tabindex]="rovingTabIndex('draft')"
        class="text-muted-foreground focus-visible:ring-ring flex h-12 shrink-0 items-center rounded-md px-2 text-left text-sm italic outline-none focus-visible:ring-2 focus-visible:ring-inset"
        [class.bg-sidebar-accent]="draftActive()"
        [class.hover:bg-sidebar-accent]="!draftActive()"
        [attr.aria-current]="draftActive() ? 'page' : null"
        (focus)="focusedKey.set('draft')"
        (keydown)="onRovingKeydown($event, 'draft')"
        (click)="openDraft.emit()"
        i18n
      >
        New Session
      </button>
    }
    @for (group of groups(); track group.label) {
      <div
        class="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium"
        data-testid="session-group"
      >
        {{ group.label }}
      </div>
      @for (row of group.items; track row.id) {
        <ng-container *ngTemplateOutlet="sessionRow; context: { $implicit: row }" />
      }
    }

    @if (archived().length > 0) {
      <div class="mt-2">
        <button
          #rovingItem
          type="button"
          data-testid="archived-fold"
          data-roving-key="archived-fold"
          [attr.tabindex]="rovingTabIndex('archived-fold')"
          class="text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset"
          [attr.aria-expanded]="archivedOpen()"
          [hlmContextMenuTrigger]="archivedFoldMenu"
          (focus)="focusedKey.set('archived-fold')"
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
        <button
          #rovingItem
          #sessionRowBtn
          type="button"
          data-testid="session-row"
          [attr.data-roving-key]="row.id"
          [attr.tabindex]="rovingTabIndex(row.id)"
          [attr.data-archived]="row.archived ? 'true' : null"
          [attr.data-session-id]="row.id"
          [attr.aria-current]="row.active ? 'page' : null"
          [attr.aria-selected]="row.selected"
          [attr.data-selected]="row.selected ? 'true' : null"
          [class]="rowClasses(row)"
          [hlmContextMenuTrigger]="sessionMenu"
          [hlmContextMenuTriggerData]="{ $implicit: row.id }"
          (focus)="focusedKey.set(row.id)"
          (keydown)="onRovingKeydown($event, row.id, row)"
          (click)="onRowClick(row.id, $event)"
          (dblclick)="startRename(row.id)"
        >
          <span class="flex w-full items-center gap-1">
            <span
              class="min-w-0 flex-1 truncate"
              [class.text-muted-foreground]="row.archived || row.untitled"
              data-testid="session-title"
              >{{ row.title }}</span
            >
            @if (!row.archived) {
              @if (row.attention; as attention) {
                <app-activity-mark [kind]="attention" />
              } @else if (row.running) {
                <app-activity-mark kind="running" />
              }
            }
          </span>
          <span
            class="text-xs font-normal"
            [class]="row.archived ? 'text-muted-foreground/80' : 'text-muted-foreground'"
            data-testid="session-meta"
            >{{ row.meta }}</span
          >
        </button>
      }
    </ng-template>

    <ng-template #sessionMenu let-rowId>
      @if (rowById(rowId); as row) {
        <hlm-dropdown-menu class="w-48" data-testid="session-context-menu">
          @if (selectedCount() > 1 && row.selected) {
            @if (selectedAllArchived()) {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-unarchive-bulk"
                (triggered)="menuUnarchive.emit(row)"
                i18n
              >
                Unarchive <span class="tabular-nums">{{ selectedCount() }}</span>
              </button>
            } @else {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-archive-bulk"
                (triggered)="menuArchive.emit(row)"
                i18n
              >
                Archive <span class="tabular-nums">{{ selectedCount() }}</span>
              </button>
            }
            <button
              type="button"
              hlmDropdownMenuItem
              variant="destructive"
              data-testid="menu-delete-bulk"
              (triggered)="menuDelete.emit(row)"
              i18n
            >
              Delete <span class="tabular-nums">{{ selectedCount() }}</span
              >…
            </button>
          } @else {
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-open"
              (triggered)="menuOpen.emit(row)"
            >
              <span i18n>Open</span>
              <kbd hlmKbd class="ml-auto font-mono font-normal">{{
                keymap.format({ key: 'Enter' })
              }}</kbd>
            </button>
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-rename"
              (triggered)="startRename(row.id)"
            >
              <span i18n>Rename</span>
              <kbd hlmKbd class="ml-auto font-mono font-normal">{{
                keymap.format({ key: 'F2' })
              }}</kbd>
            </button>
            <hlm-dropdown-menu-separator />
            @if (row.archived) {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-unarchive"
                (triggered)="menuUnarchive.emit(row)"
                i18n
              >
                Unarchive
              </button>
            } @else {
              <button
                type="button"
                hlmDropdownMenuItem
                data-testid="menu-archive"
                (triggered)="menuArchive.emit(row)"
              >
                <span i18n>Archive</span>
                <kbd hlmKbd class="ml-auto font-mono font-normal">{{
                  keymap.format({ key: 'Delete' })
                }}</kbd>
              </button>
            }
            <button
              type="button"
              hlmDropdownMenuItem
              variant="destructive"
              data-testid="menu-delete"
              (triggered)="menuDelete.emit(row)"
              i18n
            >
              Delete…
            </button>
          }
        </hlm-dropdown-menu>
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
  readonly archived = input<ReadonlyArray<SessionRow>>([]);
  readonly archivedOpen = input(false);
  readonly selectedCount = input(0);
  readonly selectedAllArchived = input(false);
  /** Shows the italic "New Session" placeholder row on top. */
  readonly draft = input(false);
  readonly draftActive = input(false);

  readonly rowClick = output<RowClickEvent>();
  readonly toggleSelect = output<SessionId>();
  readonly extendSelection = output<{ readonly from: SessionId; readonly to: SessionId }>();
  readonly deleteKey = output<SessionRow>();
  readonly openDraft = output();
  readonly rename = output<{ readonly id: SessionId; readonly title: string }>();
  readonly toggleArchived = output();
  readonly clearSelection = output();
  readonly menuOpen = output<SessionRow>();
  readonly menuArchive = output<SessionRow>();
  readonly menuUnarchive = output<SessionRow>();
  readonly menuDelete = output<SessionRow>();
  readonly unarchiveAll = output();
  readonly deleteAllArchived = output();

  protected readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly editing = signal<SessionId | null>(null);
  protected readonly focusedKey = signal<string | null>(null);
  private readonly pendingFocusId = signal<SessionId | null>(null);
  private fallbackFocusKey: string | null = null;
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
  private readonly rowButtons = viewChildren<ElementRef<HTMLButtonElement>>('sessionRowBtn');
  private readonly rovingElements = viewChildren<ElementRef<HTMLButtonElement>>('rovingItem');

  private readonly rovingItems = computed((): ReadonlyArray<RovingItem> => {
    const items: RovingItem[] = [];
    if (this.draft()) items.push({ key: 'draft', active: this.draftActive() });
    for (const group of this.groups()) {
      for (const row of group.items) {
        items.push({ key: row.id, sessionId: row.id, active: row.active });
      }
    }
    if (this.archived().length > 0) {
      items.push({ key: 'archived-fold' });
      if (this.archivedOpen()) {
        for (const row of this.archived()) {
          items.push({ key: row.id, sessionId: row.id, active: row.active });
        }
      }
    }
    return items;
  });

  private readonly activeRovingKey = computed(() =>
    resolveRovingKey(this.rovingItems(), this.focusedKey()),
  );

  constructor() {
    this.keymap.registerEscape({
      layer: 'rename',
      when: () => this.editing() !== null,
      run: () => this.cancel(true),
      destroyRef: this.destroyRef,
    });
    effect(() => {
      const input = this.editor()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
    effect(() => {
      const id = this.pendingFocusId();
      if (id === null || this.editing() !== null) return;
      const button = this.rowButtons().find(
        (ref) => ref.nativeElement.getAttribute('data-session-id') === id,
      )?.nativeElement;
      if (button === undefined) return;
      untracked(() => {
        this.pendingFocusId.set(null);
        this.focusedKey.set(id);
      });
      button.focus({ preventScroll: true });
    });
    effect(() => {
      const items = this.rovingItems();
      const fallback = this.fallbackFocusKey;
      if (fallback === null) return;
      const current = untracked(() => this.focusedKey());
      if (current !== null && !items.some((item) => item.key === current)) {
        const target = items.find((item) => item.key === fallback);
        if (target !== undefined) {
          untracked(() => {
            this.fallbackFocusKey = null;
            this.focusedKey.set(target.key);
          });
          this.focusKey(target.key);
        }
      }
    });
  }

  protected rovingTabIndex(key: string): number {
    return this.activeRovingKey() === key ? 0 : -1;
  }

  protected onRovingKeydown(event: KeyboardEvent, key: string, row?: SessionRow): void {
    if (event.isComposing || this.editing() !== null) return;
    if (this.keymap.modalOpen() || this.keymap.isMenuOpen()) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const items = this.rovingItems();
      if (event.shiftKey) {
        if (row === undefined) return;
        event.preventDefault();
        const next = adjacentRovingItem(items, key, delta, { sessionOnly: true });
        if (next === null || next.sessionId === undefined) return;
        this.focusedKey.set(next.key);
        this.focusKey(next.key);
        this.extendSelection.emit({ from: row.id, to: next.sessionId });
        return;
      }
      event.preventDefault();
      const next = adjacentRovingItem(items, key, delta, { sessionOnly: false });
      if (next !== null) {
        this.focusedKey.set(next.key);
        this.focusKey(next.key);
      }
      return;
    }

    if (row === undefined) return;

    if (event.key === ' ' && !event.shiftKey) {
      event.preventDefault();
      this.toggleSelect.emit(row.id);
      return;
    }
    if (event.key === 'F2' && !event.shiftKey) {
      event.preventDefault();
      this.startRename(row.id);
      return;
    }
    if (
      (event.shiftKey && event.key === 'F10') ||
      (event.key === 'ContextMenu' && !event.shiftKey)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      if (target instanceof HTMLElement) openContextMenuFor(target);
      return;
    }
    if (event.key === 'Delete' && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      const items = this.rovingItems();
      const next =
        adjacentRovingItem(items, key, 1, { sessionOnly: true }) ??
        adjacentRovingItem(items, key, -1, { sessionOnly: true });
      this.fallbackFocusKey = next?.key ?? null;
      this.deleteKey.emit(row);
    }
  }

  private focusKey(key: string): void {
    const button = this.rovingElements().find(
      (ref) => ref.nativeElement.getAttribute('data-roving-key') === key,
    )?.nativeElement;
    button?.focus({ preventScroll: true });
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

  protected rowClasses(row: SessionRow): string {
    const base =
      'flex min-h-12 shrink-0 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left text-sm select-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
    if (row.selected) {
      return row.active
        ? `${base} bg-primary/15 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/50 font-medium`
        : `${base} bg-primary/15 ring-1 ring-inset ring-primary/40`;
    }
    if (row.active) return `${base} bg-sidebar-accent text-sidebar-accent-foreground font-medium`;
    return `${base} hover:bg-sidebar-accent`;
  }
}
