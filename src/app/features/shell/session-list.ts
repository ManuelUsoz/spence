import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import type { SessionGroup } from './session-groups';

/** One two-line row: the title, then a muted meta line. */
export interface SessionRow {
  readonly id: SessionId;
  readonly title: string;
  readonly meta: string;
  readonly active: boolean;
  readonly untitled?: boolean;
}

/**
 * A Project's Sessions as labelled groups of two-line rows, with an optional draft placeholder on top. Which groups
 * there are is the caller's: day groups now, a pinned "Needs you" group later.
 */
@Component({
  selector: 'app-session-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex flex-col' },
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
            autofocus
            data-testid="session-rename"
            class="bg-background w-full rounded-md px-2 py-1 text-sm"
            [value]="row.title"
            aria-label="Session title"
            i18n-aria-label
            (keydown.enter)="save(row.id, editor.value)"
            (keydown.escape)="cancel()"
            (blur)="save(row.id, editor.value)"
          />
        } @else {
          <button
            type="button"
            data-testid="session-row"
            class="flex min-h-12 shrink-0 flex-col justify-center gap-0.5 rounded-md px-2 py-1.5 text-left text-sm"
            [class]="
              row.active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'hover:bg-sidebar-accent'
            "
            [attr.aria-current]="row.active ? 'page' : null"
            (click)="open.emit(row.id)"
            (dblclick)="editing.set(row.id)"
            (keydown.f2)="editing.set(row.id); $event.preventDefault()"
          >
            <span
              class="w-full truncate"
              [class.text-muted-foreground]="row.untitled"
              data-testid="session-title"
              >{{ row.title }}</span
            >
            <span class="text-muted-foreground text-xs font-normal" data-testid="session-meta">{{
              row.meta
            }}</span>
          </button>
        }
      }
    }
  `,
})
export class SessionList {
  readonly groups = input.required<ReadonlyArray<SessionGroup<SessionRow>>>();
  /** Shows the italic "New Session" placeholder row on top. */
  readonly draft = input(false);
  readonly draftActive = input(false);
  readonly open = output<SessionId>();
  readonly openDraft = output();
  readonly rename = output<{ id: SessionId; title: string }>();
  protected readonly editing = signal<SessionId | null>(null);

  protected save(id: SessionId, title: string): void {
    if (this.editing() !== id) return;
    this.editing.set(null);
    this.rename.emit({ id, title });
  }

  protected cancel(): void {
    this.editing.set(null);
  }
}
