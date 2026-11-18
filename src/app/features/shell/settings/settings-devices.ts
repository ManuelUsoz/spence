import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { HlmInputImports } from '@ui/input';
import { HlmSwitchImports } from '@ui/switch';
import { toast } from '@ui/toast';
import { Effect } from 'effect';
import { DEVICE_NAME_MAX, type LocalDevice } from '../../../../shared/devices/devices.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { EffectRuntime } from '../../../core/effect-runtime';
import { SettingsRow } from './settings-row';

type DeviceView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly device: LocalDevice };

const load = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Devices.local']();
});

const rename = Effect.fnUntraced(function* (name: string) {
  const api = yield* DesktopApi;
  return yield* api['Devices.rename']({ name });
});

const setHosting = Effect.fnUntraced(function* (on: boolean) {
  const api = yield* DesktopApi;
  return yield* api['Devices.setHosting']({ on });
});

/**
 * Devices: this Device's name and whether other Devices may connect. Hosting is off by default; off means nothing
 * listens. Loads on its own, so a failure here never hides the other sections.
 */
@Component({
  selector: 'app-settings-devices',
  imports: [SettingsRow, HlmInputImports, HlmSwitchImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-devices' },
  template: `
    <h2 class="mt-9 mb-1.5 text-sm font-semibold" i18n>Devices</h2>
    @switch (view().status) {
      @case ('loading') {
        <p class="text-muted-foreground border-border/60 border-t py-3 text-sm" i18n>Loading…</p>
      }
      @case ('failed') {
        <p
          class="text-destructive border-border/60 border-t py-3 text-sm"
          data-testid="settings-devices-failed"
          i18n
        >
          Could not load this Device.
        </p>
      }
    }
    @if (loaded(); as device) {
      <app-settings-row
        label="Name"
        i18n-label
        hint="What your other Devices see."
        i18n-hint
        controlId="settings-device-name"
      >
        <input
          hlmInput
          id="settings-device-name"
          class="h-8 w-56"
          data-testid="settings-device-name"
          [attr.maxlength]="nameMax"
          [value]="device.name"
          (change)="onName($event)"
        />
      </app-settings-row>

      <app-settings-row
        label="Allow other Devices to connect"
        i18n-label
        [hint]="hostingHint(device)"
        controlId="settings-hosting"
      >
        @for (revision of [switchRevision()]; track revision) {
          <hlm-switch
            inputId="settings-hosting"
            data-testid="settings-hosting"
            [checked]="device.hosting"
            [disabled]="busy()"
            (checkedChange)="onHosting($event)"
          />
        }
      </app-settings-row>
      @if (hostingFailed()) {
        <p class="text-destructive pb-3 text-xs" data-testid="settings-hosting-failed" i18n>
          Could not start hosting: no free port. It stays off.
        </p>
      }
    }
  `,
})
export class SettingsDevices {
  private readonly runtime = inject(EffectRuntime);

  protected readonly nameMax = DEVICE_NAME_MAX;
  protected readonly view = signal<DeviceView>({ status: 'loading' });
  protected readonly busy = signal(false);
  protected readonly hostingFailed = signal(false);
  /** Bumped to rebuild the switch when a change is refused, so it shows the stored state again. */
  protected readonly switchRevision = signal(0);

  protected loaded(): LocalDevice | null {
    const view = this.view();
    return view.status === 'loaded' ? view.device : null;
  }

  constructor() {
    void this.load();
  }

  protected hostingHint(device: LocalDevice): string {
    return device.hosting && device.port !== null
      ? $localize`Listening on port ${device.port}:port:.`
      : $localize`Not reachable from other Devices.`;
  }

  private async load(): Promise<void> {
    const exit = await this.runtime.run(load);
    this.view.set(
      exit._tag === 'Success' ? { status: 'loaded', device: exit.value } : { status: 'failed' },
    );
  }

  protected async onName(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const exit = await this.runtime.run(rename(input.value));
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', device: exit.value });
      input.value = exit.value.name;
      return;
    }
    toast.error($localize`A Device name needs 1 to ${DEVICE_NAME_MAX}:max: characters.`);
    const device = this.loaded();
    if (device !== null) input.value = device.name;
  }

  protected async onHosting(on: boolean): Promise<void> {
    this.busy.set(true);
    this.hostingFailed.set(false);
    const exit = await this.runtime.run(setHosting(on));
    this.busy.set(false);
    if (exit._tag === 'Success') {
      this.view.set({ status: 'loaded', device: exit.value });
      return;
    }
    this.hostingFailed.set(true);
    this.switchRevision.update((revision) => revision + 1);
  }
}
