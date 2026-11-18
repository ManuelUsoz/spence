import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceId,
  DevicesError,
  DevicesRpcs,
  type LocalDevice,
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

interface Served {
  device: LocalDevice;
  renamed: string[];
  hosting: boolean[];
  /** When set, turning hosting on fails with `ListenFailed`. */
  noPort?: boolean;
  /** When set, `Devices.local` fails (a defect). */
  broken?: boolean;
}

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
  });

const serve = (overrides: Partial<Served> = {}): Served => ({
  device: fresh,
  renamed: [],
  hosting: [],
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

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

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
});
