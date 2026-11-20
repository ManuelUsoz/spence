import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { HlmInputImports } from '@ui/input';
import { HlmNativeSelectImports } from '@ui/native-select';
import { HlmSwitchImports } from '@ui/switch';
import { HlmToggleGroupImports } from '@ui/toggle-group';
import { Schema } from 'effect';
import { PermissionMode } from '../../../../shared/projects/projects.rpc';
import { AUTO_ARCHIVE_DAYS_ON, SubagentMode } from '../../../../shared/settings/settings.rpc';
import { RemoteDevices } from '../../../core/remote-devices';
import { SettingsRow } from './settings-row';
import { SettingsStore } from './settings-store';

const isPermissionMode = Schema.is(PermissionMode);
const isSubagentMode = Schema.is(SubagentMode);
const isAutoArchiveDays = (days: number): boolean => Number.isInteger(days) && days > 0;

/** Sessions: what a new Session starts with, and when idle ones go away. */
@Component({
  selector: 'app-settings-sessions',
  imports: [
    SettingsRow,
    HlmInputImports,
    HlmNativeSelectImports,
    HlmSwitchImports,
    HlmToggleGroupImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.loaded()) {
      <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Sessions</h2>

      @if (devices.online().length > 0) {
        <app-settings-row
          label="Device"
          i18n-label
          hint="Sessions and Agents settings belong to the Device they run on."
          i18n-hint
          controlId="settings-device"
        >
          <hlm-native-select
            data-testid="settings-device"
            selectId="settings-device"
            [value]="store.device() ?? ''"
            (valueChange)="onDevice($event)"
          >
            <option value="" i18n>This Device</option>
            @for (device of devices.online(); track device.id) {
              <option [value]="device.id">{{ device.name }}</option>
            }
          </hlm-native-select>
        </app-settings-row>
      }

      @switch (store.execution().status) {
        @case ('loading') {
          <p class="text-muted-foreground py-3 text-sm" i18n>Loading…</p>
        }
        @case ('failed') {
          <p class="text-destructive py-3 text-sm" data-testid="settings-execution-failed" i18n>
            Could not load the Settings of this Device.
          </p>
        }
      }
    }

    @if (store.executionLoaded(); as current) {
      <app-settings-row
        label="Default Agent"
        i18n-label
        hint="For new Sessions."
        i18n-hint
        controlId="settings-default-agent"
      >
        <hlm-native-select
          data-testid="settings-default-agent"
          selectId="settings-default-agent"
          [value]="current.settings.defaultAgent"
          (valueChange)="onDefaultAgent($event)"
        >
          <option value="lastUsed" i18n>Last used</option>
          @for (agent of current.agents; track agent.id) {
            <option [value]="agent.id">{{ agent.name }}</option>
          }
        </hlm-native-select>
      </app-settings-row>

      <app-settings-row
        label="Default permission mode"
        i18n-label
        hint="Ask before each Step, or let the Agent act."
        i18n-hint
        labelId="settings-permission-label"
      >
        <div
          hlmToggleGroup
          variant="outline"
          size="sm"
          aria-labelledby="settings-permission-label"
          [nullable]="false"
          [value]="current.settings.defaultPermissionMode"
          (valueChange)="onPermissionMode($event)"
        >
          <button hlmToggleGroupItem value="ask" data-testid="permission-ask" i18n>Ask</button>
          <button hlmToggleGroupItem value="auto" data-testid="permission-auto" i18n>Auto</button>
        </div>
      </app-settings-row>

      <app-settings-row
        label="Subagents"
        i18n-label
        hint="Workers are Spence Sessions you can open and message. Native subagents are the Agent’s own and read-only."
        i18n-hint
        controlId="settings-subagents"
      >
        <hlm-native-select
          data-testid="settings-subagents"
          selectId="settings-subagents"
          [value]="current.settings.subagents"
          (valueChange)="onSubagents($event)"
        >
          <option value="workers" i18n>Spence Workers</option>
          <option value="native" i18n>Native to the Agent</option>
        </hlm-native-select>
      </app-settings-row>

      <app-settings-row label="Archive idle Sessions" i18n-label controlId="settings-auto-archive">
        @if (current.settings.autoArchiveDays !== null) {
          <span class="flex items-center gap-2">
            <input
              hlmInput
              type="number"
              min="1"
              step="1"
              class="h-8 w-20 tabular-nums"
              data-testid="settings-auto-archive-days"
              aria-label="Days idle before archiving"
              i18n-aria-label
              [value]="current.settings.autoArchiveDays"
              (change)="onAutoArchiveDays($event)"
            />
            <span class="text-muted-foreground" i18n>days</span>
          </span>
        }
        <hlm-switch
          inputId="settings-auto-archive"
          data-testid="settings-auto-archive"
          [checked]="current.settings.autoArchiveDays !== null"
          (checkedChange)="
            store.changeExecution({ autoArchiveDays: $event ? autoArchiveOn : null })
          "
        />
      </app-settings-row>
    }
  `,
})
export class SettingsSessions {
  protected readonly store = inject(SettingsStore);
  protected readonly devices = inject(RemoteDevices);

  protected onDevice(value: unknown): void {
    if (typeof value !== 'string') return;
    const device = this.devices.online().find((online) => online.id === value);
    void this.store.selectDevice(device?.id);
  }
  protected readonly autoArchiveOn = AUTO_ARCHIVE_DAYS_ON;

  protected onDefaultAgent(value: unknown): void {
    if (typeof value === 'string' && value !== '')
      void this.store.changeExecution({ defaultAgent: value });
  }

  protected onPermissionMode(value: unknown): void {
    if (isPermissionMode(value)) void this.store.changeExecution({ defaultPermissionMode: value });
  }

  protected onSubagents(value: unknown): void {
    if (isSubagentMode(value)) void this.store.changeExecution({ subagents: value });
  }

  protected onAutoArchiveDays(event: Event): void {
    const days = Number((event.target as HTMLInputElement).value);
    if (isAutoArchiveDays(days)) void this.store.changeExecution({ autoArchiveDays: days });
  }
}
