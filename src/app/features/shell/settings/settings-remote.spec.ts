import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../../shared/agents/agents.rpc';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../../shared/devices/devices.rpc';
import {
  ExecutionSettingsRpcs,
  SettingsRpcs,
  type ExecutionSettings,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DeviceScope } from '../../../core/device-scope';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../../core/keymap';
import { SettingsState } from '../settings-state';
import { SettingsPage } from './settings-page';

const studio = DeviceId.make('device-studio');
const claude = AgentId.make('claude');

const agent = (installed: boolean): Agent => ({
  id: claude,
  name: 'Claude',
  installKind: 'npm',
  package: '@agentclientprotocol/claude-agent-acp',
  installed,
  qualifiedVersion: '0.106.0',
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: true,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
  },
});

const local: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  crossProjectAccess: [],
  agents: {},
};

const onStudio: ExecutionSettings = {
  defaultPermissionMode: 'ask',
  defaultAgent: 'claude',
  autoArchiveDays: 14,
  agents: {},
};

/** Stands in for the real install offer; shows the Device it would install on. */
@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-testid="install-offer-stub">
    {{ agent().name }} on {{ device() ?? 'local' }}
  </p>`,
})
class InstallOfferStub {
  readonly agent = input.required<Agent>();
  private readonly scope = inject(DeviceScope, { optional: true });
  protected readonly device = () => this.scope?.device();
}

interface Served {
  /** Every change, with the Device it was made on (`local` for none). */
  readonly changes: Array<readonly [string, string, unknown]>;
}

const deviceOf = (headers: Readonly<Record<string, string | undefined>>): string =>
  headers[DEVICE_SCOPE_HEADER] ?? 'local';

const die = () => Effect.die('unused');

const handlers = (served: Served, connections: ReadonlyArray<DeviceConnection>) =>
  Layer.mergeAll(
    DevicesRpcs.toLayer({
      'Devices.local': die,
      'Devices.rename': die,
      'Devices.setHosting': die,
      'Devices.watch': () => Stream.die('unused'),
      'Devices.nearby': () => Stream.die('unused'),
      'Devices.startPairing': die,
      'Devices.cancelPairing': die,
      'Devices.pair': die,
      'Devices.check': die,
      'Devices.connections': () => Stream.concat(Stream.make(connections), Stream.never),
      'Devices.connect': () => Effect.void,
      'Devices.unpair': die,
      'Devices.viewers': () => Stream.make([]),
      'Devices.disconnect': () => Effect.die('unused'),
    }),
    SettingsRpcs.toLayer({
      'Settings.get': () => Effect.succeed(local),
      'Settings.update': ({ patch }, { headers }) =>
        Effect.sync(() => {
          served.changes.push([deviceOf(headers), 'Settings.update', patch]);
          return { ...local, ...patch, agents: local.agents };
        }),
    }),
    ExecutionSettingsRpcs.toLayer({
      'ExecutionSettings.get': (_payload, { headers }) =>
        deviceOf(headers) === studio ? Effect.succeed(onStudio) : die(),
      'ExecutionSettings.update': ({ patch }, { headers }) =>
        Effect.sync(() => {
          served.changes.push([deviceOf(headers), 'ExecutionSettings.update', patch]);
          return { ...onStudio, ...patch, agents: onStudio.agents };
        }),
    }),
    AgentsRpcs.toLayer({
      // Claude is installed here, not on the Studio PC.
      'Agents.list': (_payload, { headers }) =>
        Effect.succeed([agent(deviceOf(headers) !== studio)]),
      'Agents.installCommand': die,
      'Agents.install': () => Stream.die('unused'),
      'Agents.openInstallLog': die,
    }),
  );

const online: ReadonlyArray<DeviceConnection> = [
  { id: studio, name: 'Studio PC', status: { _tag: 'Online', name: 'Studio PC' } },
];

const open = async (
  served: Served,
  connections: ReadonlyArray<DeviceConnection> = online,
): Promise<ComponentFixture<SettingsPage>> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(served, connections)) },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(SettingsPage);
  TestBed.inject(SettingsState).show();
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(byTestId('settings-sessions')?.textContent).toContain('Default Agent');
  });
  return fixture;
};

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const get = (id: string): HTMLElement => {
  const element = byTestId(id);
  if (element === null) throw new Error(`no ${id}`);
  return element;
};

const pressed = (id: string): boolean => get(id).getAttribute('aria-pressed') === 'true';

const choose = (fixture: ComponentFixture<SettingsPage>, id: string, value: string): void => {
  const select = get(id).querySelector('select');
  if (select === null) throw new Error(`no select in ${id}`);
  select.value = value;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
};

const settle = (fixture: ComponentFixture<SettingsPage>, check: () => void) =>
  vi.waitFor(() => {
    fixture.detectChanges();
    check();
  });

afterEach(() => {
  document.body.innerHTML = '';
  TestBed.resetTestingModule();
});

describe('Settings for a Remote device', () => {
  it('offers no Device choice while no Remote device is connected', async () => {
    await open({ changes: [] }, []);
    expect(byTestId('settings-device')).toBeNull();
  });

  it("shows and changes a Remote device's execution Settings and Agents; UI preferences stay Local", async () => {
    const served: Served = { changes: [] };
    const fixture = await open(served);
    await settle(fixture, () => expect(byTestId('settings-device')).not.toBeNull());
    expect(pressed('permission-auto')).toBe(true);
    expect(byTestId('install-offer-stub')).toBeNull();

    choose(fixture, 'settings-device', studio);

    await settle(fixture, () => expect(pressed('permission-ask')).toBe(true));
    expect((get('settings-auto-archive-days') as HTMLInputElement).value).toBe('14');
    // Claude is not installed on the Studio PC: the offer installs it there.
    expect(get('install-offer-stub').textContent).toContain('Claude on device-studio');

    get('permission-auto').click();
    fixture.detectChanges();
    await settle(fixture, () =>
      expect(served.changes).toEqual([
        [studio, 'ExecutionSettings.update', { defaultPermissionMode: 'auto' }],
      ]),
    );

    // The Theme is this Device's own, whichever Device the Sessions section is about.
    get('theme-dark').click();
    fixture.detectChanges();
    await settle(fixture, () =>
      expect(served.changes).toContainEqual(['local', 'Settings.update', { theme: 'dark' }]),
    );

    choose(fixture, 'settings-device', '');
    await settle(fixture, () => expect(pressed('permission-auto')).toBe(true));
    expect(byTestId('install-offer-stub')).toBeNull();
  });
});
