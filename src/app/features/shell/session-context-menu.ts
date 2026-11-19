import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { HlmDropdownMenuImports } from '@ui/dropdown-menu';
import { HlmKbdImports } from '@ui/kbd';
import { Keymap } from '../../core/keymap';

/** Context menu shared by One Project (`SessionList`) and All Projects (`AllProjectsList`) Session rows. */
@Component({
  selector: 'app-session-context-menu',
  imports: [HlmDropdownMenuImports, HlmKbdImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <hlm-dropdown-menu class="w-48" data-testid="session-context-menu">
      @if (selectedCount() > 1 && selected()) {
        @if (selectedAllArchived()) {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-unarchive-bulk"
            (triggered)="unarchive.emit()"
            i18n
          >
            Unarchive <span class="tabular-nums">{{ selectedCount() }}</span>
          </button>
        } @else {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-archive-bulk"
            (triggered)="archive.emit()"
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
          (triggered)="delete.emit()"
          i18n
        >
          Delete <span class="tabular-nums">{{ selectedCount() }}</span
          >…
        </button>
      } @else {
        <button type="button" hlmDropdownMenuItem data-testid="menu-open" (triggered)="open.emit()">
          <span i18n>Open</span>
          <kbd hlmKbd class="ml-auto font-mono font-normal">{{
            keymap.format({ key: 'Enter' })
          }}</kbd>
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="menu-add-to-stack"
          (triggered)="addToStack.emit()"
          i18n
        >
          Add to stack
        </button>
        <button
          type="button"
          hlmDropdownMenuItem
          data-testid="menu-rename"
          (triggered)="rename.emit()"
        >
          <span i18n>Rename</span>
          <kbd hlmKbd class="ml-auto font-mono font-normal">{{ keymap.format({ key: 'F2' }) }}</kbd>
        </button>
        <hlm-dropdown-menu-separator />
        @if (archived()) {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-unarchive"
            (triggered)="unarchive.emit()"
            i18n
          >
            Unarchive
          </button>
        } @else {
          <button
            type="button"
            hlmDropdownMenuItem
            data-testid="menu-archive"
            (triggered)="archive.emit()"
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
          (triggered)="delete.emit()"
          i18n
        >
          Delete…
        </button>
      }
    </hlm-dropdown-menu>
  `,
})
export class SessionContextMenu {
  protected readonly keymap = inject(Keymap);

  readonly archived = input.required<boolean>();
  readonly selected = input.required<boolean>();
  readonly selectedCount = input(0);
  readonly selectedAllArchived = input(false);

  readonly open = output();
  readonly addToStack = output();
  readonly rename = output();
  readonly archive = output();
  readonly unarchive = output();
  readonly delete = output();
}
