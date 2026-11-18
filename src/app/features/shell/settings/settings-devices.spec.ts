import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Stream, SubscriptionRef } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceId,
  DevicesError,
  DevicesRpcs,
  type DevicesState,
  type LocalDevice,
  type NearbyDevice,
  type PairedDevice,
  type PairedDeviceStatus,
  PairingError,
  VersionMismatch,
} from '../../../../shared/devices/devices.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { SettingsDevices } from './settings-devices';

const fresh: LocalDevice = {
  id: DeviceId.make('3f6c1f0e-0000-4000-8000-000000000001'),
  name: 'Studio PC',
  hosting: false,
  port: null,
};

const hostingDevice: LocalDevice = { ...fresh, hosting: true, port: 47120 };

const studio: PairedDevice = {
  id: DeviceId.make('3f6c1f0e-0000-4000-8000-000000000002'),
  name: 'Studio PC',
  address: '192.168.1.20:47120',
  unpairedByOther: false,
};

interface Served {
  device: LocalDevice;
  renamed: string[];
  hosting: boolean[];
  /** When set, turning hosting on fails with `ListenFailed`. */
  noPort?: boolean;
  /** When set, `Devices.local` fails (a defect). */
  broken?: boolean;
  /** What `Devices.watch` streams; a test changes it to push a new state. */
  state: SubscriptionRef.SubscriptionRef<DevicesState>;
  /** What `Devices.check` answers per Device (reachable otherwise). */
  statuses: Map<string, PairedDeviceStatus>;
  /** `Devices.pair` calls; the next one fails with `pairFailure` when set, else pairs `studio`. */
  pairs: Array<{ address: string; code: string }>;
  pairFailure?: PairingError | VersionMismatch;
  /** When set, `Devices.startPairing` fails as on a Linux without a keyring. */
  noSecrets?: boolean;
  unpaired: string[];
  /** What `Devices.nearby` streams; a test changes it as Devices come and go. */
  nearby: SubscriptionRef.SubscriptionRef<ReadonlyArray<NearbyDevice>>;
  /** When set, `Devices.nearby` fails (a defect). */
  nearbyBroken?: boolean;
  /** `Devices.check` calls, by Device id. */
  checks: string[];
}

const setNearby = (served: Served, nearby: ReadonlyArray<NearbyDevice>): void =>
  Effect.runSync(SubscriptionRef.set(served.nearby, nearby));

const attic: NearbyDevice = {
  id: DeviceId.make('3f6c1f0e-0000-4000-8000-000000000003'),
  name: 'Attic PC',
  address: '192.168.1.31:47120',
  protocolVersion: 1,
};

const setState = (served: Served, change: (state: DevicesState) => DevicesState): void =>
  Effect.runSync(SubscriptionRef.update(served.state, change));

const handlers = (served: Served) =>
  DevicesRpcs.toLayer({
    'Devices.local': () =>
      served.broken === true ? Effect.die('no device') : Effect.sync(() => served.device),
    'Devices.rename': ({ name }) =>
      Effect.sync(() => {
        served.renamed.push(name);
        served.device = { ...served.device, name: name.trim() };
        return served.device;
      }),
    'Devices.setHosting': ({ on }) =>
      on && served.noPort === true
        ? Effect.fail(new DevicesError({ reason: 'ListenFailed', detail: 'No free port.' }))
        : Effect.sync(() => {
            served.hosting.push(on);
            served.device = { ...served.device, hosting: on, port: on ? 47120 : null };
            return served.device;
          }),
    'Devices.watch': () => SubscriptionRef.changes(served.state),
    'Devices.connections': () => Stream.make([]),
    'Devices.connect': () => Effect.void,
    'Devices.nearby': () =>
      served.nearbyBroken === true
        ? Stream.die('no multicast')
        : SubscriptionRef.changes(served.nearby),
    'Devices.startPairing': () =>
      served.noSecrets === true
        ? Effect.fail(
            new DevicesError({ reason: 'SecretStorageUnavailable', detail: 'No keyring.' }),
          )
        : Effect.sync(() => {
            const window = {
              _tag: 'Open',
              code: '482913',
              expiresAt: Date.now() + 120_000,
            } as const;
            setState(served, (state) => ({ ...state, pairing: window }));
            return window;
          }),
    'Devices.cancelPairing': () =>
      Effect.sync(() => setState(served, (state) => ({ ...state, pairing: { _tag: 'Idle' } }))),
    'Devices.pair': (input) =>
      Effect.suspend(() => {
        served.pairs.push({ address: input.address, code: input.code });
        if (served.pairFailure !== undefined) return Effect.fail(served.pairFailure);
        setState(served, (state) => ({ ...state, paired: [...state.paired, studio] }));
        return Effect.succeed(studio);
      }),
    'Devices.check': ({ id }) =>
      Effect.sync((): PairedDeviceStatus => {
        served.checks.push(id);
        return served.statuses.get(id) ?? { _tag: 'Online', name: 'Studio PC' };
      }),
    'Devices.unpair': ({ id }) =>
      Effect.sync(() => {
        served.unpaired.push(id);
        setState(served, (state) => ({
          ...state,
          paired: state.paired.filter((device) => device.id !== id),
        }));
      }),
  });

const serve = (
  overrides: Partial<Served> = {},
  paired: ReadonlyArray<PairedDevice> = [],
): Served => ({
  device: fresh,
  renamed: [],
  hosting: [],
  state: Effect.runSync(SubscriptionRef.make<DevicesState>({ pairing: { _tag: 'Idle' }, paired })),
  statuses: new Map(),
  pairs: [],
  unpaired: [],
  nearby: Effect.runSync(SubscriptionRef.make<ReadonlyArray<NearbyDevice>>([])),
  checks: [],
  ...overrides,
});

const open = (served: Served): ComponentFixture<SettingsDevices> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served)) }],
  });
  const fixture = TestBed.createComponent(SettingsDevices);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  fixture.detectChanges();
  return fixture;
};

const close = (): void => {
  document.body.innerHTML = '';
  TestBed.resetTestingModule();
};

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const text = (id: string): string => byTestId(id)?.textContent?.trim() ?? '';

const settle = (fixture: ComponentFixture<SettingsDevices>, check: () => void) =>
  vi.waitFor(() => {
    fixture.detectChanges();
    check();
  });

const flipHosting = (fixture: ComponentFixture<SettingsDevices>): void => {
  const button = byTestId('settings-hosting')?.querySelector<HTMLElement>('button[role="switch"]');
  if (button === null || button === undefined) throw new Error('no hosting switch');
  button.click();
  fixture.detectChanges();
};

const click = (fixture: ComponentFixture<SettingsDevices>, id: string): void => {
  const button = byTestId(id);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`no button ${id}`);
  button.click();
  fixture.detectChanges();
};

const type = (id: string, value: string): void => {
  const field = byTestId(id);
  if (!(field instanceof HTMLInputElement)) throw new Error(`no input ${id}`);
  field.value = value;
  field.dispatchEvent(new Event('input'));
};

const typePairing = (fixture: ComponentFixture<SettingsDevices>, code: string): void => {
  type('pair-address', '192.168.1.20:47120');
  type('pair-code', code);
  fixture.detectChanges();
  click(fixture, 'pair-submit');
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Settings > Devices', () => {
  it('shows hosting off on a fresh Device, with its name', async () => {
    const fixture = open(serve());
    await settle(fixture, () => expect(byTestId('settings-hosting')).not.toBeNull());
    const name = byTestId('settings-device-name');
    expect(name instanceof HTMLInputElement && name.value).toBe('Studio PC');
    expect(byTestId('settings-hosting')?.querySelector('[aria-checked="true"]')).toBeNull();
    expect(byTestId('settings-devices')?.textContent).toContain('Not reachable');
  });

  it('turns hosting on and shows the port it listens on', async () => {
    const served = serve();
    const fixture = open(served);
    await settle(fixture, () => expect(byTestId('settings-hosting')).not.toBeNull());
    flipHosting(fixture);
    await settle(fixture, () =>
      expect(byTestId('settings-devices')?.textContent).toContain('47120'),
    );
    expect(served.hosting).toEqual([true]);
  });

  it('says so when no port is free, and stays off', async () => {
    const fixture = open(serve({ noPort: true }));
    await settle(fixture, () => expect(byTestId('settings-hosting')).not.toBeNull());
    flipHosting(fixture);
    await settle(fixture, () => expect(byTestId('settings-hosting-failed')).not.toBeNull());
    expect(byTestId('settings-hosting')?.querySelector('[aria-checked="true"]')).toBeNull();
  });

  it('renames the Device', async () => {
    const served = serve();
    const fixture = open(served);
    await settle(fixture, () => expect(byTestId('settings-device-name')).not.toBeNull());
    const name = byTestId('settings-device-name');
    if (!(name instanceof HTMLInputElement)) throw new Error('name is not an input');
    name.value = 'Kitchen laptop';
    name.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(served.renamed).toEqual(['Kitchen laptop']));
  });

  it('shows a failure, never an empty section, when the Device cannot load', async () => {
    const fixture = open(serve({ broken: true }));
    await settle(fixture, () => expect(byTestId('settings-devices-failed')).not.toBeNull());
    expect(byTestId('settings-hosting')).toBeNull();
  });

  it('shows a pairing code only while hosting, and closes it on Cancel', async () => {
    const off = open(serve());
    await settle(off, () => expect(byTestId('pair-address')).not.toBeNull());
    expect(byTestId('pairing-start')).toBeNull();
    close();

    const fixture = open(serve({ device: hostingDevice }));
    await settle(fixture, () => expect(byTestId('pairing-start')).not.toBeNull());
    click(fixture, 'pairing-start');
    await settle(fixture, () => expect(text('pairing-code')).toBe('482913'));
    expect(text('pairing-expires')).toMatch(/^Expires in [12]:\d\d$/);
    click(fixture, 'pairing-cancel');
    await settle(fixture, () => expect(byTestId('pairing-code')).toBeNull());
  });

  it('says why no code can be shown when secrets cannot be stored safely', async () => {
    const fixture = open(serve({ device: hostingDevice, noSecrets: true }));
    await settle(fixture, () => expect(byTestId('pairing-start')).not.toBeNull());
    click(fixture, 'pairing-start');
    await settle(fixture, () =>
      expect(text('pairing-start-failed')).toContain('cannot store secrets safely'),
    );
  });

  it('tells how the last code ended', async () => {
    const served = serve({ device: hostingDevice });
    const fixture = open(served);
    await settle(fixture, () => expect(byTestId('pairing-outcome')).not.toBeNull());
    setState(served, (state) => ({
      ...state,
      pairing: { _tag: 'Paired', name: 'Kitchen laptop' },
    }));
    await settle(fixture, () =>
      expect(text('pairing-outcome')).toBe('Paired with Kitchen laptop.'),
    );
    setState(served, (state) => ({ ...state, pairing: { _tag: 'TooManyAttempts' } }));
    await settle(fixture, () => expect(text('pairing-outcome')).toContain('Too many wrong codes'));
  });

  it('pairs with an address and a code; the Device joins the list, reachable', async () => {
    const served = serve();
    const fixture = open(served);
    await settle(fixture, () => expect(byTestId('paired-devices-empty')).not.toBeNull());
    typePairing(fixture, '482913');
    await settle(fixture, () => expect(text('paired-device-name')).toBe('Studio PC'));
    expect(served.pairs).toEqual([{ address: '192.168.1.20:47120', code: '482913' }]);
    await settle(fixture, () => expect(text('paired-device-status')).toBe('Reachable.'));
  });

  it('says why pairing failed, naming the side to update on a version mismatch', async () => {
    const cases: ReadonlyArray<readonly [PairingError | VersionMismatch, string]> = [
      [new PairingError({ reason: 'WrongCode', detail: '' }), 'Wrong code'],
      [
        new PairingError({ reason: 'SecretStorageUnavailable', detail: '' }),
        'cannot store secrets safely',
      ],
      [
        new VersionMismatch({
          reason: 'UpdateRemote',
          detail: '',
          localVersion: 2,
          remoteVersion: 1,
        }),
        'Update Spence on the other Device',
      ],
    ];
    for (const [failure, message] of cases) {
      const fixture = open(serve({ pairFailure: failure }));
      await settle(fixture, () => expect(byTestId('pair-address')).not.toBeNull());
      typePairing(fixture, '000000');
      await settle(fixture, () => expect(text('pair-failed')).toContain(message));
      close();
    }
  });

  it('shows each Paired device state; one unpaired by the other side only offers Remove', async () => {
    const changed = { ...studio, id: DeviceId.make('d-2'), name: 'Old laptop' };
    const stale = { ...studio, id: DeviceId.make('d-3'), name: 'Attic PC' };
    const gone = { ...studio, id: DeviceId.make('d-4'), name: 'Garage PC', unpairedByOther: true };
    const served = serve({}, [changed, stale, gone]);
    served.statuses.set(changed.id, { _tag: 'IdentityChanged' });
    served.statuses.set(stale.id, {
      _tag: 'NeedsUpdate',
      update: 'Remote',
      localVersion: 2,
      remoteVersion: 1,
    });
    const fixture = open(served);
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="paired-device"]')];
    const statusOf = (row: HTMLElement) =>
      row.querySelector('[data-testid="paired-device-status"]')?.textContent?.trim();
    await settle(fixture, () =>
      expect(rows().map(statusOf)).toEqual([
        'Identity changed: this is not the Device you paired. Unpair it to pair again.',
        'Needs update: update Spence on Attic PC.',
        'Unpaired by the other side.',
      ]),
    );
    const garage = rows()[2];
    expect(garage?.querySelector('[data-testid="paired-device-unpair"]')).toBeNull();
    garage?.querySelector<HTMLButtonElement>('[data-testid="paired-device-remove"]')?.click();
    await settle(fixture, () => expect(rows()).toHaveLength(2));
    expect(served.unpaired).toEqual(['d-4']);
  });

  it('unpairs a Device', async () => {
    const served = serve({}, [studio]);
    const fixture = open(served);
    await settle(fixture, () => expect(byTestId('paired-device-unpair')).not.toBeNull());
    click(fixture, 'paired-device-unpair');
    await settle(fixture, () => expect(byTestId('paired-devices-empty')).not.toBeNull());
    expect(served.unpaired).toEqual([studio.id]);
  });

  describe('nearby Devices', () => {
    const rows = () => [...document.querySelectorAll<HTMLElement>('[data-testid="nearby-device"]')];

    it('lists the Devices hosting nearby that are not paired yet', async () => {
      const served = serve({}, [studio]);
      setNearby(served, [attic, { ...attic, id: studio.id, name: 'Studio PC' }]);
      const fixture = open(served);
      await settle(fixture, () => expect(rows()).toHaveLength(1));
      expect(rows()[0]?.textContent).toContain('Attic PC');
      expect(rows()[0]?.textContent).toContain('192.168.1.31:47120');

      setNearby(served, []);
      await settle(fixture, () => expect(byTestId('nearby-empty')).not.toBeNull());
      expect(text('nearby-empty')).toContain('type its address');
    });

    it('leads from a nearby Device to code entry; pairing is still by address and code', async () => {
      const served = serve();
      setNearby(served, [attic]);
      const fixture = open(served);
      await settle(fixture, () => expect(byTestId('nearby-pair')).not.toBeNull());
      click(fixture, 'nearby-pair');
      await settle(fixture, () => expect(document.activeElement).toBe(byTestId('pair-code')));
      const address = byTestId('pair-address');
      expect(address instanceof HTMLInputElement && address.value).toBe(attic.address);
      type('pair-code', '482913');
      fixture.detectChanges();
      click(fixture, 'pair-submit');
      await vi.waitFor(() =>
        expect(served.pairs).toEqual([{ address: attic.address, code: '482913' }]),
      );
    });

    it('checks a Paired device again when it shows up nearby', async () => {
      const served = serve({}, [studio]);
      served.statuses.set(studio.id, { _tag: 'Offline' });
      const fixture = open(served);
      await settle(fixture, () =>
        expect(text('paired-device-status')).toBe('Offline, or not hosting.'),
      );
      expect(served.checks).toEqual([studio.id]);

      served.statuses.delete(studio.id);
      setNearby(served, [{ ...attic, id: studio.id, name: 'Studio PC' }]);
      await settle(fixture, () => expect(text('paired-device-status')).toBe('Reachable.'));
      expect(served.checks).toEqual([studio.id, studio.id]);
    });

    it('still offers the typed address when looking for nearby Devices fails', async () => {
      const fixture = open(serve({ nearbyBroken: true }));
      await settle(fixture, () => expect(byTestId('nearby-failed')).not.toBeNull());
      expect(byTestId('pair-address')).not.toBeNull();
    });
  });
});
