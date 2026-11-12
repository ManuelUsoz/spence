import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../shared/agents/agents.rpc';
import {
  SettingsRpcs,
  type Settings,
  type SettingsPatch,
} from '../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SettingsDialog } from './settings-dialog';
import { SettingsState } from './settings-state';

const claude = AgentId.make('claude');

const agent = (installed: boolean): Agent => ({
  id: claude,
  name: 'Claude',
  package: '@agentclientprotocol/claude-agent-acp',
  installed,
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
});

const defaults: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: {
    [claude]: {
      model: 'lastUsed',
      effort: 'lastUsed',
      models: [
        { id: 'opus', name: 'Opus' },
        { id: 'sonnet', name: 'Sonnet' },
      ],
    },
  },
};

/** Stands in for the real install offer, which belongs to another feature. */
@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<p data-testid="install-offer-stub">Install {{ agent().name }}</p>`,
})
class InstallOfferStub {
  readonly agent = input.required<Agent>();
}

let patches: SettingsPatch[] = [];

const handlers = (settings: Settings, agents: ReadonlyArray<Agent>) =>
  Layer.mergeAll(
    SettingsRpcs.toLayer({
      'Settings.get': () => Effect.succeed(settings),
      'Settings.update': ({ patch }) =>
        Effect.sync(() => {
          patches.push(patch);
          return settings;
        }),
    }),
    AgentsRpcs.toLayer({
      'Agents.list': () => Effect.succeed(agents),
      'Agents.installCommand': () => Effect.die('not served'),
      'Agents.install': () => Effect.die('not served'),
      'Agents.openInstallLog': () => Effect.die('not served'),
    }),
  );

const open = async (
  settings: Settings = defaults,
  agents: ReadonlyArray<Agent> = [agent(true)],
): Promise<ComponentFixture<SettingsDialog>> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers(settings, agents)) },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  const fixture = TestBed.createComponent(SettingsDialog);
  TestBed.inject(SettingsState).show();
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(byTestId('settings-general')).not.toBeNull();
  });
  return fixture;
};

/** The dialog renders in an overlay outside the fixture, so look it up in the document. */
const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const get = (id: string): HTMLElement => {
  const element = byTestId(id);
  if (element === null) throw new Error(`no ${id}`);
  return element;
};

const click = (fixture: ComponentFixture<SettingsDialog>, id: string): void => {
  get(id).click();
  fixture.detectChanges();
};

/** Flips a helm switch: its host is display: contents, the inner button takes the click. */
const flip = (fixture: ComponentFixture<SettingsDialog>, id: string): void => {
  const button = get(id).querySelector<HTMLElement>('button[role="switch"]');
  if (button === null) throw new Error(`no switch in ${id}`);
  button.click();
  fixture.detectChanges();
};

const choose = (fixture: ComponentFixture<SettingsDialog>, id: string, value: string): void => {
  const select = get(id).querySelector('select');
  if (select === null) throw new Error(`no select in ${id}`);
  select.value = value;
  select.dispatchEvent(new Event('change'));
  fixture.detectChanges();
};

const expectPatch = (patch: SettingsPatch) => vi.waitFor(() => expect(patches).toEqual([patch]));

beforeEach(() => {
  patches = [];
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SettingsDialog', () => {
  it('switches the Theme to Dark', async () => {
    const fixture = await open();
    click(fixture, 'theme-dark');
    await expectPatch({ theme: 'dark' });
  });

  it('picks the Language', async () => {
    const fixture = await open();
    choose(fixture, 'settings-language', 'es');
    await expectPatch({ language: 'es' });
  });

  it('turns Notifications off', async () => {
    const fixture = await open();
    flip(fixture, 'settings-notifications');
    await expectPatch({ notifications: false });
  });

  it('switches the Sidebar layout to All Projects', async () => {
    const fixture = await open();
    click(fixture, 'sidebar-allProjects');
    await expectPatch({ sidebarLayout: 'allProjects' });
  });

  it('orders Projects by name, keeping the direction', async () => {
    const fixture = await open();
    choose(fixture, 'settings-project-order-by', 'name');
    await expectPatch({ projectOrder: { by: 'name', direction: 'desc' } });
  });

  it('orders Projects ascending, keeping what they are ordered by', async () => {
    const fixture = await open();
    choose(fixture, 'settings-project-order-direction', 'asc');
    await expectPatch({ projectOrder: { by: 'lastUsed', direction: 'asc' } });
  });

  it('sets the Default permission mode to Ask', async () => {
    const fixture = await open();
    click(fixture, 'permission-ask');
    await expectPatch({ defaultPermissionMode: 'ask' });
  });

  it('turns Auto-archive on at 30 days', async () => {
    const fixture = await open();
    expect(byTestId('settings-auto-archive-days')).toBeNull();
    flip(fixture, 'settings-auto-archive');
    await expectPatch({ autoArchiveDays: 30 });
  });

  it('changes the Auto-archive days, and turns it off', async () => {
    const fixture = await open({ ...defaults, autoArchiveDays: 30 });
    const days = get('settings-auto-archive-days');
    if (!(days instanceof HTMLInputElement)) throw new Error('days is not an input');
    expect(days.value).toBe('30');
    days.value = '7';
    days.dispatchEvent(new Event('change'));
    await expectPatch({ autoArchiveDays: 7 });

    patches = [];
    flip(fixture, 'settings-auto-archive');
    await expectPatch({ autoArchiveDays: null });
  });

  it('ignores Auto-archive days that are not a whole number above zero', async () => {
    await open({ ...defaults, autoArchiveDays: 30 });
    const days = get('settings-auto-archive-days');
    if (!(days instanceof HTMLInputElement)) throw new Error('days is not an input');
    days.value = '0';
    days.dispatchEvent(new Event('change'));
    days.value = '';
    days.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(patches).toEqual([]);
  });

  it('pins an Agent Model from its cached list, and back to Last used', async () => {
    const fixture = await open();
    expect(get('agent-claude-status').textContent).toContain('Installed');
    choose(fixture, 'agent-claude-model', 'sonnet');
    await expectPatch({ agents: { [claude]: { model: 'sonnet' } } });

    patches = [];
    choose(fixture, 'agent-claude-model', 'lastUsed');
    await expectPatch({ agents: { [claude]: { model: 'lastUsed' } } });
  });

  it('pins an Agent Effort', async () => {
    const fixture = await open();
    choose(fixture, 'agent-claude-effort', 'high');
    await expectPatch({ agents: { [claude]: { effort: 'high' } } });
  });

  it('shows only Last used and a hint for an Agent never run', async () => {
    await open({ ...defaults, agents: {} });
    const options = [...get('agent-claude-model').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['lastUsed']);
    expect(get('agent-claude').textContent).toContain('Start a Session to see its Models');
  });

  it('embeds the install offer for an Agent that is not installed', async () => {
    await open(defaults, [agent(false)]);
    expect(get('agent-claude-status').textContent).toContain('Not installed');
    expect(
      get('agent-claude').querySelector('[data-testid="install-offer-stub"]')?.textContent,
    ).toBe('Install Claude');
  });
});
