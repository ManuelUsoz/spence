import {
  ChangeDetectionStrategy,
  Component,
  type ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ActivityMark } from '@ui/activity-mark';
import { HlmContextMenuImports } from '@ui/context-menu';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import type { Attention, SessionId } from '../../../shared/sessions/sessions.rpc';
import type { SessionGroup } from './session-groups';

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
  imports: [HlmContextMenuImports, HlmDropdownMenuImports, ActivityMark],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex flex-col',
    '(keydown.escape)': 'clearSelection.emit()',
  },
  template: `
    @if (draft()) {
      <button
        type="button"
        data-testid="draft-row"
        class="text-muted-foreground flex h-12 shrink-0 items-center rounded-md px-2 text-left text-sm italic"
        [class.bg-sidebar-accent]="draftActive()"
        [class.hover:bg-sidebar-accent]="!draftActive()"
        [attr.aria-current]="draftActive() ? 'page' : null"
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
        @if (editing() === row.id) {
          <input
            #editor
            data-testid="session-rename"
            class="bg-background w-full rounded-md px-2 py-1 text-sm"
            [value]="row.untitled ? '' : row.title"
            aria-label="Session title"
            i18n-aria-label
            (keydown.enter)="$event.preventDefault(); save(row, editor.value)"
            (keydown.escape)="$event.stopPropagation(); cancel()"
            (blur)="save(row, editor.value)"
          />
        } @else {
          <button
            type="button"
            data-testid="session-row"
            [attr.data-session-id]="row.id"
            [attr.aria-current]="row.active ? 'page' : null"
            [attr.aria-selected]="row.selected"
            [attr.data-selected]="row.selected ? 'true' : null"
            [class]="rowClasses(row)"
            [hlmContextMenuTrigger]="sessionMenu"
            [hlmContextMenuTriggerData]="{ $implicit: row.id }"
            (click)="onRowClick(row.id, $event)"
            (dblclick)="startRename(row.id)"
            (keydown.f2)="startRename(row.id); $event.preventDefault()"
          >
            <span class="flex w-full items-center gap-1">
              <span
                class="min-w-0 flex-1 truncate"
                [class.text-muted-foreground]="row.untitled"
                data-testid="session-title"
                >{{ row.title }}</span
              >
              @if (row.attention; as attention) {
                <app-activity-mark [kind]="attention" />
              } @else if (row.running) {
                <app-activity-mark kind="running" />
              }
            </span>
            <span class="text-muted-foreground text-xs font-normal" data-testid="session-meta">{{
              row.meta
            }}</span>
          </button>
        }
      }
    }

    @if (archived().length > 0) {
      <div class="mt-2">
        <button
          type="button"
          data-testid="archived-fold"
          class="text-muted-foreground hover:bg-sidebar-accent flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs font-medium"
          [attr.aria-expanded]="archivedOpen()"
          [hlmContextMenuTrigger]="archivedFoldMenu"
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
              <button
                type="button"
                data-testid="session-row"
                data-archived="true"
                [attr.data-session-id]="row.id"
                [attr.aria-current]="row.active ? 'page' : null"
                [attr.aria-selected]="row.selected"
                [attr.data-selected]="row.selected ? 'true' : null"
                [class]="rowClasses(row)"
                [hlmContextMenuTrigger]="sessionMenu"
                [hlmContextMenuTriggerData]="{ $implicit: row.id }"
                (click)="onRowClick(row.id, $event)"
              >
                <span class="text-muted-foreground w-full truncate" data-testid="session-title">{{
                  row.title
                }}</span>
                <span
                  class="text-muted-foreground/80 text-xs font-normal"
                  data-testid="session-meta"
                  >{{ row.meta }}</span
                >
              </button>
            }
          </div>
        }
      </div>
    }

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
              i18n
            >
              Open
            </button>
            <button
              type="button"
              hlmDropdownMenuItem
              data-testid="menu-rename"
              (triggered)="startRename(row.id)"
              i18n
            >
              Rename
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

  protected readonly editing = signal<SessionId | null>(null);
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');

  constructor() {
    effect(() => {
      const input = this.editor()?.nativeElement;
      if (input !== undefined) {
        input.focus();
        input.select();
      }
    });
  }

  /** Opens inline rename for the given Session row (double-click, F2, or context menu). */
  startRename(id: SessionId): void {
    this.editing.set(id);
  }

  protected save(row: SessionRow, title: string): void {
    if (this.editing() !== row.id) return;
    this.editing.set(null);
    const trimmed = title.trim();
    const initial = row.untitled ? '' : row.title;
    if (trimmed !== initial) this.rename.emit({ id: row.id, title });
  }

  protected cancel(): void {
    this.editing.set(null);
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
      'flex min-h-12 shrink-0 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left text-sm select-none';
    if (row.selected) {
      return row.active
        ? `${base} bg-primary/15 text-sidebar-accent-foreground ring-1 ring-inset ring-primary/50 font-medium`
        : `${base} bg-primary/15 ring-1 ring-inset ring-primary/40`;
    }
    if (row.active) return `${base} bg-sidebar-accent text-sidebar-accent-foreground font-medium`;
    return `${base} hover:bg-sidebar-accent`;
  }
}
