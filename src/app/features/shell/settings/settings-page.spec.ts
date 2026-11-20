import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../../shared/app-info/app-info.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../../shared/projects/projects.rpc';
import {
  SettingsRpcs,
  type Settings,
  type SettingsPatch,
} from '../../../../shared/settings/settings.rpc';
import { AGENT_INSTALL_OFFER } from '../../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../../core/keymap';
import { SettingsState } from '../settings-state';
import { SettingsPage } from './settings-page';

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
    crossDeviceTools: true,
  },
});

const defaults: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers' as const,
  crossProjectAccess: [],
  filesTreeWidth: 288,
  agents: {
    [claude]: {
      model: 'lastUsed',
      effort: 'lastUsed',
      models: [
        { id: 'opus', name: 'Opus' },
        { id: 'sonnet', name: 'Sonnet' },
      ],
      ran: true,
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

const handlers = (
  settings: Settings,
  agents: ReadonlyArray<Agent> | (() => ReadonlyArray<Agent>),
  projects: ReadonlyArray<Project> = [],
) =>
  Layer.mergeAll(
    ProjectsRpcs.toLayer({
      'Projects.list': () => Effect.succeed(projects),
      'Projects.add': () => Effect.die('unused'),
      'Projects.rename': () => Effect.die('unused'),
      'Projects.remove': () => Effect.die('unused'),
      'Projects.addFolder': () => Effect.die('unused'),
      'Projects.locateFolder': () => Effect.die('unused'),
      'Projects.check': () => Effect.die('unused'),
      'Projects.locate': () => Effect.die('unused'),
      'Projects.setSettings': () => Effect.die('unused'),
    }),
    SettingsRpcs.toLayer({
      'Settings.get': () => Effect.succeed(settings),
      'Settings.update': ({ patch }) =>
        Effect.sync(() => {
          patches.push(patch);
          return { ...settings, ...patch, agents: settings.agents };
        }),
    }),
    AgentsRpcs.toLayer({
      'Agents.list': () => Effect.succeed(typeof agents === 'function' ? agents() : agents),
      'Agents.installCommand': () => Effect.die('not served'),
      'Agents.install': () => Effect.die('not served'),
      'Agents.openInstallLog': () => Effect.die('not served'),
    }),
    AppInfoRpcs.toLayer({
      'AppInfo.get': () =>
        Effect.succeed({
          name: 'Spence',
          version: '1.2.3',
          electron: '40.0.0',
          chrome: '140.0.0',
          node: '24.0.0',
          platform: 'win32',
          cwd: 'C:/spence',
        }),
    }),
  );

const open = async (
  settings: Settings = defaults,
  agents: ReadonlyArray<Agent> | (() => ReadonlyArray<Agent>) = [agent(true)],
  projects: ReadonlyArray<Project> = [],
): Promise<ComponentFixture<SettingsPage>> => {
  TestBed.configureTestingModule({
    providers: [
      {
        provide: DESKTOP_LAYER,
        useValue: makeDesktopTestLayer(handlers(settings, agents, projects)),
      },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(SettingsPage);
  TestBed.inject(SettingsState).show();
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(byTestId('settings-general')?.textContent).toContain('Theme');
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

const click = (fixture: ComponentFixture<SettingsPage>, id: string): void => {
  get(id).click();
  fixture.detectChanges();
};

/** Flips a helm switch: its host is display: contents, the inner button takes the click. */
const flip = (fixture: ComponentFixture<SettingsPage>, id: string): void => {
  const button = get(id).querySelector<HTMLElement>('button[role="switch"]');
  if (button === null) throw new Error(`no switch in ${id}`);
  button.click();
  fixture.detectChanges();
};

const choose = (fixture: ComponentFixture<SettingsPage>, id: string, value: string): void => {
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

describe('SettingsPage', () => {
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

  it('orders Projects by name, keeping the direction', async () => {
    const fixture = await open();
    choose(fixture, 'settings-project-order-by', 'name');
    await expectPatch({ projectOrder: { by: 'name', direction: 'desc' } });
  });

  it('shows the order direction only when ordering by name, and changes it', async () => {
    await open();
    expect(byTestId('settings-project-order-direction')).toBeNull();

    patches = [];
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    const fixture = await open({
      ...defaults,
      projectOrder: { by: 'name', direction: 'desc' },
    });
    choose(fixture, 'settings-project-order-direction', 'asc');
    await expectPatch({ projectOrder: { by: 'name', direction: 'asc' } });
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

  it('keeps an Agent’s Model and Effort behind Configure', async () => {
    const fixture = await open();
    expect(get('agent-claude-status').textContent).toContain('Installed');
    expect(byTestId('agent-claude-model')).toBeNull();
    click(fixture, 'agent-claude-configure');
    expect(byTestId('agent-claude-model')).not.toBeNull();
    click(fixture, 'agent-claude-configure');
    expect(byTestId('agent-claude-model')).toBeNull();
  });

  it('pins an Agent Model from its cached list, and back to Last used', async () => {
    const fixture = await open();
    click(fixture, 'agent-claude-configure');
    choose(fixture, 'agent-claude-model', 'sonnet');
    await expectPatch({ agents: { [claude]: { model: 'sonnet' } } });

    patches = [];
    choose(fixture, 'agent-claude-model', 'lastUsed');
    await expectPatch({ agents: { [claude]: { model: 'lastUsed' } } });
  });

  it('pins an Agent Effort', async () => {
    const fixture = await open();
    click(fixture, 'agent-claude-configure');
    choose(fixture, 'agent-claude-effort', 'high');
    await expectPatch({ agents: { [claude]: { effort: 'high' } } });
  });

  it('shows only Last used and a hint for an Agent never run', async () => {
    // Main resolves an entry for every Catalog Agent, run or not.
    const fixture = await open({
      ...defaults,
      agents: { [claude]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: false } },
    });
    click(fixture, 'agent-claude-configure');
    const options = (id: string) =>
      [...get(id).querySelectorAll('option')].map((option) => option.value);
    expect(options('agent-claude-model')).toEqual(['lastUsed']);
    expect(options('agent-claude-effort')).toEqual(['lastUsed']);
    expect(get('agent-claude').textContent).toContain('Start a Session to see its Models');
  });

  it('pins Effort for an Agent that has run but reported no Models', async () => {
    const fixture = await open({
      ...defaults,
      agents: { [claude]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: true } },
    });
    click(fixture, 'agent-claude-configure');
    expect(get('agent-claude').textContent).not.toContain('Start a Session to see its Models');
    choose(fixture, 'agent-claude-effort', 'max');
    await expectPatch({ agents: { [claude]: { effort: 'max' } } });
  });

  it('embeds the install offer for an Agent that is not installed', async () => {
    await open(defaults, [agent(false)]);
    expect(get('agent-claude-status').textContent).toContain('Not installed');
    expect(byTestId('agent-claude-configure')).toBeNull();
    expect(
      get('agent-claude').querySelector('[data-testid="install-offer-stub"]')?.textContent,
    ).toBe('Install Claude');
  });

  it('closes on Escape, without locking global shortcuts', async () => {
    await open();
    const state = TestBed.inject(SettingsState);
    const keymap = TestBed.inject(Keymap);
    expect(state.open()).toBe(true);
    expect(keymap.modalOpen()).toBe(false);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    expect(state.open()).toBe(false);
  });

  it('jumps to a section from the side list', async () => {
    const fixture = await open();
    const target = get('settings-keyboard');
    const scrolled = vi.fn();
    target.scrollIntoView = scrolled;
    click(fixture, 'settings-nav-keyboard');
    expect(scrolled).toHaveBeenCalled();
    expect(get('settings-nav-keyboard').getAttribute('aria-current')).toBe('location');
    expect(get('settings-nav-general').getAttribute('aria-current')).toBeNull();
  });

  it('lists shortcuts for this platform, and which Spence this is', async () => {
    await open();
    expect(get('settings-keyboard').textContent).toContain('Ctrl+N');
    await vi.waitFor(() => expect(get('settings-about-section').textContent).toContain('1.2.3'));
  });

  it('picks the Default Agent (Last used or pinned Agent)', async () => {
    const codex: Agent = { ...agent(true), id: AgentId.make('codex'), name: 'Codex' };
    const fixture = await open(defaults, [agent(true), codex]);
    const options = [...get('settings-default-agent').querySelectorAll('option')].map(
      (option) => option.value,
    );
    expect(options).toEqual(['lastUsed', 'claude', 'codex']);

    choose(fixture, 'settings-default-agent', 'lastUsed');
    await expectPatch({ defaultAgent: 'lastUsed' });

    patches = [];
    choose(fixture, 'settings-default-agent', 'codex');
    await expectPatch({ defaultAgent: 'codex' });
  });

  it('re-scans Agents on demand and surfaces version qualification and unsupported capabilities', async () => {
    let installedNow = false;
    const codex: Agent = {
      ...agent(false),
      id: AgentId.make('codex'),
      name: 'Codex',
      installKind: 'native',
      capabilities: {
        ...agent(true).capabilities,
        models: false,
        effort: false,
      },
      upgradeCommand: 'npm install -g @zed-industries/claude-agent-acp@0.106.0',
    };
    const claudeUnverified: Agent = {
      ...agent(true),
      installedVersion: '0.105.0',
      versionQualification: 'unverified',
      upgradeCommand: 'npm install -g @zed-industries/claude-agent-acp@0.106.0',
    };
    const fixture = await open(defaults, () => [
      claudeUnverified,
      {
        ...codex,
        installed: installedNow,
        ...(installedNow
          ? { installedVersion: '1.2.0', versionQualification: 'qualified' as const }
          : {}),
      },
    ]);

    expect(get('agent-claude-unverified').textContent).toContain('Unverified version');
    expect(get('agent-claude').textContent).toContain('0.105.0');
    expect(get('agent-claude').textContent).toContain(
      'npm install -g @zed-industries/claude-agent-acp@0.106.0',
    );
    expect(get('agent-codex-status').textContent).toContain('Not installed');

    installedNow = true;
    click(fixture, 'agents-rescan');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(get('agent-codex-status').textContent).toContain('Installed');
    });

    click(fixture, 'agent-codex-configure');
    expect(get('agent-codex').textContent).toContain('Not supported by Codex');
  });

  describe('Permissions', () => {
    const payments = ProjectId.make('p-pay');
    const spence = ProjectId.make('p-spence');
    const project = (id: ProjectId, name: string): Project => ({
      id,
      name,
      path: '/' + name,
      addedAt: 1,
      lastUsedAt: 1,
      settings: {},
      folderMissing: false,
    });
    const projects = [project(payments, 'payments'), project(spence, 'spence')];

    it('says nothing is allowed by default', async () => {
      await open(defaults, [agent(true)], projects);
      expect(get('settings-permissions').textContent).toContain('Cross-Project messaging is off');
    });

    it('lists an allowed Project pair by name and removes it', async () => {
      const fixture = await open(
        { ...defaults, crossProjectAccess: [{ from: payments, to: spence, addedAt: 1 }] },
        [agent(true)],
        projects,
      );
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(get('settings-permissions').textContent).toContain('payments');
      });
      expect(get('settings-permissions').textContent).toContain('spence');
      click(fixture, 'cross-project-remove-0');
      await expectPatch({ crossProjectAccess: [] });
    });
  });
});
