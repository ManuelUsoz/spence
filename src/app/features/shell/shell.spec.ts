import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type RestoredWorkspace,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Keymap, KEYMAP_PLATFORM, type KeymapPlatform } from '../../core/keymap';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs, type Tab } from '../../core/tabs';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

@Component({
  selector: 'app-session-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="session-view-stub">{{ tab().id }}</div>`,
})
class SessionViewStub {
  readonly tab = input.required<Tab>();
  readonly projectName = input('');
}

@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

const p1 = ProjectId.make('p1');
const p2 = ProjectId.make('p2');

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
                    collapsed: false,
                    heightShare: 1,
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
}

const defaults: Settings = {
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

const desktopLayer = (options: DesktopFixtureOptions = {}) => {
  const projects = options.projects ?? [project1];
  const sessionsByProject = options.sessionsByProject ?? {};
  const restored = options.restored ?? { workspace: EMPTY_WORKSPACE, sessions: [] };
  return makeDesktopTestLayer(
    Layer.mergeAll(
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
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed(restored),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
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
        'Session.countWorkers': () => Effect.die('unused'),
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );
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
      { provide: SESSION_VIEW, useValue: SessionViewStub },
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

    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe('t2');

    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    fixture.detectChanges();
    expect(tabs.activeTab()?.id).toBe('t1');

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

describe('Shell workspace layout and Settings isolation', () => {
  it('renders EmptyWorkspace and TabStrip when active Project has 0 Tabs, and opens a Tab from CTA', async () => {
    const { fixture, tabs } = await mountShell('other');
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-testid="tab-strip"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="session-view-stub"]')).toBeNull();

    (host.querySelector('[data-testid="empty-new-tab"]') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(tabs.tabs()).toHaveLength(1);
    expect(host.querySelector('[data-testid="empty-workspace"]')).toBeNull();
    expect(host.querySelector('[data-testid="session-view-stub"]')).not.toBeNull();
  });

  it('renders TopBar and router-outlet instead of EmptyWorkspace or TabStrip when no Projects exist', async () => {
    const { fixture } = await mountShell('other', { projects: [] });
    const host = fixture.nativeElement as HTMLElement;

    expect(host.querySelector('[data-testid="tab-strip"]')).toBeNull();
    expect(host.querySelector('[data-testid="empty-workspace"]')).toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
  });

  it('keeps Settings outside Tabs with sidebar trigger accessible and closes Settings cleanly on Tab activation', async () => {
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
    expect(host.querySelector('app-settings-page')).not.toBeNull();
    expect(host.querySelector('[data-testid="tab-strip"]')).toBeNull();
    expect(host.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(1);

    const firstTab = tabs.tabs()[0];
    expect(firstTab).toBeDefined();
    if (firstTab !== undefined) tabs.activateTab(firstTab.id);
    fixture.detectChanges();
    expect(settings.open()).toBe(false);
    expect(host.querySelector('[data-testid="tab-strip"]')).not.toBeNull();
    expect(tabs.tabs()).toHaveLength(1);
  });
});
