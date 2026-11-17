import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmSwitchImports } from '@ui/switch';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Schema } from 'effect';
import {
  Language,
  ProjectOrder,
  Theme,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isLanguage = Schema.is(Language);
const isTheme = Schema.is(Theme);
const isOrderBy = Schema.is(ProjectOrder.fields.by);
const isOrderDirection = Schema.is(ProjectOrder.fields.direction);

/** General: how Spence looks and lists things. */
@Component({
  selector: 'app-settings-general',
  imports: [SettingsRow, HlmNativeSelectImports, HlmSwitchImports, HlmToggleGroupImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded(); as current) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>General</h2>

      <app-settings-row label="Theme" i18n-label labelId="settings-theme-label">
        <div
          hlmToggleGroup
          variant="outline"
          size="sm"
          aria-labelledby="settings-theme-label"
          [nullable]="false"
          [value]="current.settings.theme"
          (valueChange)="onTheme($event)"
        >
          <button hlmToggleGroupItem value="system" data-testid="theme-system" i18n>
            System default
          </button>
          <button hlmToggleGroupItem value="light" data-testid="theme-light" i18n>Light</button>
          <button hlmToggleGroupItem value="dark" data-testid="theme-dark" i18n>Dark</button>
        </div>
      </app-settings-row>

      <app-settings-row
        label="Language"
        i18n-label
        hint="Spence’s own labels. Agent replies are never translated."
        i18n-hint
        controlId="settings-language"
      >
        <hlm-native-select
          data-testid="settings-language"
          selectId="settings-language"
          [value]="current.settings.language"
          (valueChange)="onLanguage($event)"
        >
          <option value="system" i18n>System default</option>
          <option value="en">English</option>
          <option value="es">Español</option>
        </hlm-native-select>
      </app-settings-row>

      <app-settings-row label="Project order" i18n-label controlId="settings-project-order-by">
        <hlm-native-select
          data-testid="settings-project-order-by"
          selectId="settings-project-order-by"
          [value]="current.settings.projectOrder.by"
          (valueChange)="onOrderBy(current.settings, $event)"
        >
          <option value="lastUsed" i18n>Last used</option>
          <option value="name" i18n>Name</option>
        </hlm-native-select>
        @if (current.settings.projectOrder.by === 'name') {
          <hlm-native-select
            data-testid="settings-project-order-direction"
            aria-label="Direction"
            i18n-aria-label
            [value]="current.settings.projectOrder.direction"
            (valueChange)="onOrderDirection(current.settings, $event)"
          >
            <option value="asc" i18n>Ascending</option>
            <option value="desc" i18n>Descending</option>
          </hlm-native-select>
        }
      </app-settings-row>

      <app-settings-row
        label="Notify me when a Session needs me"
        i18n-label
        controlId="settings-notifications"
      >
        <hlm-switch
          inputId="settings-notifications"
          data-testid="settings-notifications"
          [checked]="current.settings.notifications"
          (checkedChange)="store.change({ notifications: $event })"
        />
      </app-settings-row>
    }
  `,
})
export class SettingsGeneral {
  protected readonly store = inject(SettingsStore);

  protected onLanguage(value: unknown): void {
    if (isLanguage(value)) void this.store.change({ language: value });
  }

  protected onTheme(value: unknown): void {
    if (isTheme(value)) void this.store.change({ theme: value });
  }

  protected onOrderBy(settings: Settings, value: unknown): void {
    if (isOrderBy(value)) {
      void this.store.change({ projectOrder: { ...settings.projectOrder, by: value } });
    }
  }

  protected onOrderDirection(settings: Settings, value: unknown): void {
    if (isOrderDirection(value)) {
      void this.store.change({ projectOrder: { ...settings.projectOrder, direction: value } });
    }
  }
}
