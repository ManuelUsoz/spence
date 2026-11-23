import { Injector, inject } from '@angular/core';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, PubSub, Queue, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserEvent,
  BrowserRpcs,
  PageId,
  type BrowserState,
} from '../../../shared/browser/browser.rpc';
import { DevicesRpcs, DeviceId } from '../../../shared/devices/devices.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import {
  SourceControlRpcs,
  type ChangesResult,
} from '../../../shared/source-control/source-control.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type PanelSpec,
  type RestoredWorkspace,
  type TabActivation,
  type WorkspacePanel,
  type WorkspaceState,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, allTabPanels } from '../../../shared/tabs/workspace-layout';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { ChatBackgrounds } from '../../core/chat-backgrounds';
import { BROWSER_PANE_VIEW } from '../../core/browser-pane';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Keymap, KEYMAP_PLATFORM, type KeymapPlatform } from '../../core/keymap';
import { PANEL_DEFINITION, type PanelDefinition } from '../../core/panel-registry';
import { Tabs } from '../../core/tabs';
import { ChangesPage } from '../changes/changes-page';
import { WorkersPanelHost } from '../session/workers-panel';
import { SessionsState } from './sessions-state';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

@Component({
  selector: 'app-session-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="session-view-stub" [attr.data-focused]="focused()">
    {{ panel().id }}
  </div>`,
})
class SessionViewStub {
  readonly panel = input.required<WorkspacePanel>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
}

@Component({
  selector: 'app-notes-panel-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="notes-panel-stub">{{ projectName() }}:{{ panel().id }}</div>`,
})
class NotesPanelStub {
  readonly panel = input.required<WorkspacePanel>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
}

@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

@Component({
  selector: 'app-browser-pane-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="browser-pane-stub">{{ sessionId() }}</div>`,
})
class BrowserPaneStub {
  readonly sessionId = input.required<SessionId>();
}

const p1 = ProjectId.make('p1');
const p2 = ProjectId.make('p2');
const sLocal = SessionId.make('session-local');
const sLocalTwo = SessionId.make('session-local-two');
const sRemote = SessionId.make('session-remote');
const dRemote = DeviceId.make('peer-1');

interface BrowserTestSpy {
  readonly activeSessions: Array<SessionId | null>;
  readonly widths: Array<number>;
  readonly occludedCalls: Array<boolean>;
  readonly states: Map<SessionId, BrowserState>;
  pushEvent?: (event: BrowserEvent) => void;
}

const makeBrowserState = (
  sessionId: SessionId,
  overrides: Partial<BrowserState> = {},
): BrowserState => ({
  sessionId,
  open: false,
  width: BROWSER_DEFAULT_WIDTH,
  pages: [
    {
      id: PageId.make('p-1'),
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      suspended: false,
    },
  ],
  activePageId: PageId.make('p-1'),
  control: { _tag: 'idle' },
  pickerActive: false,
  occluded: false,
  ...overrides,
});

const project1: Project = {
  id: p1,
  name: 'app',
  path: '/work/app',
  addedAt: 1,
  lastUsedAt: 2,
  settings: {},
  folderMissing: false,
};

const project2: Project = {
  id: p2,
  name: 'api',
  path: '/work/api',
  addedAt: 1,
  lastUsedAt: 1,
  settings: {},
  folderMissing: false,
};

const makeRestored = (
  projects: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly tabs: ReadonlyArray<{
      readonly tabId: string;
      readonly paneId: string;
      readonly panelId: string;
      readonly sessionId: SessionId;
      readonly title: string;
    }>;
    readonly activeTabId?: string;
  }>,
  activeProjectId: ProjectId | null,
): RestoredWorkspace => {
  const workspaceProjects = projects.map((project) => {
    const activeTabId =
      project.activeTabId !== undefined
        ? TabId.make(project.activeTabId)
        : project.tabs[0] !== undefined
          ? TabId.make(project.tabs[0].tabId)
          : undefined;
    return {
      projectId: project.projectId,
      ...(activeTabId === undefined ? {} : { activeTabId }),
      tabs: project.tabs.map((t) => {
        const panelId = PanelId.make(t.panelId);
        const paneId = PaneId.make(t.paneId);
        return {
          id: TabId.make(t.tabId),
          focusedPanelId: panelId,
          layout: {
            rootPaneId: paneId,
            nodes: [
              {
                _tag: 'Leaf' as const,
                id: paneId,
                panels: [
                  {
                    id: panelId,
                    spec: { _tag: 'Session' as const, sessionId: t.sessionId },
                  },
                ],
              },
            ],
          },
        };
      }),
    };
  });
  const sessions = projects.flatMap((project) =>
    project.tabs.map((t) => ({
      id: t.sessionId,
      projectId: project.projectId,
      title: { auto: t.title, autoIsPlaceholder: false },
      status: 'idle' as const,
    })),
  );
  return {
    workspace: {
      ...(activeProjectId === null ? {} : { activeProjectId }),
      projects: workspaceProjects,
    },
    sessions,
  };
};

interface DesktopFixtureOptions {
  readonly projects?: ReadonlyArray<Project>;
  readonly sessionsByProject?: Readonly<Record<string, ReadonlyArray<SessionSummary>>>;
  readonly restored?: RestoredWorkspace;
  readonly extraPanels?: ReadonlyArray<PanelDefinition>;
  readonly updates?: Array<WorkspaceState>;
  readonly changesBySession?: (sessionId: SessionId) => ChangesResult;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly activations?: Stream.Stream<TabActivation>;
  readonly browserSpy?: BrowserTestSpy;
}

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
  agents: {},
};

const desktopLayer = (options: DesktopFixtureOptions = {}) => {
  const spy = options.browserSpy;
  const projects = options.projects ?? [project1];
  const sessionsByProject = options.sessionsByProject ?? {};
  const restored = options.restored ?? { workspace: EMPTY_WORKSPACE, sessions: [] };
  return makeDesktopTestLayer(
    Layer.mergeAll(
      BrowserRpcs.toLayer({
        'Browser.getState': ({ sessionId }) =>
          Effect.succeed(spy?.states.get(sessionId) ?? makeBrowserState(sessionId)),
        'Browser.setOpen': ({ sessionId, open }) =>
          Effect.sync(() => {
            const next = makeBrowserState(sessionId, {
              ...(spy?.states.get(sessionId) ?? {}),
              open,
            });
            spy?.states.set(sessionId, next);
            return next;
          }),
        'Browser.setWidth': ({ sessionId, width }) =>
          Effect.sync(() => {
            spy?.widths.push(width);
            const next = makeBrowserState(sessionId, {
              ...(spy?.states.get(sessionId) ?? {}),
              width,
            });
            spy?.states.set(sessionId, next);
            return next;
          }),
        'Browser.setActiveSession': ({ sessionId }) =>
          Effect.sync(() => {
            spy?.activeSessions.push(sessionId);
          }),
        'Browser.setBounds': () => Effect.void,
        'Browser.setOccluded': ({ occluded }) =>
          Effect.sync(() => {
            spy?.occludedCalls.push(occluded);
          }),
        'Browser.navigate': () => Effect.die('unused'),
        'Browser.goBack': () => Effect.die('unused'),
        'Browser.goForward': () => Effect.die('unused'),
        'Browser.reload': () => Effect.die('unused'),
        'Browser.openExternal': () => Effect.die('unused'),
        'Browser.openDevTools': () => Effect.die('unused'),
        // #213: Multi-Page management
        'Browser.createPage': () => Effect.die('unused'),
        'Browser.selectPage': () => Effect.die('unused'),
        'Browser.closePage': () => Effect.die('unused'),
        // #215 Composer bridge
        'Browser.captureScreenshot': () => Effect.die('unused'),
        'Browser.startElementPicker': () => Effect.die('unused'),
        'Browser.cancelElementPicker': () => Effect.die('unused'),
        'Browser.getConsoleErrors': () => Effect.die('unused'),
        // #216: Persistence, LRU & browsing data
        'Browser.clearData': () => Effect.die('unused'),
        'Browser.takeOver': () => Effect.die('unused'),
        'Browser.continueAgent': () => Effect.die('unused'),
        'Browser.events': () =>
          spy === undefined
            ? Stream.empty
            : Stream.unwrap(
                Effect.gen(function* () {
                  const queue = yield* Queue.unbounded<BrowserEvent>();
                  spy.pushEvent = (event) => {
                    Queue.offerUnsafe(queue, event);
                  };
                  return Stream.fromQueue(queue);
                }),
              ),
      }),
      AppInfoRpcs.toLayer({
        'AppInfo.get': () =>
          Effect.succeed({
            name: 'Spence',
            version: '0.1.0',
            electron: '0',
            chrome: '0',
            node: '0',
            platform: 'win32',
            cwd: '/work',
          }),
      }),
      SettingsRpcs.toLayer({
        'Settings.get': () => Effect.succeed(defaults),
        'Settings.update': () => Effect.succeed(defaults),
      }),
      AgentsRpcs.toLayer({
        'Agents.list': () => Effect.succeed([]),
        'Agents.installCommand': () => Effect.die('unused'),
        'Agents.install': () => Effect.die('unused'),
        'Agents.openInstallLog': () => Effect.die('unused'),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([...projects]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.addFolder': () => Effect.die('unused'),
        'Projects.locateFolder': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      DevicesRpcs.toLayer({
        'Devices.local': () => Effect.die('unused'),
        'Devices.rename': () => Effect.die('unused'),
        'Devices.setHosting': () => Effect.die('unused'),
        'Devices.watch': () => Stream.empty,
        'Devices.nearby': () => Stream.empty,
        'Devices.startPairing': () => Effect.die('unused'),
        'Devices.cancelPairing': () => Effect.die('unused'),
        'Devices.pair': () => Effect.die('unused'),
        'Devices.check': () => Effect.die('unused'),
        'Devices.connections': () =>
          Stream.concat(
            Stream.make([
              {
                id: dRemote,
                name: 'Peer Mac',
                status: { _tag: 'Online', name: 'Peer Mac' },
                address: '10.0.0.2:4444',
                unpairedByOther: false,
                allowAgents: false,
              },
            ]),
            Stream.never,
          ),
        'Devices.connect': () => Effect.die('unused'),
        'Devices.unpair': () => Effect.die('unused'),
        'Devices.viewers': () => Stream.concat(Stream.make([]), Stream.never),
        'Devices.disconnect': () => Effect.die('unused'),
        'Devices.setAllowAgents': () => Effect.die('unused'),
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed(restored),
        'Tabs.update': ({ workspace }) =>
          Effect.sync(() => {
            options.updates?.push(workspace);
          }),
        'Tabs.activations': () => options.activations ?? Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => options.changes ?? Stream.empty,
        'Session.list': ({ projectId }) =>
          Effect.succeed([...(sessionsByProject[projectId] ?? [])]),
        'Session.create': () => Effect.die('unused'),
        'Session.setAgent': () => Effect.die('unused'),
        'Session.prompt': () => Effect.die('unused'),
        'Session.steer': () => Effect.die('unused'),
        'Session.enqueue': () => Effect.die('unused'),
        'Session.setQueue': () => Effect.die('unused'),
        'Session.clearQueue': () => Effect.die('unused'),
        'Session.cancel': () => Effect.die('unused'),
        'Session.stopAgent': () => Effect.die('unused'),
        'Session.answerPermission': () => Effect.die('unused'),
        'Session.setOption': () => Effect.die('unused'),
        'Session.clearContext': () => Effect.die('unused'),
        'Session.compact': () => Effect.die('unused'),
        'Session.startEmptyContext': () => Effect.die('unused'),
        'Session.prepareHandoff': () => Effect.die('unused'),
        'Session.revalidateHandoff': () => Effect.die('unused'),
        'Session.executeHandoff': () => Effect.die('unused'),
        'Session.listHandoffAttempts': () => Effect.die('unused'),
        'Session.events': () => Stream.empty,
        'Session.getComposer': () => Effect.die('unused'),
        'Session.setComposer': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.die('unused'),
        'Session.loginAgent': () => Effect.die('unused'),
        'Session.openAgentLog': () => Effect.die('unused'),
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.succeed(0),
        'Session.delete': () => Effect.void,
      }),
      SourceControlRpcs.toLayer({
        'SourceControl.changes': ({ sessionId }) =>
          Effect.succeed(
            options.changesBySession?.(sessionId) ?? {
              _tag: 'Unavailable',
              reason: 'NonGit',
              detail: 'not git',
            },
          ),
        'SourceControl.diff': () => Effect.die('unused'),
        'SourceControl.commitDetail': () => Effect.die('unused'),
        'SourceControl.commitDiff': () => Effect.die('unused'),
        'SourceControl.commits': () =>
          Effect.succeed({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not git' }),
        'SourceControl.commit': () => Effect.die('unused'),
        'SourceControl.prepareDiscard': () => Effect.die('unused'),
        'SourceControl.discard': () => Effect.die('unused'),
        'SourceControl.revert': () => Effect.die('unused'),
        'SourceControl.branches': () => Effect.die('unused'),
        'SourceControl.fetch': () => Effect.die('unused'),
        'SourceControl.pull': () => Effect.die('unused'),
        'SourceControl.push': () => Effect.die('unused'),
      }),
    ),
  );
};

const sessionPanelDef: PanelDefinition = {
  kind: 'Session',
  component: SessionViewStub,
};

const createChangesPanelDef = (): PanelDefinition => {
  const injector = inject(Injector);
  return {
    kind: 'Changes',
    component: ChangesPage,
    defaultTitle: 'Changes',
    headerMeta: () => ({ title: 'Changes', untitled: false }),
    inputs: (context) => {
      const sessionId =
        context.panel.spec._tag === 'Changes' ? context.panel.spec.sessionId : undefined;
      const tabs = injector.get(Tabs);
      return {
        sessionId,
        running:
          sessionId !== undefined &&
          (tabs.liveState(sessionId)?.runningTurn !== undefined ||
            tabs.sessionStatus(sessionId)?.status === 'working'),
      };
    },
  };
};

const workersPanelDef: PanelDefinition = {
  kind: 'Workers',
  component: WorkersPanelHost,
  defaultTitle: 'Workers',
  headerMeta: () => ({ title: 'Workers', untitled: false }),
  inputs: (context) => ({
    panel: context.panel,
    paneId: context.paneId ?? null,
    projectId: context.projectId,
  }),
};

const mountShell = async (
  platform: KeymapPlatform = 'other',
  options: DesktopFixtureOptions = {},
): Promise<{ readonly fixture: ComponentFixture<Shell>; readonly tabs: Tabs }> => {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DESKTOP_LAYER, useValue: desktopLayer(options) },
      { provide: KEYMAP_PLATFORM, useValue: platform },
      { provide: BROWSER_PANE_VIEW, useValue: BrowserPaneStub },
      { provide: PANEL_DEFINITION, multi: true, useValue: sessionPanelDef },
      { provide: PANEL_DEFINITION, multi: true, useFactory: createChangesPanelDef },
      { provide: PANEL_DEFINITION, multi: true, useValue: workersPanelDef },
      ...(options.extraPanels ?? []).map((def) => ({
        provide: PANEL_DEFINITION,
        multi: true,
        useValue: def,
      })),
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  const fixture = TestBed.createComponent(Shell);
  const tabs = TestBed.inject(Tabs);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(tabs.restored()).toBe(true);
  });
  return { fixture, tabs };
};

const dispatchKey = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Shell keyboard shortcuts', () => {
  it('opens Settings on Mod+, and leaves Mod+F free', async () => {
    const { fixture } = await mountShell('other');
    const settings = TestBed.inject(SettingsState);

    const findEvent = dispatchKey({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(findEvent.defaultPrevented).toBe(false);

    const settingsEvent = dispatchKey({ key: ',', code: 'Comma', ctrlKey: true });
    fixture.detectChanges();
    expect(settingsEvent.defaultPrevented).toBe(true);
    expect(settings.open()).toBe(true);
  });

  it('cycles, jumps, opens, and closes active Project Tabs via keyboard shortcuts and honors modal suspension', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const s3 = SessionId.make('s3');
    const s4 = SessionId.make('s4');
    const { fixture, tabs } = await mountShell('other', {
      projects: [project1, project2],
      restored: makeRestored(
        [
          {
            projectId: p1,
            activeTabId: 't1',
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
              { tabId: 't2', paneId: 'pane2', panelId: 'panel2', sessionId: s2, title: 'Two' },
              { tabId: 't3', paneId: 'pane3', panelId: 'panel3', sessionId: s3, title: 'Three' },
            ],
          },
          {
            projectId: p2,
            activeTabId: 't4',
            tabs: [
              { tabId: 't4', paneId: 'pane4', panelId: 'panel4', sessionId: s4, title: 'Four' },
            ],
          },
        ],
        p1,
      ),
    });

    // Holding Ctrl and tapping Tab opens Windows-style MRU TabSwitcher overlay; Ctrl release commits.
    const host = fixture.nativeElement as HTMLElement;
    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="tab-switcher"]')).not.toBeNull();
    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="tab-switcher-card"]')];
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.getAttribute('data-tab-id'))).toEqual(['t1', 't2', 't3']);
    expect(cards[1]?.getAttribute('aria-selected')).toBe('true');

    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true });
    fixture.detectChanges();
    expect(cards[2]?.getAttribute('aria-selected')).toBe('true');

    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    fixture.detectChanges();
    expect(cards[1]?.getAttribute('aria-selected')).toBe('true');

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control', bubbles: true }));
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="tab-switcher"]')).toBeNull();
    expect(tabs.activeTab()?.id).toBe('t2');

    // Escape cancels switcher without changing active Tab; MRU puts newly active t2 first next time.
    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true });
    fixture.detectChanges();
    const mruCards = [...host.querySelectorAll<HTMLElement>('[data-testid="tab-switcher-card"]')];
    expect(mruCards.map((c) => c.getAttribute('data-tab-id'))).toEqual(['t2', 't1', 't3']);
    dispatchKey({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="tab-switcher"]')).toBeNull();
    expect(tabs.activeTab()?.id).toBe('t2');

    dispatchKey({ key: '9', code: 'Digit9', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe('t3');

    dispatchKey({ key: '2', code: 'Digit2', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe('t2');

    const newTabEvent = dispatchKey({ key: 't', code: 'KeyT', ctrlKey: true });
    fixture.detectChanges();
    expect(newTabEvent.defaultPrevented).toBe(true);
    expect(tabs.tabs()).toHaveLength(4);
    expect(tabs.activeTab()?.layout.nodes[0]?._tag).toBe('Leaf');

    const closeEvent = dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(closeEvent.defaultPrevented).toBe(true);
    expect(tabs.tabs()).toHaveLength(3);
    expect(
      tabs.allTabs().filter((tab) => !tabs.tabs().some((active) => active.id === tab.id)),
    ).toHaveLength(1);

    const keymap = TestBed.inject(Keymap);
    const releaseModal = keymap.pushModal();
    const blocked = dispatchKey({ key: 't', code: 'KeyT', ctrlKey: true });
    fixture.detectChanges();
    expect(blocked.defaultPrevented).toBe(false);
    expect(tabs.tabs()).toHaveLength(3);
    releaseModal();
  });
});

describe('Shell workspace layout, Panel registry, and Settings isolation', () => {
  it('renders EmptyWorkspace and TabStrip when active Project has 0 Tabs, and opens a Tab with PaneView & PanelHeader from CTA', async () => {
    const { fixture, tabs } = await mountShell('other');
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-testid="tab-strip"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-view-stub"]')).toBeNull();
    expect(host.querySelector('app-top-bar')).toBeNull();

    (host.querySelector('[data-testid="empty-new-tab"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(tabs.tabs()).toHaveLength(1);
    expect(host.querySelector('[data-testid="empty-workspace"]')).toBeNull();
    expect(host.querySelector('app-top-bar')).toBeNull();
    expect(host.querySelector('[data-testid="pane-view"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="panel-frame"]')?.getAttribute('data-focused')).toBe(
      'true',
    );
    expect(host.querySelector('[data-testid="panel-title"]')?.textContent?.trim()).toBe(
      'New Session',
    );
    expect(host.querySelector('[data-testid="session-wallpaper"]')).toBeNull();
    expect(host.querySelector('[data-testid="panel-close"]')).toBeNull();

    // Closing the 1-Pane draft Tab via tab-close returns to EmptyWorkspace.
    (host.querySelector('[data-testid="tab-close"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
  });

  it('renders custom Panel types registered via PANEL_DEFINITION without modifying Tab/Pane code', async () => {
    const notesPanelId = PanelId.make('panel-notes');
    const notesPaneId = PaneId.make('pane-notes');
    const notesTabId = TabId.make('tab-notes');

    const { fixture, tabs } = await mountShell('other', {
      extraPanels: [
        {
          kind: 'Notes',
          component: NotesPanelStub,
          defaultTitle: 'Scratchpad',
          headerMeta: (ctx) => ({ title: `Notes · ${ctx.projectName}` }),
        },
      ],
      restored: {
        workspace: {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: notesTabId,
              tabs: [
                {
                  id: notesTabId,
                  focusedPanelId: notesPanelId,
                  layout: {
                    rootPaneId: notesPaneId,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: notesPaneId,
                        panels: [
                          {
                            id: notesPanelId,
                            spec: { _tag: 'Notes' } as unknown as PanelSpec,
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        sessions: [],
      },
    });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('app-top-bar')).toBeNull();
    expect(host.querySelector('[data-testid="panel-title"]')?.textContent?.trim()).toBe(
      'Notes · app',
    );
    expect(host.querySelector('[data-testid="notes-panel-stub"]')?.textContent?.trim()).toBe(
      'app:panel-notes',
    );
    expect(host.querySelector('[data-testid="session-actions-trigger"]')).toBeNull();

    (host.querySelector('[data-testid="panel-close"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
  });

  it('renders split Panes with independent headers, updates focus when clicking an unfocused PanelFrame, and closes one via panel-close', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const panel1 = PanelId.make('panel-1');
    const panel2 = PanelId.make('panel-2');
    const splitId = PaneId.make('split-1');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const tab1 = TabId.make('tab-1');

    const { fixture, tabs } = await mountShell('other', {
      restored: {
        workspace: {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: tab1,
              tabs: [
                {
                  id: tab1,
                  focusedPanelId: panel1,
                  layout: {
                    rootPaneId: splitId,
                    nodes: [
                      {
                        _tag: 'Split',
                        id: splitId,
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: pane1,
                        second: pane2,
                      },
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [{ id: panel1, spec: { _tag: 'Session', sessionId: s1 } }],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane2,
                        panels: [{ id: panel2, spec: { _tag: 'Session', sessionId: s2 } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        sessions: [
          { id: s1, projectId: p1, title: { auto: 'First', autoIsPlaceholder: false }, status: 'idle' },
          { id: s2, projectId: p1, title: { auto: 'Second', autoIsPlaceholder: false }, status: 'idle' },
        ],
      },
    });
    const host = fixture.nativeElement as HTMLElement;

    const frames = [...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')];
    expect(frames).toHaveLength(2);
    expect(frames.map((el) => el.getAttribute('data-focused'))).toEqual(['true', 'false']);
    expect(
      [...host.querySelectorAll('[data-testid="panel-title"]')].map((el) => el.textContent?.trim()),
    ).toEqual(['First', 'Second']);

    // Clicking inside the second PanelFrame focuses it.
    frames[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fixture.detectChanges();
    expect(tabs.focusedPanel()?.id).toBe(panel2);
    expect(
      [...host.querySelectorAll('[data-testid="panel-frame"]')].map((el) =>
        el.getAttribute('data-focused'),
      ),
    ).toEqual(['false', 'true']);

    // Closing the first Panel keeps the Tab open with the second Panel as a 1-Pane Tab.
    frames[0]!.querySelector<HTMLButtonElement>('[data-testid="panel-close"]')!.click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="panel-frame"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="panel-title"]')?.textContent?.trim()).toBe('Second');
    expect(host.querySelector('[data-testid="panel-close"]')).toBeNull();
  });

  it('opens full-Tab Changes and Workers overlays, re-binds via @ui/select, exits via Back or Esc, and splits Workers into the Tab', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const w1 = SessionId.make('worker-1');
    const summary = (id: SessionId, title: string): SessionSummary => ({
      id,
      agentId: AgentId.make('claude'),
      title: { auto: title, autoIsPlaceholder: false },
      lastActivityAt: Date.now(),
      status: 'idle',
    });
    const liveWithWorkers = (workers: LiveState['workers']): LiveState => ({
      agentStatus: 'ready',
      status: 'idle',
      title: { auto: 'One', autoIsPlaceholder: false },
      options: { permissionMode: 'auto' },
      commands: [],
      commandsLoaded: true,
      queue: [],
      canAttachImages: false,
      imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
      ...(workers === undefined ? {} : { workers }),
    });

    const { fixture, tabs } = await mountShell('other', {
      sessionsByProject: { [p1]: [summary(s1, 'One'), summary(s2, 'Two')] },
      changesBySession: (sid) => ({
        _tag: 'Available',
        head: { _tag: 'Branch', branch: sid === s1 ? 'feat/one' : 'feat/two' },
        integration: 'None',
        files: [],
        excludedCount: 0,
        remotes: [],
      }),
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="session-row"]')).toHaveLength(2);
    });
    tabs.applyLive(s1, liveWithWorkers([{ sessionId: w1, title: 'Worker One', state: 'running' }]));
    fixture.detectChanges();

    // Open Changes from Session Panel header -> shows full-Tab overlay leaving underlying Pane intact.
    expect(host.querySelector('[data-testid="open-workers-count"]')?.textContent?.trim()).toBe('1');
    host.querySelector<HTMLButtonElement>('[data-testid="open-changes"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="changes-head"]')?.textContent).toContain('feat/one');
    });
    expect(host.querySelector('[data-testid="tab-overlay-header"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="tab-overlay-title"]')?.textContent).toContain(
      'Changes',
    );
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="panel-bound-session"]')?.textContent?.trim()).toBe(
      'One',
    );

    // Re-bind the full-Tab Changes overlay to s2 via @ui/select -> updates ChangesPage to feat/two.
    host.querySelector<HTMLButtonElement>('[data-testid="panel-session-picker"] button')!.click();
    fixture.detectChanges();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLElement>('hlm-select-item')]
      .find((item) => item.textContent?.trim() === 'Two')!
      .click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="changes-head"]')?.textContent).toContain('feat/two');
    });
    expect(host.querySelector('[data-testid="panel-bound-session"]')?.textContent?.trim()).toBe(
      'Two',
    );

    // Clicking Back exits overlay back to underlying Panes.
    host.querySelector<HTMLButtonElement>('[data-testid="tab-overlay-back"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="tab-overlay-header"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);

    // Open Workers -> Esc exits overlay; open again and click Worker row -> dismisses overlay & splits w1 side-by-side!
    host.querySelector<HTMLButtonElement>('[data-testid="open-workers"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="workers-panel"]')).not.toBeNull();
    });
    dispatchKey({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="workers-panel"]')).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-testid="open-workers"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="worker-row"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>('[data-testid="worker-row"]')!.click();
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="tab-overlay-header"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);
    expect(tabs.active()?.session).toBe(w1);

    // Deleting s1 collapses Pane back to 1-up w1 cleanly.
    const sessionsState = TestBed.inject(SessionsState);
    await sessionsState.delete([{ id: s1, title: 'One' }]);
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-action"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);
    });
    expect(tabs.active()?.session).toBe(w1);
  });

  it('prunes open Worker descendant Panels and their pinned auxiliary Panels when deleting a Parent Session', async () => {
    const s1 = SessionId.make('parent-s1');
    const w1 = SessionId.make('worker-w1');
    const w2 = SessionId.make('worker-w2');
    const s2 = SessionId.make('unrelated-s2');
    const t1 = TabId.make('t1');
    const t2 = TabId.make('t2');
    const pane1 = PaneId.make('pane1');
    const pane2 = PaneId.make('pane2');
    const pane3 = PaneId.make('pane3');
    const pane4 = PaneId.make('pane4');
    const splitRoot = PaneId.make('split-root');
    const splitLeft = PaneId.make('split-left');
    const splitRight = PaneId.make('split-right');
    const updates: WorkspaceState[] = [];

    const { fixture, tabs } = await mountShell('other', {
      updates,
      restored: {
        workspace: {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: t1,
              tabs: [
                {
                  id: t1,
                  focusedPanelId: PanelId.make('panel-s1'),
                  layout: {
                    rootPaneId: splitRoot,
                    nodes: [
                      {
                        _tag: 'Split',
                        id: splitRoot,
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: splitLeft,
                        second: splitRight,
                      },
                      {
                        _tag: 'Split',
                        id: splitLeft,
                        direction: 'vertical',
                        ratio: 0.5,
                        first: pane1,
                        second: pane2,
                      },
                      {
                        _tag: 'Split',
                        id: splitRight,
                        direction: 'vertical',
                        ratio: 0.5,
                        first: pane3,
                        second: pane4,
                      },
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [
                          {
                            id: PanelId.make('panel-s1'),
                            spec: { _tag: 'Session', sessionId: s1 },
                          },
                        ],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane2,
                        panels: [
                          {
                            id: PanelId.make('panel-w1'),
                            spec: { _tag: 'Session', sessionId: w1 },
                          },
                        ],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane3,
                        panels: [
                          {
                            id: PanelId.make('panel-w2'),
                            spec: { _tag: 'Session', sessionId: w2 },
                          },
                        ],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane4,
                        panels: [
                          {
                            id: PanelId.make('panel-w3'),
                            spec: { _tag: 'Session', sessionId: SessionId.make('worker-w3') },
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  id: t2,
                  focusedPanelId: PanelId.make('panel-s2'),
                  layout: {
                    rootPaneId: PaneId.make('pane-s2'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-s2'),
                        panels: [
                          {
                            id: PanelId.make('panel-s2'),
                            spec: { _tag: 'Session', sessionId: s2 },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        sessions: [
          { id: s1, projectId: p1, title: { auto: 'Parent', autoIsPlaceholder: false }, status: 'idle' },
          { id: w1, projectId: p1, title: { auto: 'Child Worker', autoIsPlaceholder: false }, status: 'idle' },
          { id: w2, projectId: p1, title: { auto: 'Grandchild Worker', autoIsPlaceholder: false }, status: 'idle' },
          {
            id: SessionId.make('worker-w3'),
            projectId: p1,
            title: { auto: 'Second Child Worker', autoIsPlaceholder: false },
            status: 'idle',
          },
          { id: s2, projectId: p1, title: { auto: 'Unrelated', autoIsPlaceholder: false }, status: 'idle' },
        ],
      },
    });
    const host = fixture.nativeElement as HTMLElement;

    const workerLive = (parentSessionId: SessionId): LiveState => ({
      agentStatus: 'ready',
      status: 'idle',
      title: { auto: 'Worker', autoIsPlaceholder: false },
      options: { permissionMode: 'auto' },
      commands: [],
      commandsLoaded: true,
      queue: [],
      canAttachImages: false,
      imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
      parentSessionId,
    });
    tabs.applyLive(w1, workerLive(s1));
    tabs.applyLive(w2, workerLive(w1));
    tabs.applyLive(SessionId.make('worker-w3'), workerLive(s1));
    fixture.detectChanges();

    const updatesBeforeDelete = updates.length;
    const sessionsState = TestBed.inject(SessionsState);
    await sessionsState.delete([{ id: s1, title: 'Parent' }]);
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-action"]')!.click();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tabs.isOpen(s1)).toBe(false);
      expect(tabs.isOpen(w1)).toBe(false);
      expect(tabs.isOpen(w2)).toBe(false);
    });
    expect(tabs.tabs().map((t) => t.id)).toEqual([t2]);
    expect(tabs.active()?.session).toBe(s2);
    expect(host.querySelectorAll('[data-testid="panel-frame"]')).toHaveLength(1);
    expect(updates.length).toBeGreaterThan(updatesBeforeDelete);
    const lastWorkspace = updates.at(-1)!;
    const remainingIds = lastWorkspace.projects.flatMap((p) =>
      p.tabs.flatMap((t) => allTabPanels(t).map((panel) => panel.spec.sessionId)),
    );
    expect(remainingIds).toEqual([s2]);
  });

  it('renders a minimal header with sidebar trigger and router-outlet instead of EmptyWorkspace or TabStrip when no Projects exist', async () => {
    const { fixture } = await mountShell('other', { projects: [] });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('app-top-bar')).toBeNull();
    expect(host.querySelector('[data-testid="tab-strip"]')).toBeNull();
    expect(host.querySelector('[data-testid="empty-workspace"]')).toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
  });

  it('keeps Settings outside Tabs with sidebar trigger, back button, and live notice, and closes cleanly on Tab activation', async () => {
    const s1 = SessionId.make('s1');
    const { fixture, tabs } = await mountShell('other', {
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;
    const settings = TestBed.inject(SettingsState);

    settings.show();
    fixture.detectChanges();
    expect(host.querySelector('app-top-bar')).toBeNull();
    expect(host.querySelector('app-settings-page')).not.toBeNull();
    expect(host.querySelector('[data-testid="tab-strip"]')).toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-back"]')).not.toBeNull();
    expect(host.textContent).toContain('Settings');
    expect(host.textContent).toContain('Changes apply at once');

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(1);

    (host.querySelector('[data-testid="settings-back"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(settings.open()).toBe(false);
    expect(host.querySelector('[data-testid="tab-strip"]')).not.toBeNull();

    settings.show();
    fixture.detectChanges();
    const firstTab = tabs.tabs()[0];
    expect(firstTab).toBeDefined();
    if (firstTab !== undefined) tabs.activateTab(firstTab.id);
    fixture.detectChanges();
    expect(settings.open()).toBe(false);
    expect(host.querySelector('[data-testid="tab-strip"]')).not.toBeNull();
    expect(tabs.tabs()).toHaveLength(1);
  });

  it('dismisses Settings on Mod+1..9 targeting the already-active Tab without mutating the layout', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const updates: WorkspaceState[] = [];
    const { fixture, tabs } = await mountShell('other', {
      updates,
      restored: makeRestored(
        [
          {
            projectId: p1,
            activeTabId: 't1',
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
              { tabId: 't2', paneId: 'pane2', panelId: 'panel2', sessionId: s2, title: 'Two' },
            ],
          },
        ],
        p1,
      ),
    });
    const settings = TestBed.inject(SettingsState);

    dispatchKey({ key: ',', code: 'Comma', ctrlKey: true });
    fixture.detectChanges();
    expect(settings.open()).toBe(true);

    const beforeWorkspace = tabs.workspace();
    const updatesBefore = updates.length;
    const mod1 = dispatchKey({ key: '1', code: 'Digit1', ctrlKey: true });
    fixture.detectChanges();
    expect(mod1.defaultPrevented).toBe(true);
    expect(settings.open()).toBe(false);
    expect(tabs.activeTab()?.id).toBe('t1');
    expect(tabs.workspace()).toEqual(beforeWorkspace);
    expect(updates.length).toBe(updatesBefore);

    // Also test Mod+9 when the last Tab is already active while Settings is open.
    tabs.activateIndex(1);
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe('t2');
    dispatchKey({ key: ',', code: 'Comma', ctrlKey: true });
    fixture.detectChanges();
    expect(settings.open()).toBe(true);

    const beforeMod9Workspace = tabs.workspace();
    const updatesBeforeMod9 = updates.length;
    const mod9 = dispatchKey({ key: '9', code: 'Digit9', ctrlKey: true });
    fixture.detectChanges();
    expect(mod9.defaultPrevented).toBe(true);
    expect(settings.open()).toBe(false);
    expect(tabs.activeTab()?.id).toBe('t2');
    expect(tabs.workspace()).toEqual(beforeMod9Workspace);
    expect(updates.length).toBe(updatesBeforeMod9);
  });

  it('omits Panel stacks and renders session-wallpaper in Session Panes according to ChatBackgrounds mode', async () => {
    const s1 = SessionId.make('s1');
    const { fixture, tabs } = await mountShell('other', {
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'Primary' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('[data-testid="stack-resize-divider"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-testid="panel-collapse-toggle"]')).toHaveLength(0);
    // Solid color is default: no session-wallpaper rendered until switched to 'different' or 'same'.
    expect(host.querySelector('[data-testid="session-wallpaper"]')).toBeNull();

    TestBed.inject(ChatBackgrounds).applySettings({ chatBackgroundMode: 'different' });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="session-wallpaper"]')).not.toBeNull();

    TestBed.inject(ChatBackgrounds).applySettings({ chatBackgroundMode: 'solid' });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="session-wallpaper"]')).toBeNull();

    TestBed.inject(ChatBackgrounds).applySettings({
      chatBackgroundMode: 'same',
      chatBackgroundId: 'amber-halftone',
    });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="session-wallpaper"]')).not.toBeNull();
    expect(tabs.panelWallpaper(tabs.focusedPanel()!)?.id).toBe('amber-halftone');
  });
});

describe('Shell binary split Panes, 4-Pane cap, resizing, and focus/close collapsing', () => {
  it('splits Panes from 1-up -> side-by-side -> 1+2 -> 2x2 via PanelHeader, caps at 4 Panes, and collapses on focus + Mod+W', async () => {
    const s1 = SessionId.make('s1');
    const { fixture, tabs } = await mountShell('other', {
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="pane-resize-divider"]')).toHaveLength(0);

    // 1-up -> side-by-side via Split right.
    host.querySelector<HTMLButtonElement>('[data-testid="panel-split-trigger"]')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-right"]')!.click();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);
    const rootSplit = host.querySelector<HTMLElement>('[data-testid="pane-split"]')!;
    expect(rootSplit.classList.contains('flex-row')).toBe(true);
    const branches = [...host.querySelectorAll<HTMLElement>('[data-testid="pane-branch"]')];
    expect(branches).toHaveLength(2);
    expect(branches[0]!.classList.contains('min-w-[220px]')).toBe(true);
    expect(branches[0]!.style.flexGrow).toBe('0.5');
    expect(branches[1]!.style.flexGrow).toBe('0.5');
    const firstDivider = host.querySelector<HTMLElement>('[data-testid="pane-resize-divider"]')!;
    expect(firstDivider.getAttribute('role')).toBe('separator');
    expect(firstDivider.getAttribute('aria-orientation')).toBe('vertical');

    const twoFrames = [...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')];
    expect(twoFrames.map((el) => el.getAttribute('data-focused'))).toEqual(['false', 'true']);

    // Side-by-side -> 1+2 via Split down on the second Pane.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-split-trigger"]')[1]!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-down"]')!.click();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(3);
    const splitsAfter3 = [...host.querySelectorAll<HTMLElement>('[data-testid="pane-split"]')];
    expect(splitsAfter3.some((el) => el.classList.contains('flex-col'))).toBe(true);
    const dividersAfter3 = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="pane-resize-divider"]'),
    ];
    expect(dividersAfter3.map((el) => el.getAttribute('aria-orientation'))).toEqual([
      'vertical',
      'horizontal',
    ]);
    const verticalBranches = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="pane-branch"]'),
    ].filter((el) => el.classList.contains('min-h-[140px]'));
    expect(verticalBranches).toHaveLength(2);

    // 1+2 -> 2x2 via Split down on the first Pane.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-split-trigger"]')[0]!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-down"]')!.click();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(4);
    expect(host.querySelectorAll('[data-testid="pane-resize-divider"]')).toHaveLength(3);

    // At 4 Panes, Split right and Split down are disabled with clear disabled reason.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-split-trigger"]')[0]!.click();
    fixture.detectChanges();
    const splitRight = document.querySelector<HTMLButtonElement>(
      '[data-testid="panel-split-right"]',
    )!;
    const splitDown = document.querySelector<HTMLButtonElement>(
      '[data-testid="panel-split-down"]',
    )!;
    expect(splitRight.disabled).toBe(true);
    expect(splitDown.disabled).toBe(true);
    expect(document.body.textContent).toContain('Up to 4 Panes per Tab');
    splitRight.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(4);
    dispatchKey({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();

    // Clicking inside the first Pane focuses it, and Mod+W closes only the focused Panel & collapses its Pane.
    const framesAt4 = [...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')];
    framesAt4[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    fixture.detectChanges();
    expect(tabs.focusedPanel()?.id).toBe(PanelId.make('panel1'));
    expect(
      [...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')].map((el) =>
        el.getAttribute('data-focused'),
      ),
    ).toEqual(['true', 'false', 'false', 'false']);

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(3);
    expect(host.querySelectorAll('[data-testid="pane-resize-divider"]')).toHaveLength(2);
    expect(tabs.isOpen(s1)).toBe(false);

    // Closing remaining 3 Panes with Mod+W collapses the Tab and shows EmptyWorkspace.
    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="pane-resize-divider"]')).toHaveLength(0);

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
  });

  it('resizes split Panes by pointer drag and keyboard arrows with ratio and minimum-size clamping, persisting via Tabs.update', async () => {
    const pointerEvent = (
      type: string,
      init: { readonly clientX?: number; readonly clientY?: number; readonly button?: number },
    ): Event => {
      const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      return new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
    };

    const s1 = SessionId.make('s1');
    const updates: WorkspaceState[] = [];
    const { fixture, tabs } = await mountShell('other', {
      updates,
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'One' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;

    // Create a horizontal split (2 Panes).
    host.querySelector<HTMLButtonElement>('[data-testid="panel-split-trigger"]')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-right"]')!.click();
    fixture.detectChanges();

    const splitEl = host.querySelector<HTMLElement>('[data-testid="pane-split"]')!;
    const divider = host.querySelector<HTMLElement>('[data-testid="pane-resize-divider"]')!;
    const setRect = (el: HTMLElement, rect: Partial<DOMRect>) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: rect.left ?? 0,
        y: rect.top ?? 0,
        left: rect.left ?? 0,
        top: rect.top ?? 0,
        right: (rect.left ?? 0) + (rect.width ?? 0),
        bottom: (rect.top ?? 0) + (rect.height ?? 0),
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        toJSON: () => ({}),
      });
    };

    // Container width 1000px -> 220px min width clamps ratio to [0.22, 0.78].
    setRect(splitEl, { left: 100, width: 1000, top: 0, height: 600 });
    const updatesBeforeDrag = updates.length;

    divider.dispatchEvent(pointerEvent('pointerdown', { clientX: 600 }));
    divider.dispatchEvent(pointerEvent('pointermove', { clientX: 700 }));
    fixture.detectChanges();
    const branches = [...host.querySelectorAll<HTMLElement>('[data-testid="pane-branch"]')];
    expect(Number(branches[0]!.style.flexGrow)).toBeCloseTo(0.6, 4);
    expect(Number(branches[1]!.style.flexGrow)).toBeCloseTo(0.4, 4);
    // Live drag does not spam Tabs.update before pointerup.
    expect(updates.length).toBe(updatesBeforeDrag);

    divider.dispatchEvent(pointerEvent('pointerup', { clientX: 700 }));
    fixture.detectChanges();
    expect(updates.length).toBe(updatesBeforeDrag + 1);
    const rootId = tabs.activeTab()!.layout.rootPaneId;
    const rootAfterDrag = tabs.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(rootAfterDrag?._tag === 'Split' ? rootAfterDrag.ratio : null).toBeCloseTo(0.6, 4);
    expect(divider.getAttribute('aria-valuenow')).toBe('60');

    // Dragging below 220px minimum clamps to 0.22.
    divider.dispatchEvent(pointerEvent('pointerdown', { clientX: 700 }));
    divider.dispatchEvent(pointerEvent('pointermove', { clientX: 120 }));
    divider.dispatchEvent(pointerEvent('pointerup', { clientX: 120 }));
    fixture.detectChanges();
    const rootMinPx = tabs.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(rootMinPx?._tag === 'Split' ? rootMinPx.ratio : null).toBeCloseTo(0.22, 4);

    // Wider container (2000px) clamps to [0.15, 0.85].
    setRect(splitEl, { left: 0, width: 2000, top: 0, height: 600 });
    divider.dispatchEvent(pointerEvent('pointerdown', { clientX: 500 }));
    divider.dispatchEvent(pointerEvent('pointermove', { clientX: 50 }));
    divider.dispatchEvent(pointerEvent('pointerup', { clientX: 50 }));
    fixture.detectChanges();
    let rootWide = tabs.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(rootWide?._tag === 'Split' ? rootWide.ratio : null).toBeCloseTo(0.15, 4);

    divider.dispatchEvent(pointerEvent('pointerdown', { clientX: 300 }));
    divider.dispatchEvent(pointerEvent('pointermove', { clientX: 1990 }));
    divider.dispatchEvent(pointerEvent('pointerup', { clientX: 1990 }));
    fixture.detectChanges();
    rootWide = tabs.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(rootWide?._tag === 'Split' ? rootWide.ratio : null).toBeCloseTo(0.85, 4);

    // Keyboard ArrowLeft / ArrowRight on horizontal split divider adjusts ratio by 0.05 and persists.
    const updatesBeforeKey = updates.length;
    divider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    rootWide = tabs.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(rootWide?._tag === 'Split' ? rootWide.ratio : null).toBeCloseTo(0.8, 4);
    expect(updates.length).toBe(updatesBeforeKey + 1);

    // Vertical split respects 140px min height (height 500px -> minRatio 0.28) and ArrowDown/Home/End.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-split-trigger"]')[1]!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-down"]')!.click();
    fixture.detectChanges();

    const verticalSplit = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="pane-split"]'),
    ].find((el) => el.getAttribute('data-direction') === 'vertical')!;
    const verticalSplitId = PaneId.make(verticalSplit.getAttribute('data-split-id')!);
    const verticalDivider = verticalSplit.querySelector<HTMLElement>(
      '[data-testid="pane-resize-divider"]',
    )!;
    setRect(verticalSplit, { left: 0, width: 800, top: 50, height: 500 });

    verticalDivider.dispatchEvent(pointerEvent('pointerdown', { clientY: 300 }));
    verticalDivider.dispatchEvent(pointerEvent('pointermove', { clientY: 70 }));
    verticalDivider.dispatchEvent(pointerEvent('pointerup', { clientY: 70 }));
    fixture.detectChanges();
    let vNode = tabs.activeTab()!.layout.nodes.find((n) => n.id === verticalSplitId);
    expect(vNode?._tag === 'Split' ? vNode.ratio : null).toBeCloseTo(0.28, 4);

    verticalDivider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    vNode = tabs.activeTab()!.layout.nodes.find((n) => n.id === verticalSplitId);
    expect(vNode?._tag === 'Split' ? vNode.ratio : null).toBeCloseTo(0.33, 4);

    verticalDivider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    vNode = tabs.activeTab()!.layout.nodes.find((n) => n.id === verticalSplitId);
    expect(vNode?._tag === 'Split' ? vNode.ratio : null).toBeCloseTo(0.72, 4);
  });

  it('drags Panel headers to split edges and center-drops to swap Panes, enforces the 4-Pane cap, and cancels on Escape', async () => {
    const pointerEvent = (
      type: string,
      init: {
        readonly clientX?: number;
        readonly clientY?: number;
        readonly button?: number;
        readonly pointerId?: number;
      },
    ): Event => {
      const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      return new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
    };
    const setRect = (el: HTMLElement, rect: Partial<DOMRect>) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: rect.left ?? 0,
        y: rect.top ?? 0,
        left: rect.left ?? 0,
        top: rect.top ?? 0,
        right: (rect.left ?? 0) + (rect.width ?? 0),
        bottom: (rect.top ?? 0) + (rect.height ?? 0),
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        toJSON: () => ({}),
      });
    };

    const s1 = SessionId.make('s1');
    const updates: WorkspaceState[] = [];
    const { fixture, tabs } = await mountShell('other', {
      updates,
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              { tabId: 't1', paneId: 'pane1', panelId: 'panel1', sessionId: s1, title: 'First' },
            ],
          },
        ],
        p1,
      ),
    });
    const host = fixture.nativeElement as HTMLElement;

    // Set up 2 Panes: pane1 (panel1) | pane2 (panel2)
    host.querySelector<HTMLButtonElement>('[data-testid="panel-split-trigger"]')!.click();
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="panel-split-right"]')!.click();
    fixture.detectChanges();

    const getPane = (index: number) =>
      host.querySelectorAll<HTMLElement>('[data-testid="pane-view"]')[index]!;
    const pane1El = getPane(0);
    const pane2El = getPane(1);
    const initialPane1Panel = pane1El
      .querySelector('[data-testid="panel-frame"]')
      ?.getAttribute('data-panel-id');
    const initialPane2Panel = pane2El
      .querySelector('[data-testid="panel-frame"]')
      ?.getAttribute('data-panel-id');
    setRect(pane1El, { left: 0, top: 0, width: 400, height: 400 });
    setRect(pane2El, { left: 400, top: 0, width: 400, height: 400 });

    // Short click (< 5px) and button pointerdown do NOT trigger drag overlay.
    const header1Title = pane1El.querySelector<HTMLElement>('[data-testid="panel-title"]')!;
    const updatesBeforeShort = updates.length;
    header1Title.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 15, pointerId: 1 }),
    );
    header1Title.dispatchEvent(
      pointerEvent('pointermove', { clientX: 52, clientY: 17, pointerId: 1 }),
    );
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="pane-drop-zone"]')).toBeNull();
    header1Title.dispatchEvent(
      pointerEvent('pointerup', { clientX: 52, clientY: 17, pointerId: 1 }),
    );
    fixture.detectChanges();
    expect(updates.length).toBe(updatesBeforeShort);

    // Interactive button inside PanelHeader does NOT start drag.
    const splitBtn = pane1El.querySelector<HTMLElement>('[data-testid="panel-split-trigger"]')!;
    splitBtn.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 300, clientY: 15, pointerId: 2 }),
    );
    splitBtn.dispatchEvent(
      pointerEvent('pointermove', { clientX: 600, clientY: 200, pointerId: 2 }),
    );
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="pane-drop-zone"]')).toBeNull();
    splitBtn.dispatchEvent(pointerEvent('pointerup', { clientX: 600, clientY: 200, pointerId: 2 }));

    // Dragging panel1 onto pane2 center shows [data-drop-zone="center"] and Escape cancels cleanly.
    header1Title.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 15, pointerId: 3 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 600, clientY: 200, pointerId: 3 }));
    fixture.detectChanges();
    expect(
      pane2El.querySelector('[data-testid="pane-drop-zone"]')?.getAttribute('data-drop-zone'),
    ).toBe('center');
    dispatchKey({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="pane-drop-zone"]')).toBeNull();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 600, clientY: 200, pointerId: 3 }));
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);
    expect(updates.length).toBe(updatesBeforeShort);

    // Dragging panel1 onto pane2 center swaps pane1 and pane2 Panels cleanly and persists via Tabs.update.
    header1Title.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 15, pointerId: 4 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 600, clientY: 200, pointerId: 4 }));
    fixture.detectChanges();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 600, clientY: 200, pointerId: 4 }));
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);
    expect(
      getPane(0).querySelector('[data-testid="panel-frame"]')?.getAttribute('data-panel-id'),
    ).toBe(initialPane2Panel);
    expect(
      getPane(1).querySelector('[data-testid="panel-frame"]')?.getAttribute('data-panel-id'),
    ).toBe(initialPane1Panel);
    expect(updates.length).toBe(updatesBeforeShort + 1);

    // Split to 4 Panes and verify lone-Panel drag onto another Pane edge at 4-Pane cap collapses source cleanly.
    const pane0Id = PaneId.make(getPane(0).getAttribute('data-pane-id')!);
    const pane1Id = PaneId.make(getPane(1).getAttribute('data-pane-id')!);
    const pSplit3 = tabs.splitPane(pane0Id, 'bottom')!;
    const pSplit4 = tabs.splitPane(pane1Id, 'bottom')!;
    expect(pSplit3 && pSplit4).toBeTruthy();
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);
    fixture.detectChanges();

    const panesAt4 = [...host.querySelectorAll<HTMLElement>('[data-testid="pane-view"]')];
    setRect(panesAt4[0]!, { left: 0, top: 0, width: 400, height: 200 });
    setRect(panesAt4[1]!, { left: 0, top: 200, width: 400, height: 200 });
    setRect(panesAt4[2]!, { left: 400, top: 0, width: 400, height: 200 });
    setRect(panesAt4[3]!, { left: 400, top: 200, width: 400, height: 200 });

    const loneHeader = panesAt4[1]!.querySelector<HTMLElement>('[data-testid="panel-title"]')!;
    const lonePaneId = panesAt4[1]!.getAttribute('data-pane-id');
    loneHeader.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 215, pointerId: 7 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 780, clientY: 300, pointerId: 7 }));
    fixture.detectChanges();
    expect(
      panesAt4[3]!.querySelector('[data-testid="pane-drop-zone"]')?.getAttribute('data-drop-zone'),
    ).toBe('right');
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 780, clientY: 300, pointerId: 7 }));
    fixture.detectChanges();
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);
    expect(host.querySelector(`[data-pane-id="${lonePaneId}"]`)).toBeNull();
  });
});

describe('Shell Attention & Working bubbling and activation auto-expand routing', () => {
  const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
    agentStatus: 'ready',
    status: 'idle',
    title: { auto: 'Session', autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    commandsLoaded: true,
    queue: [],
    canAttachImages: false,
    imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
    ...overrides,
  });

  const sessionSummary = (id: SessionId, title: string): SessionSummary => ({
    id,
    agentId: AgentId.make('claude'),
    title: { auto: title, autoIsPlaceholder: false },
    lastActivityAt: 100,
    status: 'idle',
  });

  it('bubbles Attention/Working across split Panes to TabStrip and focuses on sidebar click or Tabs.activations', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const s3 = SessionId.make('s3');
    const s4 = SessionId.make('s4');
    const t1 = TabId.make('t1');
    const t2 = TabId.make('t2');
    const t3 = TabId.make('t3');
    const splitId = PaneId.make('split1');
    const pane1 = PaneId.make('pane1');
    const pane1b = PaneId.make('pane1b');
    const pane2 = PaneId.make('pane2');
    const pane3 = PaneId.make('pane3');
    const pLeft = PanelId.make('panel-left');
    const pRight = PanelId.make('panel-right');
    const pOtherTab = PanelId.make('panel-other-tab');
    const pApi = PanelId.make('panel-api');

    const changes = Effect.runSync(PubSub.unbounded<SessionChange>());
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const publishChange = (change: SessionChange) =>
      Effect.runSync(PubSub.publish(changes, change));
    const updates: WorkspaceState[] = [];

    const { fixture, tabs } = await mountShell('other', {
      projects: [project1, project2],
      sessionsByProject: {
        [p1]: [
          sessionSummary(s1, 'Primary'),
          sessionSummary(s2, 'Split worker'),
          sessionSummary(s3, 'Secondary tab'),
        ],
        [p2]: [sessionSummary(s4, 'API task')],
      },
      changes: Stream.fromPubSub(changes),
      activations: Stream.fromQueue(activations),
      updates,
      restored: {
        workspace: {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: t1,
              tabs: [
                {
                  id: t1,
                  focusedPanelId: pLeft,
                  layout: {
                    rootPaneId: splitId,
                    nodes: [
                      {
                        _tag: 'Split',
                        id: splitId,
                        direction: 'horizontal',
                        ratio: 0.5,
                        first: pane1,
                        second: pane1b,
                      },
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [{ id: pLeft, spec: { _tag: 'Session', sessionId: s1 } }],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane1b,
                        panels: [{ id: pRight, spec: { _tag: 'Session', sessionId: s2 } }],
                      },
                    ],
                  },
                },
                {
                  id: t2,
                  focusedPanelId: pOtherTab,
                  layout: {
                    rootPaneId: pane2,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane2,
                        panels: [{ id: pOtherTab, spec: { _tag: 'Session', sessionId: s3 } }],
                      },
                    ],
                  },
                },
              ],
            },
            {
              projectId: p2,
              activeTabId: t3,
              tabs: [
                {
                  id: t3,
                  focusedPanelId: pApi,
                  layout: {
                    rootPaneId: pane3,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane3,
                        panels: [{ id: pApi, spec: { _tag: 'Session', sessionId: s4 } }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        sessions: [
          { id: s1, projectId: p1, title: { auto: 'Primary', autoIsPlaceholder: false }, status: 'idle' },
          { id: s2, projectId: p1, title: { auto: 'Split worker', autoIsPlaceholder: false }, status: 'idle' },
          { id: s3, projectId: p1, title: { auto: 'Secondary tab', autoIsPlaceholder: false }, status: 'idle' },
          { id: s4, projectId: p2, title: { auto: 'API task', autoIsPlaceholder: false }, status: 'idle' },
        ],
      },
    });
    const host = fixture.nativeElement as HTMLElement;
    const settings = TestBed.inject(SettingsState);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="session-row"]')).toHaveLength(3);
    });

    // Live updates: both split Panes working -> Tab shows working.
    publishChange({
      sessionId: s1,
      projectId: p1,
      state: liveState({ status: 'working', runningTurn: TurnId.make('turn-1') }),
    });
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ status: 'working', runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      const tabBadge = host.querySelector('[data-testid="tab-activity-indicator"]');
      expect(tabBadge?.querySelector('[data-testid="status-working"]')).not.toBeNull();
    });

    // s2 hits error while s1 is still working -> Tab shows status-error (error > working).
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ status: 'error', runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        host.querySelector(
          '[data-testid="tab-activity-indicator"] [data-testid="status-error"]',
        ),
      ).not.toBeNull();
    });

    // s2 becomes blocked -> blocked wins in TabStrip.
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ status: 'blocked', runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        host.querySelector(
          '[data-testid="tab-activity-indicator"] [data-testid="status-blocked"]',
        ),
      ).not.toBeNull();
    });

    // Switch to t2 in p1, then click s2 in the sidebar -> switches back to t1, focuses pRight, and emits Tabs.update.
    tabs.activateTab(t2);
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe(t2);

    const updatesBeforeSidebarClick = updates.length;
    const s2Row = host.querySelector<HTMLButtonElement>(
      `[data-testid="session-row"][data-session-id="${s2}"]`,
    )!;
    s2Row.click();
    fixture.detectChanges();

    expect(tabs.activeProjectId()).toBe(p1);
    expect(tabs.activeTab()?.id).toBe(t1);
    expect(tabs.focusedPanel()?.id).toBe(pRight);
    expect(updates.length).toBeGreaterThan(updatesBeforeSidebarClick);

    const rightFrameAfterClick = host.querySelector<HTMLElement>(
      `[data-testid="panel-frame"][data-panel-id="${pRight}"]`,
    )!;
    expect(rightFrameAfterClick.getAttribute('data-focused')).toBe('true');
    expect(
      rightFrameAfterClick
        .querySelector('[data-testid="session-view-stub"]')
        ?.getAttribute('data-focused'),
    ).toBe('true');

    // Focus pLeft, switch to Project p2, and open Settings -> OS notification activation on Tabs.activations
    // closes Settings, switches Project back to p1, focuses pRight, and emits Tabs.update.
    tabs.focusPanel(pLeft);
    tabs.switchProject(p2);
    settings.show();
    fixture.detectChanges();
    expect(settings.open()).toBe(true);
    expect(tabs.activeProjectId()).toBe(p2);

    const updatesBeforeOsActivation = updates.length;
    Queue.offerUnsafe(activations, {
      sessionId: s2,
      projectId: p1,
      title: { auto: 'Split worker', autoIsPlaceholder: false },
    });

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(settings.open()).toBe(false);
      expect(tabs.activeProjectId()).toBe(p1);
      expect(tabs.activeTab()?.id).toBe(t1);
      expect(tabs.focusedPanel()?.id).toBe(pRight);
    });
    expect(updates.length).toBeGreaterThan(updatesBeforeOsActivation);

    const frameAfterActivation = host.querySelector<HTMLElement>(
      `[data-testid="panel-frame"][data-panel-id="${pRight}"]`,
    )!;
    expect(frameAfterActivation.getAttribute('data-focused')).toBe('true');
    expect(
      frameAfterActivation
        .querySelector('[data-testid="session-view-stub"]')
        ?.getAttribute('data-focused'),
    ).toBe('true');
  });
});

describe('Shell Browser split pane & PanelHeader toggle', () => {
  it('toggles Browser split pane for local Sessions, hides during Settings, and disables for remote Sessions', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', { browserSpy: spy });
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="toggle-browser"]');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggle()).not.toBeNull();
      expect(toggle()?.disabled).toBe(false);
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    toggle()?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
    });

    // Opening Settings hides the split pane and clears active Browser session without losing open state.
    const settings = TestBed.inject(SettingsState);
    settings.show();
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });

    settings.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    // Remote Sessions disable the PanelHeader Browser toggle and clear active Browser session.
    tabs.open({ id: sRemote, projectId: p2, device: dRemote, title: 'Remote Session' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggle()?.disabled).toBe(true);
      expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });
  });

  it('clamps pointer drag resize width to 320..960 px and commits on pointerup', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', { browserSpy: spy });
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="toggle-browser"]')).not.toBeNull();
    });

    (root.querySelector('[data-testid="toggle-browser"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-resize-handle"]')).not.toBeNull();
    });

    const handle = root.querySelector('[data-testid="browser-resize-handle"]') as HTMLElement;
    const container = root.querySelector('[data-testid="browser-pane-container"]') as HTMLElement;
    const split = root.querySelector('[data-testid="shell-split"]') as HTMLElement;
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 1400 });

    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 700 }));
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('680px');

    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('960px');

    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1200 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('320px');

    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 1200 }));
    await vi.waitFor(() => {
      expect(spy.widths).toEqual([320]);
    });
  });

  it('switches Browser visibility, active session, width, and pane input cleanly across two local Sessions', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    spy.states.set(
      sLocal,
      makeBrowserState(sLocal, {
        open: true,
        width: 440,
      }),
    );
    spy.states.set(
      sLocalTwo,
      makeBrowserState(sLocalTwo, {
        open: false,
        width: 620,
      }),
    );

    const { fixture, tabs } = await mountShell('other', { browserSpy: spy });
    const root = fixture.nativeElement as HTMLElement;
    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="toggle-browser"]');

    tabs.open({ id: sLocal, projectId: p1, title: 'First Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('440px');
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    // Switch to second Session whose Browser is closed -> hides split pane while preserving sLocal open state.
    tabs.open({ id: sLocalTwo, projectId: p1, title: 'Second Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();
      expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
      expect(spy.activeSessions.at(-1)).toBe(sLocalTwo);
    });
    expect(spy.states.get(sLocal)?.open).toBe(true);

    // Open Browser in second Session -> shows sLocalTwo with its own width.
    toggle()?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocalTwo,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('620px');
    });

    // Switch back to first Session -> restores sLocal in BrowserPane with its own width.
    tabs.open({ id: sLocal, projectId: p1, title: 'First Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('440px');
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });
    expect(spy.states.get(sLocalTwo)?.open).toBe(true);
  });

  it('signals occlusion across confirm dialog, menus, and hides on empty workspace while ignoring sidebar tooltips', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', { browserSpy: spy });
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="toggle-browser"]')).not.toBeNull();
    });
    (root.querySelector('[data-testid="toggle-browser"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
    });

    // Left-sidebar tooltip does not occlude Browser.
    const newSessionBtn = root.querySelector<HTMLElement>('[data-testid="new-session"]')!;
    newSessionBtn.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    });
    expect(spy.occludedCalls).not.toContain(true);
    newSessionBtn.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    // Delete confirm alert-dialog occludes on open and restores on dismiss.
    const sessionsState = TestBed.inject(SessionsState);
    await sessionsState.delete([{ id: sLocal, title: 'Local Session' }]);
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(true));
    sessionsState.dismissConfirm();
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(false));

    // PanelHeader session actions dropdown menu occludes on open and restores on close.
    root.querySelector<HTMLButtonElement>('[data-testid="session-actions-trigger"]')!.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(true));
    const actionsMenu = document.querySelector<HTMLElement>('[data-testid="session-actions-menu"]');
    expect(actionsMenu).not.toBeNull();
    actionsMenu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }),
    );
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(false));

    // Closing the last Tab switches to empty workspace and clears active Browser session; reopening restores it.
    tabs.closeSession(sLocal);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });
  });

  it('auto-opens split pane when viewed Session receives Agent Browser event without stealing Tab on background Session events', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', { browserSpy: spy });
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocalTwo, projectId: p1, title: 'Background Session' });
    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    await vi.waitFor(() => expect(spy.pushEvent).toBeDefined());
    expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();

    // Background Session Browser event never switches active Tab or opens sLocal's split pane.
    spy.pushEvent?.({
      _tag: 'State',
      state: makeBrowserState(sLocalTwo, {
        open: false,
        control: { _tag: 'agentActive', action: 'navigate' },
      }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tabs.active()?.session).toBe(sLocal);
      expect(root.querySelector('[data-testid="browser-pane-container"]')).toBeNull();
    });

    // Viewed Session sLocal auto-opens split pane on Browser.events State with open: true.
    spy.pushEvent?.({
      _tag: 'State',
      state: makeBrowserState(sLocal, {
        open: true,
        control: { _tag: 'agentActive', action: 'navigate' },
      }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-container"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
    });
  });
});
