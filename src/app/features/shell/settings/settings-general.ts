import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmSelectImports } from '@ui/select';
import { HlmSwitchImports } from '@ui/switch';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Schema } from 'effect';
import {
  Language,
  ProjectOrder,
  SendMode,
  Theme,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isLanguage = Schema.is(Language);
const isSendMode = Schema.is(SendMode);
const isTheme = Schema.is(Theme);
const isOrderBy = Schema.is(ProjectOrder.fields.by);
const isOrderDirection = Schema.is(ProjectOrder.fields.direction);

/** General: how Spence looks and lists things. */
@Component({
  selector: 'app-settings-general',
  imports: [SettingsRow, HlmSelectImports, HlmSwitchImports, HlmToggleGroupImports],
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
        <hlm-select
          data-testid="settings-language"
          [value]="current.settings.language"
          (valueChange)="onLanguage($event)"
        >
          <hlm-select-trigger buttonId="settings-language">
            @switch (current.settings.language) {
              @case ('system') {
                <span i18n>System default</span>
              }
              @case ('en') {
                <span>English</span>
              }
              @case ('es') {
                <span>Español</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="system" data-value="system" i18n
              >System default</hlm-select-item
            >
            <hlm-select-item value="en" data-value="en">English</hlm-select-item>
            <hlm-select-item value="es" data-value="es">Español</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>

      <app-settings-row label="Project order" i18n-label controlId="settings-project-order-by">
        <hlm-select
          data-testid="settings-project-order-by"
          [value]="current.settings.projectOrder.by"
          (valueChange)="onOrderBy(current.settings, $event)"
        >
          <hlm-select-trigger buttonId="settings-project-order-by">
            @switch (current.settings.projectOrder.by) {
              @case ('lastUsed') {
                <span i18n>Last used</span>
              }
              @case ('name') {
                <span i18n>Name</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="lastUsed" data-value="lastUsed" i18n>Last used</hlm-select-item>
            <hlm-select-item value="name" data-value="name" i18n>Name</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
        @if (current.settings.projectOrder.by === 'name') {
          <hlm-select
            data-testid="settings-project-order-direction"
            [value]="current.settings.projectOrder.direction"
            (valueChange)="onOrderDirection(current.settings, $event)"
          >
            <label for="settings-project-order-direction" class="sr-only" i18n>Direction</label>
            <hlm-select-trigger buttonId="settings-project-order-direction">
              @switch (current.settings.projectOrder.direction) {
                @case ('asc') {
                  <span i18n>Ascending</span>
                }
                @case ('desc') {
                  <span i18n>Descending</span>
                }
              }
            </hlm-select-trigger>
            <hlm-select-content *hlmSelectPortal>
              <hlm-select-item value="asc" data-value="asc" i18n>Ascending</hlm-select-item>
              <hlm-select-item value="desc" data-value="desc" i18n>Descending</hlm-select-item>
            </hlm-select-content>
          </hlm-select>
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

      <app-settings-row
        label="While an Agent works, send with"
        i18n-label
        hint="The Composer’s send mode. Queue waits for the Turn to end; Steer sends into the running Turn. You can switch it per Session."
        i18n-hint
        controlId="settings-send-mode"
      >
        <hlm-select
          data-testid="settings-send-mode"
          [value]="current.settings.sendMode"
          (valueChange)="onSendMode($event)"
        >
          <hlm-select-trigger buttonId="settings-send-mode">
            @switch (current.settings.sendMode) {
              @case ('queue') {
                <span i18n>Queue</span>
              }
              @case ('steer') {
                <span i18n>Steer</span>
              }
            }
          </hlm-select-trigger>
          <hlm-select-content *hlmSelectPortal>
            <hlm-select-item value="queue" data-value="queue" i18n>Queue</hlm-select-item>
            <hlm-select-item value="steer" data-value="steer" i18n>Steer</hlm-select-item>
          </hlm-select-content>
        </hlm-select>
      </app-settings-row>
    }
  `,
})
export class SettingsGeneral {
  protected readonly store = inject(SettingsStore);

  protected onLanguage(value: unknown): void {
    if (isLanguage(value)) void this.store.change({ language: value });
  }

  protected onSendMode(value: unknown): void {
    if (isSendMode(value)) void this.store.change({ sendMode: value });
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
