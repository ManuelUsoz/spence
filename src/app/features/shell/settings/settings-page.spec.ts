import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { toast } from '@ui/toast';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../../shared/agents/agents.rpc';
import { UpdateRpcs } from '../../../../shared/app-info/update.rpc';
import { AppInfoRpcs } from '../../../../shared/app-info/app-info.rpc';
import {
  BROWSER_DEFAULT_WIDTH,
  BrowserError,
  BrowserRpcs,
} from '../../../../shared/browser/browser.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../../shared/projects/projects.rpc';
import {
  DEFAULT_WALLPAPER_ID,
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

// jsdom does not implement the layout APIs used by Helm Select.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof ResizeObserver === 'undefined') {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

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
  browserAllowedOrigins: [],
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
  template: `
    <p data-testid="install-offer-stub">Set up {{ agent().name }}</p>
    <button type="button" data-testid="stub-emit-installed" (click)="installed.emit()"></button>
  `,
})
class InstallOfferStub {
  readonly agent = input.required<Agent>();
  readonly installed = output<void>();
}

let patches: SettingsPatch[] = [];
let updateInstalls = 0;
let clearDataCalls = 0;
let clearDataShouldFail = false;

const handlers = (
  settings: Settings,
  agents: ReadonlyArray<Agent> | (() => ReadonlyArray<Agent>),
  projects: ReadonlyArray<Project> = [],
) =>
  Layer.mergeAll(
    UpdateRpcs.toLayer({
      'Update.check': () => Effect.succeed({ status: 'available', detail: '0.1.1-rc.2' }),
      'Update.install': () =>
        Effect.sync(() => {
          updateInstalls++;
          return true;
        }),
    }),
    BrowserRpcs.toLayer({
      'Browser.getState': ({ sessionId }) =>
        Effect.succeed({
          sessionId,
          open: false,
          width: BROWSER_DEFAULT_WIDTH,
          pages: [],
          activePageId: null,
          control: { _tag: 'idle' },
          pickerActive: false,
          occluded: false,
        }),
      'Browser.setOpen': () => Effect.die('unused'),
      'Browser.setWidth': () => Effect.die('unused'),
      'Browser.setActiveSession': () => Effect.void,
      'Browser.setBounds': () => Effect.void,
      'Browser.setOccluded': () => Effect.void,
      'Browser.navigate': () => Effect.die('unused'),
      'Browser.goBack': () => Effect.die('unused'),
      'Browser.goForward': () => Effect.die('unused'),
      'Browser.reload': () => Effect.die('unused'),
      'Browser.openExternal': () => Effect.die('unused'),
      'Browser.openDevTools': () => Effect.die('unused'),
      'Browser.createPage': () => Effect.die('unused'),
      'Browser.selectPage': () => Effect.die('unused'),
      'Browser.closePage': () => Effect.die('unused'),
      'Browser.captureScreenshot': () => Effect.die('unused'),
      'Browser.startElementPicker': () => Effect.die('unused'),
      'Browser.cancelElementPicker': () => Effect.die('unused'),
      'Browser.getConsoleErrors': () => Effect.die('unused'),
      'Browser.clearData': () =>
        Effect.suspend(() => {
          clearDataCalls += 1;
          return clearDataShouldFail
            ? Effect.fail(new BrowserError({ reason: 'Unavailable', detail: 'clear failed' }))
            : Effect.void;
        }),
      'Browser.takeOver': () => Effect.die('unused'),
      'Browser.continueAgent': () => Effect.die('unused'),
      'Browser.events': () => Stream.empty,
    }),
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

const choose = async (
  fixture: ComponentFixture<SettingsPage>,
  id: string,
  value: string,
): Promise<void> => {
  const trigger = get(id).querySelector<HTMLButtonElement>('button');
  if (trigger === null) throw new Error(`no trigger in ${id}`);
  trigger.click();
  await vi.waitFor(() => {
    fixture.detectChanges();
    const option = [...document.querySelectorAll<HTMLElement>('hlm-select-item')].find(
      (item) => item.dataset['value'] === value,
    );
    if (option === undefined) throw new Error(`no option ${value} in ${id}`);
    option.click();
  });
  fixture.detectChanges();
};

const expectPatch = (patch: SettingsPatch) => vi.waitFor(() => expect(patches).toEqual([patch]));

beforeEach(() => {
  patches = [];
  updateInstalls = 0;
  clearDataCalls = 0;
  clearDataShouldFail = false;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SettingsPage', () => {
  it('opens Projects from Settings and returns to the other sections', async () => {
    const fixture = await open();
    const projects = document.querySelector<HTMLElement>('[data-section="projects"]');
    if (projects === null) throw new Error('Missing Projects section');
    const scroll = vi.fn();
    projects.scrollIntoView = scroll;
    click(fixture, 'settings-nav-projects');
    expect(get('settings-nav-projects').getAttribute('aria-current')).toBe('location');
    expect(scroll).toHaveBeenCalledOnce();
    expect(get('settings-general').closest('[hidden]')).toBeNull();

    get('settings-sessions').scrollIntoView = vi.fn();
    click(fixture, 'settings-nav-sessions');
    expect(get('settings-nav-sessions').getAttribute('aria-current')).toBe('location');
    expect(get('settings-general').closest('[hidden]')).toBeNull();
  });

  it('describes /coordinate and saves the Verifier Model for its selected Agent', async () => {
    const fixture = await open({
      ...defaults,
      coordinator: { verifier: { agentId: claude, model: 'sonnet' } },
    });
    expect(document.querySelector('[data-section="workflows"]')?.textContent).toContain(
      '/coordinate',
    );
    await choose(fixture, 'workflow-model-verifier', 'opus');
    await expectPatch({ coordinator: { verifier: { agentId: claude, model: 'opus' } } });
  });

  it('describes Divide and Conquer and saves its Planner independently of Coordinator', async () => {
    const fixture = await open({
      ...defaults,
      coordinator: { verifier: { agentId: claude, model: 'sonnet' } },
      divideAndConquer: { planner: { agentId: claude, model: 'sonnet' } },
    });
    expect(document.querySelector('[data-section="workflows"]')?.textContent).toContain(
      '/divide-and-conquer',
    );
    await choose(fixture, 'workflow-model-divide-and-conquer-planner', 'opus');
    await expectPatch({ divideAndConquer: { planner: { agentId: claude, model: 'opus' } } });
  });

  it('switches the Theme to Dark', async () => {
    const fixture = await open();
    click(fixture, 'theme-dark');
    await expectPatch({ theme: 'dark' });
  });

  it('picks the Language', async () => {
    const fixture = await open();
    await choose(fixture, 'settings-language', 'es');
    await expectPatch({ language: 'es' });
  });

  it('turns Notifications off', async () => {
    const fixture = await open();
    const label = document.querySelector('label[for="settings-notifications"]');
    expect(label?.textContent?.trim()).toBe('Notify me about background Sessions');
    flip(fixture, 'settings-notifications');
    await expectPatch({ notifications: false });
  });

  it('orders Projects by name, keeping the direction', async () => {
    const fixture = await open();
    await choose(fixture, 'settings-project-order-by', 'name');
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
    await choose(fixture, 'settings-project-order-direction', 'asc');
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
    await choose(fixture, 'agent-claude-model', 'sonnet');
    await expectPatch({ agents: { [claude]: { model: 'sonnet' } } });

    patches = [];
    await choose(fixture, 'agent-claude-model', 'lastUsed');
    await expectPatch({ agents: { [claude]: { model: 'lastUsed' } } });
  });

  it('pins an Agent Effort', async () => {
    const fixture = await open();
    click(fixture, 'agent-claude-configure');
    await choose(fixture, 'agent-claude-effort', 'high');
    await expectPatch({ agents: { [claude]: { effort: 'high' } } });
  });

  it('shows only Last used and a hint for an Agent never run', async () => {
    // Main resolves an entry for every Catalog Agent, run or not.
    const fixture = await open({
      ...defaults,
      agents: { [claude]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: false } },
    });
    click(fixture, 'agent-claude-configure');
    expect(get('agent-claude-model').querySelector('button')?.disabled).toBe(true);
    expect(get('agent-claude-effort').querySelector('button')?.disabled).toBe(true);
    expect(get('agent-claude').textContent).toContain('Start a Session to see its Models');
  });

  it('pins Effort for an Agent that has run but reported no Models', async () => {
    const fixture = await open({
      ...defaults,
      agents: { [claude]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: true } },
    });
    click(fixture, 'agent-claude-configure');
    expect(get('agent-claude').textContent).not.toContain('Start a Session to see its Models');
    await choose(fixture, 'agent-claude-effort', 'max');
    await expectPatch({ agents: { [claude]: { effort: 'max' } } });
  });

  it('embeds the install offer for an Agent that is not installed', async () => {
    await open(defaults, [agent(false)]);
    expect(get('agent-claude-status').textContent).toContain('Not installed');
    expect(byTestId('agent-claude-configure')).toBeNull();
    expect(
      get('agent-claude').querySelector('[data-testid="install-offer-stub"]')?.textContent,
    ).toBe('Set up Claude');
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

  it('checks for an update and confirms before restarting', async () => {
    const fixture = await open();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId('update-check')).not.toBeNull();
    });
    click(fixture, 'update-check');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId('update-restart')).not.toBeNull();
    });
    expect(get('settings-about-section').textContent).toContain('0.1.1-rc.2');
    click(fixture, 'update-restart');
    expect(updateInstalls).toBe(0);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId('update-confirm')).not.toBeNull();
    });
    click(fixture, 'update-confirm');
    await vi.waitFor(() => expect(updateInstalls).toBe(1));
  });

  it('picks the Default Agent (Last used or pinned Agent)', async () => {
    const codex: Agent = { ...agent(true), id: AgentId.make('codex'), name: 'Codex' };
    const fixture = await open(defaults, [agent(true), codex]);

    await choose(fixture, 'settings-default-agent', 'lastUsed');
    await expectPatch({ defaultAgent: 'lastUsed' });

    patches = [];
    await choose(fixture, 'settings-default-agent', 'codex');
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

  it('refreshes Agent status when embedded install offer emits installed and keeps Configure for Model/Effort', async () => {
    let installedNow = false;
    const fixture = await open(defaults, () => [
      {
        ...agent(installedNow),
        ...(installedNow
          ? { installedVersion: '0.106.0', versionQualification: 'qualified' as const }
          : {}),
      },
    ]);
    expect(get('agent-claude-status').textContent).toContain('Not installed');
    expect(byTestId('agent-claude-configure')).toBeNull();

    installedNow = true;
    click(fixture, 'stub-emit-installed');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(get('agent-claude-status').textContent).toContain('Installed');
    });
    expect(byTestId('agent-claude-configure')).not.toBeNull();
    click(fixture, 'agent-claude-configure');
    expect(byTestId('agent-claude-model')).not.toBeNull();
    expect(byTestId('agent-claude-effort')).not.toBeNull();
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
      expect(get('settings-permissions').textContent).toContain(
        'No external Browser origins are always allowed',
      );
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

    it('lists allowed Browser origins and removes an entry', async () => {
      const fixture = await open(
        {
          ...defaults,
          browserAllowedOrigins: ['https://example.com', 'https://docs.angular.dev'],
        },
        [agent(true)],
        projects,
      );
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(get('browser-origin-0').textContent).toContain('https://example.com');
      });
      expect(get('browser-origin-1').textContent).toContain('https://docs.angular.dev');
      click(fixture, 'browser-origin-remove-0');
      await expectPatch({ browserAllowedOrigins: ['https://docs.angular.dev'] });
    });
  });

  describe('Browser', () => {
    it('clears browsing data and shows success or error toast feedback', async () => {
      const toastSuccess = vi.spyOn(toast, 'success');
      const toastError = vi.spyOn(toast, 'error');
      const fixture = await open();

      expect(get('settings-nav-browser').textContent).toContain('Browser');
      click(fixture, 'settings-browser-clear-data');

      await vi.waitFor(() => {
        expect(clearDataCalls).toBe(1);
        expect(toastSuccess).toHaveBeenCalledWith('Browsing data cleared.');
      });

      clearDataShouldFail = true;
      click(fixture, 'settings-browser-clear-data');
      await vi.waitFor(() => {
        expect(clearDataCalls).toBe(2);
        expect(toastError).toHaveBeenCalledWith('Could not clear browsing data.');
      });
    });
  });

  it('configures Chat background mode, gallery selection in same mode, and custom wallpaper upload/removal', async () => {
    const fixture = await open();
    // Solid color is default, so the gallery starts hidden until switched to different/same.
    expect(byTestId('chat-bg-gallery')).toBeNull();

    click(fixture, 'chat-bg-different');
    await expectPatch({ chatBackgroundMode: 'different' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId('chat-bg-gallery')).not.toBeNull();
    });
    expect(document.querySelectorAll('[data-testid="chat-bg-item"]')).toHaveLength(0);
    expect(byTestId('chat-bg-upload')).not.toBeNull();

    patches = [];
    click(fixture, 'chat-bg-same');
    await expectPatch({ chatBackgroundMode: 'same' });

    patches = [];
    click(fixture, 'chat-bg-solid');
    await expectPatch({ chatBackgroundMode: 'solid' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(byTestId('chat-bg-gallery')).toBeNull();
    });

    patches = [];
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    const sameFixture = await open({
      ...defaults,
      chatBackgroundMode: 'same',
      chatBackgroundId: 'cobalt-halftone',
      customWallpapers: [
        { id: 'first', name: 'First', mimeType: 'image/png', data: 'AQID' },
        { id: 'second', name: 'Second', mimeType: 'image/png', data: 'BAUG' },
      ],
    });
    expect(document.querySelectorAll('[data-testid="chat-bg-item"]')).toHaveLength(2);
    expect(
      document
        .querySelector('[data-testid="chat-bg-item"][data-wallpaper-id="first"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    const second = document.querySelector<HTMLButtonElement>(
      '[data-testid="chat-bg-item"][data-wallpaper-id="second"]',
    )!;
    second.click();
    sameFixture.detectChanges();
    await expectPatch({ chatBackgroundId: 'second' });

    patches = [];
    const fileInput = get('chat-bg-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], 'custom-dots.png', {
      type: 'image/png',
    });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    });
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      sameFixture.detectChanges();
      expect(patches).toHaveLength(1);
    });
    const uploaded = patches[0]?.customWallpapers?.[2];
    expect(uploaded?.name).toBe('custom-dots');
    expect(uploaded?.mimeType).toBe('image/png');
    expect(patches[0]?.chatBackgroundId).toBe(uploaded?.id);

    patches = [];
    TestBed.resetTestingModule();
    document.body.innerHTML = '';
    const withCustom = await open({
      ...defaults,
      chatBackgroundMode: 'same',
      chatBackgroundId: uploaded!.id,
      customWallpapers: [uploaded!],
    });
    const removeBtn = document.querySelector<HTMLButtonElement>(
      `[data-testid="chat-bg-remove"][data-wallpaper-id="${uploaded!.id}"]`,
    )!;
    removeBtn.click();
    withCustom.detectChanges();
    await expectPatch({
      customWallpapers: [],
      chatBackgroundId: DEFAULT_WALLPAPER_ID,
    });
  });
});
