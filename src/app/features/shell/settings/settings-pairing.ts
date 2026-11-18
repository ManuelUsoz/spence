import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { HlmButtonImports } from '@ui/button';
import { HlmInputImports } from '@ui/input';
import { Cause, Effect, Option, Stream } from 'effect';
import {
  type DeviceId,
  type DevicesState,
  PAIRING_CODE_LENGTH,
  type PairedDevice,
  type PairedDeviceStatus,
  type PairingError,
  type VersionMismatch,
} from '../../../../shared/devices/devices.rpc';
import { DesktopApi } from '../../../core/desktop-api';
import { EffectRuntime } from '../../../core/effect-runtime';
import { SettingsRow } from './settings-row';

type StateView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'loaded'; readonly state: DevicesState };

type StatusView = { readonly _tag: 'Checking' } | PairedDeviceStatus;

const startPairing = Effect.gen(function* () {
  const api = yield* DesktopApi;
  return yield* api['Devices.startPairing']();
});

const cancelPairing = Effect.gen(function* () {
  const api = yield* DesktopApi;
  yield* api['Devices.cancelPairing']();
});

const pair = Effect.fnUntraced(function* (address: string, code: string) {
  const api = yield* DesktopApi;
  return yield* api['Devices.pair']({ address, code });
});

const check = Effect.fnUntraced(function* (id: DeviceId) {
  const api = yield* DesktopApi;
  return yield* api['Devices.check']({ id });
});

const unpair = Effect.fnUntraced(function* (id: DeviceId) {
  const api = yield* DesktopApi;
  yield* api['Devices.unpair']({ id });
});

const pairingFailure = (error: PairingError | VersionMismatch): string => {
  switch (error.reason) {
    case 'InvalidAddress':
      return $localize`Enter the address as host:port, for example 192.168.1.20:47120.`;
    case 'Unreachable':
      return $localize`Nothing answered at that address. Is hosting on there?`;
    case 'NoCode':
      return $localize`That Device shows no open code: it expired or closed. Make a new one there.`;
    case 'WrongCode':
      return $localize`Wrong code. Check the code shown on the other Device.`;
    case 'SelfPair':
      return $localize`That address is this Device.`;
    case 'AlreadyPaired':
      return $localize`A Device with that identity is already paired with another certificate. Unpair it first.`;
    case 'SecretStorageUnavailable':
      return $localize`Pairing is off: one of the two Devices cannot store secrets safely (no OS keyring). Set one up and try again.`;
    case 'Rejected':
      return $localize`The other Device did not prove it shows that code, so it was not trusted.`;
    case 'UpdateLocal':
      return $localize`Update Spence on this Device to pair with that one.`;
    case 'UpdateRemote':
      return $localize`Update Spence on the other Device to pair with it.`;
  }
};

/**
 * Pairing in Settings > Devices: the code this Device shows while hosting, the form to pair with another Device by
 * address and code, and the Paired devices with their state and Unpair. One continuous stream (`Devices.watch`) keeps
 * the code and the list current; each Paired device is checked once when it appears.
 */
@Component({
  selector: 'app-settings-pairing',
  imports: [SettingsRow, HlmButtonImports, HlmInputImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'data-testid': 'settings-pairing' },
  template: `
    @switch (view().status) {
      @case ('loading') {
        <p class="text-muted-foreground border-border/60 border-t py-3 text-sm" i18n>Loading…</p>
      }
      @case ('failed') {
        <p
          class="text-destructive border-border/60 border-t py-3 text-sm"
          data-testid="settings-pairing-failed"
          i18n
        >
          Could not load the Paired devices.
        </p>
      }
    }
    @if (state(); as current) {
      @if (hosting()) {
        @let window = current.pairing;
        <div class="border-border/60 border-t py-3" data-testid="pairing-code-row">
          @if (window._tag === 'Open') {
            <div class="flex items-center gap-6">
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm" i18n>Pairing code</span>
                <span class="text-muted-foreground text-xs" i18n>
                  Type it on the other Device with this Device's address and port.
                </span>
              </div>
              <span
                class="font-mono text-xl tracking-[0.3em] tabular-nums"
                data-testid="pairing-code"
                >{{ window.code }}</span
              >
              <span
                class="text-muted-foreground w-24 text-xs tabular-nums"
                data-testid="pairing-expires"
                >{{ expiresIn(window.expiresAt) }}</span
              >
              <button
                hlmBtn
                type="button"
                variant="ghost"
                size="sm"
                data-testid="pairing-cancel"
                (click)="onCancel()"
                i18n
              >
                Cancel
              </button>
            </div>
          } @else {
            <div class="flex items-center gap-6">
              <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                <span class="text-sm" i18n>Pair a new Device</span>
                <span class="text-muted-foreground text-xs" data-testid="pairing-outcome">{{
                  outcome(window)
                }}</span>
              </div>
              <button
                hlmBtn
                type="button"
                variant="outline"
                size="sm"
                data-testid="pairing-start"
                [disabled]="starting()"
                (click)="onStart()"
                i18n
              >
                Show a code
              </button>
            </div>
          }
          @if (startFailed(); as message) {
            <p class="text-destructive pt-2 text-xs" data-testid="pairing-start-failed">
              {{ message }}
            </p>
          }
        </div>
      }

      <app-settings-row
        label="Pair with a Device"
        i18n-label
        hint="Its address and the code it shows."
        i18n-hint
        controlId="pair-address"
      >
        <input
          hlmInput
          id="pair-address"
          class="h-8 w-44 font-mono text-xs"
          placeholder="192.168.1.20:47120"
          aria-label="Address"
          i18n-aria-label
          data-testid="pair-address"
          [value]="address()"
          (input)="address.set($any($event.target).value)"
        />
        <input
          hlmInput
          class="h-8 w-24 font-mono text-xs tabular-nums"
          inputmode="numeric"
          autocomplete="off"
          placeholder="000000"
          aria-label="Code"
          i18n-aria-label
          data-testid="pair-code"
          [attr.maxlength]="codeLength"
          [value]="code()"
          (input)="code.set($any($event.target).value)"
        />
        <button
          hlmBtn
          type="button"
          size="sm"
          data-testid="pair-submit"
          [disabled]="pairing() || address().trim() === '' || code().trim().length !== codeLength"
          (click)="onPair()"
          i18n
        >
          Pair
        </button>
      </app-settings-row>
      @if (pairFailed(); as message) {
        <p class="text-destructive pb-3 text-xs" data-testid="pair-failed">{{ message }}</p>
      }

      <h3 class="text-muted-foreground mt-4 mb-1 text-xs" i18n>Paired devices</h3>
      @for (device of current.paired; track device.id) {
        <div
          class="border-border/60 flex items-center gap-6 border-t py-3"
          data-testid="paired-device"
          [attr.data-device-id]="device.id"
        >
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="truncate text-sm" data-testid="paired-device-name">{{ device.name }}</span>
            <span
              class="text-xs"
              data-testid="paired-device-status"
              [class.text-muted-foreground]="!attention(device)"
              [class.text-destructive]="attention(device)"
              >{{ statusLine(device) }}</span
            >
          </div>
          @if (device.unpairedByOther) {
            <button
              hlmBtn
              type="button"
              variant="outline"
              size="sm"
              data-testid="paired-device-remove"
              (click)="onUnpair(device.id)"
              i18n
            >
              Remove
            </button>
          } @else {
            <button
              hlmBtn
              type="button"
              variant="ghost"
              size="sm"
              data-testid="paired-device-check"
              (click)="onCheck(device.id)"
              i18n
            >
              Check
            </button>
            <button
              hlmBtn
              type="button"
              variant="destructive"
              size="sm"
              data-testid="paired-device-unpair"
              (click)="onUnpair(device.id)"
              i18n
            >
              Unpair
            </button>
          }
        </div>
      } @empty {
        <p
          class="text-muted-foreground border-border/60 border-t py-3 text-sm"
          data-testid="paired-devices-empty"
          i18n
        >
          No Paired devices yet.
        </p>
      }
    }
  `,
})
export class SettingsPairing {
  private readonly runtime = inject(EffectRuntime);

  /** Whether this Device hosts: only then can it show a pairing code. */
  readonly hosting = input.required<boolean>();

  protected readonly codeLength = PAIRING_CODE_LENGTH;
  protected readonly view = signal<StateView>({ status: 'loading' });
  protected readonly state = computed(() => {
    const view = this.view();
    return view.status === 'loaded' ? view.state : null;
  });
  protected readonly statuses = signal<ReadonlyMap<DeviceId, StatusView>>(new Map());
  protected readonly address = signal('');
  protected readonly code = signal('');
  protected readonly pairing = signal(false);
  protected readonly pairFailed = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected readonly startFailed = signal<string | null>(null);
  /** Ticks every second, for the code's countdown. */
  private readonly now = signal(Date.now());

  constructor() {
    const aborts = new AbortController();
    const ticker = setInterval(() => this.now.set(Date.now()), 1000);
    inject(DestroyRef).onDestroy(() => {
      aborts.abort();
      clearInterval(ticker);
    });
    void this.watch(aborts.signal);
  }

  private async watch(signal: AbortSignal): Promise<void> {
    const exit = await this.runtime.run(
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        return api['Devices.watch']();
      }).pipe(
        Stream.unwrap,
        Stream.runForEach((state) => Effect.sync(() => this.apply(state))),
      ),
      { signal },
    );
    if (exit._tag === 'Failure' && !signal.aborted && this.view().status === 'loading') {
      this.view.set({ status: 'failed' });
    }
  }

  private apply(state: DevicesState): void {
    this.view.set({ status: 'loaded', state });
    const known = this.statuses();
    for (const device of state.paired) {
      if (!known.has(device.id)) void this.onCheck(device.id);
    }
  }

  protected expiresIn(expiresAt: number): string {
    const left = Math.max(0, Math.ceil((expiresAt - this.now()) / 1000));
    const minutes = Math.floor(left / 60);
    const seconds = String(left % 60).padStart(2, '0');
    return $localize`Expires in ${minutes}:minutes::${seconds}:seconds:`;
  }

  protected outcome(window: DevicesState['pairing']): string {
    switch (window._tag) {
      case 'Paired':
        return $localize`Paired with ${window.name}:name:.`;
      case 'Expired':
        return $localize`The code expired. Show a new one to pair.`;
      case 'TooManyAttempts':
        return $localize`Too many wrong codes, so the code was closed. Show a new one to pair.`;
      case 'Idle':
      case 'Open':
        return $localize`Shows a single-use code for two minutes.`;
    }
  }

  protected attention(device: PairedDevice): boolean {
    const status = this.statuses().get(device.id);
    return (
      device.unpairedByOther ||
      status?._tag === 'IdentityChanged' ||
      status?._tag === 'NeedsUpdate' ||
      status?._tag === 'UnpairedByOther'
    );
  }

  protected statusLine(device: PairedDevice): string {
    if (device.unpairedByOther) return $localize`Unpaired by the other side.`;
    const status = this.statuses().get(device.id) ?? { _tag: 'Checking' };
    switch (status._tag) {
      case 'Checking':
        return $localize`Checking…`;
      case 'Online':
        return $localize`Reachable.`;
      case 'Offline':
        return $localize`Offline, or not hosting.`;
      case 'UnpairedByOther':
        return $localize`Unpaired by the other side.`;
      case 'IdentityChanged':
        return $localize`Identity changed: this is not the Device you paired. Unpair it to pair again.`;
      case 'NeedsUpdate':
        return status.update === 'Local'
          ? $localize`Needs update: update Spence on this Device.`
          : $localize`Needs update: update Spence on ${device.name}:name:.`;
    }
  }

  protected async onStart(): Promise<void> {
    this.starting.set(true);
    this.startFailed.set(null);
    const exit = await this.runtime.run(startPairing);
    this.starting.set(false);
    if (exit._tag === 'Success') return;
    const reason = Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.reason;
    this.startFailed.set(
      reason === 'SecretStorageUnavailable'
        ? $localize`Pairing is off: this Device cannot store secrets safely (no OS keyring). Set one up and try again.`
        : $localize`Could not show a pairing code.`,
    );
  }

  protected async onCancel(): Promise<void> {
    await this.runtime.run(cancelPairing);
  }

  protected async onPair(): Promise<void> {
    this.pairing.set(true);
    this.pairFailed.set(null);
    const exit = await this.runtime.run(pair(this.address(), this.code()));
    this.pairing.set(false);
    if (exit._tag === 'Success') {
      this.address.set('');
      this.code.set('');
      return;
    }
    const failure = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    this.pairFailed.set(
      failure?._tag === 'PairingError' || failure?._tag === 'VersionMismatch'
        ? pairingFailure(failure)
        : $localize`Could not pair.`,
    );
  }

  protected async onCheck(id: DeviceId): Promise<void> {
    this.setStatus(id, { _tag: 'Checking' });
    const exit = await this.runtime.run(check(id));
    this.setStatus(id, exit._tag === 'Success' ? exit.value : { _tag: 'Offline' });
  }

  protected async onUnpair(id: DeviceId): Promise<void> {
    await this.runtime.run(unpair(id));
  }

  private setStatus(id: DeviceId, status: StatusView): void {
    this.statuses.update((current) => new Map(current).set(id, status));
  }
}
