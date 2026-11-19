import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmKbdImports } from '@ui/kbd';
import { Keymap, type KeyBinding } from '../../../core/keymap';
import { SettingsRow } from './settings-row';

interface Shortcut {
  readonly label: string;
  readonly binding: KeyBinding;
}

/**
 * The shortcuts worth knowing, written by hand: features register their own with `Keymap` and it does not list
 * them. Keep this in step with the bindings in `shell.ts`, `app-sidebar.ts` and `session-view.ts`.
 */
const shortcuts = (): ReadonlyArray<Shortcut> => [
  { label: $localize`New Session`, binding: { mod: true, key: 'n' } },
  { label: $localize`New Tab`, binding: { mod: true, key: 't' } },
  { label: $localize`Search this Project`, binding: { mod: true, key: 'k' } },
  { label: $localize`Open Settings`, binding: { mod: true, key: ',' } },
  { label: $localize`Focus the Composer`, binding: { mod: true, key: 'l' } },
  { label: $localize`Session actions`, binding: { mod: true, shift: true, key: 'k' } },
  { label: $localize`Switch between Ask and Auto`, binding: { mod: true, shift: true, key: 'a' } },
  { label: $localize`Queue a message during a Turn`, binding: { mod: true, key: 'Enter' } },
  {
    label: $localize`Steer a Turn with a message`,
    binding: { mod: true, shift: true, key: 'Enter' },
  },
  { label: $localize`Close the Panel`, binding: { mod: true, key: 'w' } },
  { label: $localize`Next Tab`, binding: { ctrl: true, code: 'Tab' } },
  { label: $localize`Previous Tab`, binding: { ctrl: true, shift: true, code: 'Tab' } },
  { label: $localize`First Tab`, binding: { mod: true, code: 'Digit1' } },
  { label: $localize`Last Tab`, binding: { mod: true, code: 'Digit9' } },
];

/** Keyboard: a read-only list of shortcuts. */
@Component({
  selector: 'app-settings-keyboard',
  imports: [SettingsRow, HlmKbdImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Keyboard</h2>
    @for (shortcut of list; track shortcut.label) {
      <app-settings-row [label]="shortcut.label">
        <kbd hlmKbd class="font-mono text-xs">{{ keymap.format(shortcut.binding) }}</kbd>
      </app-settings-row>
    }
  `,
})
export class SettingsKeyboard {
  protected readonly keymap = inject(Keymap);
  protected readonly list = shortcuts();
}
