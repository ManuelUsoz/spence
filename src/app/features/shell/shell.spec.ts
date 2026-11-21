import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, PubSub, Queue, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
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
import {
  EMPTY_WORKSPACE,
  MIN_STACK_SHARE,
  allTabPanels,
} from '../../../shared/tabs/workspace-layout';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { CHANGES_VIEW } from '../../core/changes-view';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Keymap, KEYMAP_PLATFORM, type KeymapPlatform } from '../../core/keymap';
import { PANEL_DEFINITION, type PanelDefinition } from '../../core/panel-registry';
import { Tabs } from '../../core/tabs';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

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
  selector: 'app-changes-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="changes-view-stub">{{ sessionId() }}</div>`,
})
class ChangesViewStub {
  readonly sessionId = input.required<SessionId>();
  readonly running = input(false);
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
  readonly extraPanels?: ReadonlyArray<PanelDefinition>;
  readonly updates?: Array<WorkspaceState>;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly activations?: Stream.Stream<TabActivation>;
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
        'Session.countWorkers': () => Effect.die('unused'),
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );
};

const sessionPanelDef: PanelDefinition = {
  kind: 'Session',
  component: SessionViewStub,
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
      { provide: PANEL_DEFINITION, multi: true, useValue: sessionPanelDef },
      ...(options.extraPanels ?? []).map((def) => ({
        provide: PANEL_DEFINITION,
        multi: true,
        useValue: def,
      })),
      { provide: CHANGES_VIEW, useValue: ChangesViewStub },
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
    expect(host.querySelector('[data-testid="session-view-stub"]')).not.toBeNull();

    // Closing the draft Panel via PanelHeader closes the Tab and returns to EmptyWorkspace.
    (host.querySelector('[data-testid="panel-close"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
  });

  it('renders custom Panel types registered via PANEL_DEFINITION without modifying Tab/Pane/Stack code', async () => {
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
                            collapsed: false,
                            heightShare: 1,
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

  it('renders multiple Panels in a Pane with independent headers and updates focus when clicking an unfocused PanelFrame', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const panel1 = PanelId.make('panel-1');
    const panel2 = PanelId.make('panel-2');
    const pane1 = PaneId.make('pane-1');
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
                    rootPaneId: pane1,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [
                          {
                            id: panel1,
                            spec: { _tag: 'Session', sessionId: s1 },
                            collapsed: false,
                            heightShare: 0.5,
                          },
                          {
                            id: panel2,
                            spec: { _tag: 'Session', sessionId: s2 },
                            collapsed: false,
                            heightShare: 0.5,
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
          { id: s1, projectId: p1, title: { auto: 'First', autoIsPlaceholder: false } },
          { id: s2, projectId: p1, title: { auto: 'Second', autoIsPlaceholder: false } },
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

    // Closing the first Panel keeps the Tab open with the second Panel.
    frames[0]!.querySelector<HTMLButtonElement>('[data-testid="panel-close"]')!.click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="panel-frame"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="panel-title"]')?.textContent?.trim()).toBe('Second');
  });

  it('opens temporary Changes view from PanelHeader and returns to the Panel via changes-back', async () => {
    const s1 = SessionId.make('s1');
    const { fixture } = await mountShell('other', {
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

    (host.querySelector('[data-testid="open-changes"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="changes-view-stub"]')?.textContent?.trim()).toBe('s1');
    expect(host.querySelector('[data-testid="changes-back"]')).not.toBeNull();

    (host.querySelector('[data-testid="changes-back"]') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="changes-view-stub"]')).toBeNull();
    expect(host.querySelector('[data-testid="pane-view"]')).not.toBeNull();
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

  it('stacks Panels via PanelHeader Add to stack, shows collapse toggles only when stacked, enforces >= 1 expanded, and auto-expands on sole-expanded close', async () => {
    const s1 = SessionId.make('s1');
    const updates: WorkspaceState[] = [];
    const { fixture, tabs } = await mountShell('other', {
      updates,
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

    // Single Panel in Pane: not stacked, no collapse toggle shown.
    const pane = host.querySelector<HTMLElement>('[data-testid="pane-view"]')!;
    expect(pane.getAttribute('data-stacked')).toBe('false');
    expect(host.querySelectorAll('[data-testid="panel-collapse-toggle"]')).toHaveLength(0);

    // Open Panel header menu and click "Add to stack" to append a fresh draft Session Panel.
    host.querySelector<HTMLButtonElement>('[data-testid="session-actions-trigger"]')!.click();
    fixture.detectChanges();
    const addBtn = document.querySelector<HTMLButtonElement>('[data-testid="panel-add-to-stack"]')!;
    expect(addBtn).not.toBeNull();
    addBtn.click();
    fixture.detectChanges();

    expect(pane.getAttribute('data-stacked')).toBe('true');
    const frames = [...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')];
    expect(frames).toHaveLength(2);
    expect(frames.map((el) => el.getAttribute('data-focused'))).toEqual(['false', 'true']);
    expect(host.querySelectorAll('[data-testid="panel-body"]')).toHaveLength(2);

    const toggles = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]'),
    ];
    expect(toggles).toHaveLength(2);
    expect(toggles.map((btn) => [btn.getAttribute('aria-expanded'), btn.disabled])).toEqual([
      ['true', false],
      ['true', false],
    ]);

    // Collapse the second (focused) Panel: its body hides, focus moves to first Panel, and first Panel's toggle disables.
    toggles[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    toggles[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    toggles[1]!.click();
    fixture.detectChanges();

    const togglesAfterCollapse = [
      ...host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]'),
    ];
    expect(
      togglesAfterCollapse.map((btn) => [btn.getAttribute('aria-expanded'), btn.disabled]),
    ).toEqual([
      ['true', true],
      ['false', false],
    ]);
    expect(host.querySelectorAll('[data-testid="panel-body"]')).toHaveLength(1);
    const framesAfterCollapse = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]'),
    ];
    expect(framesAfterCollapse[0]!.getAttribute('data-focused')).toBe('true');
    expect(framesAfterCollapse[1]!.style.flexGrow).toBe('0');

    // Clicking the collapsed Panel's toggle expands and focuses it (even when mousedown/focusin fire first).
    togglesAfterCollapse[1]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    togglesAfterCollapse[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    togglesAfterCollapse[1]!.click();
    fixture.detectChanges();

    expect(host.querySelectorAll('[data-testid="panel-body"]')).toHaveLength(2);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')].map(
        (btn) => [btn.getAttribute('aria-expanded'), btn.disabled],
      ),
    ).toEqual([
      ['true', false],
      ['true', false],
    ]);
    expect(tabs.focusedPanel()?.id).toBe(allTabPanels(tabs.activeTab()!)[1]!.id);

    // Collapse the second Panel again, then close the sole expanded first Panel -> second Panel auto-expands!
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')[1]!.click();
    fixture.detectChanges();
    expect(allTabPanels(tabs.activeTab()!).map((p) => p.collapsed)).toEqual([false, true]);

    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-close"]')[0]!.click();
    fixture.detectChanges();
    expect(pane.getAttribute('data-stacked')).toBe('false');
    expect(host.querySelectorAll('[data-testid="panel-frame"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="panel-body"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="panel-collapse-toggle"]')).toHaveLength(0);

    // Closing the last remaining Panel closes the Tab and shows EmptyWorkspace.
    host.querySelector<HTMLButtonElement>('[data-testid="panel-close"]')!.click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
    expect(host.querySelector('[data-testid="empty-workspace"]')).not.toBeNull();
    expect(updates.length).toBeGreaterThan(0);
  });

  it('renders StackDividers between adjacent expanded Panels (even across collapsed headers) and resizes via pointer drag and Arrow keys', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const s3 = SessionId.make('s3');
    const pane1 = PaneId.make('pane-1');
    const panel1 = PanelId.make('panel-1');
    const panel2 = PanelId.make('panel-2');
    const panel3 = PanelId.make('panel-3');
    const tab1 = TabId.make('tab-1');
    const updates: WorkspaceState[] = [];

    const pointerEvent = (
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientY: number,
    ): PointerEvent => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientY,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      return event as unknown as PointerEvent;
    };

    const { fixture, tabs } = await mountShell('other', {
      updates,
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
                    rootPaneId: pane1,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [
                          {
                            id: panel1,
                            spec: { _tag: 'Session', sessionId: s1 },
                            collapsed: false,
                            heightShare: 0.5,
                          },
                          {
                            id: panel2,
                            spec: { _tag: 'Session', sessionId: s2 },
                            collapsed: true,
                            heightShare: 0.5,
                          },
                          {
                            id: panel3,
                            spec: { _tag: 'Session', sessionId: s3 },
                            collapsed: false,
                            heightShare: 0.5,
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
          { id: s1, projectId: p1, title: { auto: 'Top', autoIsPlaceholder: false } },
          { id: s2, projectId: p1, title: { auto: 'Middle', autoIsPlaceholder: false } },
          { id: s3, projectId: p1, title: { auto: 'Bottom', autoIsPlaceholder: false } },
        ],
      },
    });
    const host = fixture.nativeElement as HTMLElement;
    const paneEl = host.querySelector<HTMLElement>('[data-testid="pane-view"]')!;

    // Two expanded Panels separated by one collapsed Panel -> exactly 1 horizontal separator divider.
    const dividers = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="stack-resize-divider"]'),
    ];
    expect(dividers).toHaveLength(1);
    const divider = dividers[0]!;
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('horizontal');

    // Stub Pane height to 1000px (120px min height = 0.12 < MIN_STACK_SHARE 0.15).
    vi.spyOn(paneEl, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 1000,
      left: 0,
      right: 600,
      width: 600,
      height: 1000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Pointer-capture drag down by +150px shifts share by +0.15 from panel3 to panel1, leaving collapsed panel2 untouched.
    const updatesBeforeDrag = updates.length;
    divider.dispatchEvent(pointerEvent('pointerdown', 500));
    divider.dispatchEvent(pointerEvent('pointermove', 650));
    divider.dispatchEvent(pointerEvent('pointerup', 650));
    fixture.detectChanges();

    const afterDrag = allTabPanels(tabs.activeTab()!);
    expect(afterDrag[0]!.heightShare).toBeCloseTo(0.65, 5);
    expect(afterDrag[1]!.heightShare).toBe(0.5);
    expect(afterDrag[1]!.collapsed).toBe(true);
    expect(afterDrag[2]!.heightShare).toBeCloseTo(0.35, 5);
    expect(afterDrag[0]!.heightShare + afterDrag[2]!.heightShare).toBeCloseTo(1, 5);
    expect(updates.length).toBeGreaterThan(updatesBeforeDrag);

    // Dragging past the bottom clamps lower share at MIN_STACK_SHARE (0.15) and preserves combined share (1.0).
    divider.dispatchEvent(pointerEvent('pointerdown', 650));
    divider.dispatchEvent(pointerEvent('pointermove', 1200));
    divider.dispatchEvent(pointerEvent('pointerup', 1200));
    fixture.detectChanges();

    const afterClamp = allTabPanels(tabs.activeTab()!);
    expect(afterClamp[0]!.heightShare).toBeCloseTo(1 - MIN_STACK_SHARE, 5);
    expect(afterClamp[2]!.heightShare).toBeCloseTo(MIN_STACK_SHARE, 5);

    // Keyboard ArrowUp shrinks upper and grows lower while preserving combined share.
    divider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    const afterUp = allTabPanels(tabs.activeTab()!);
    expect(afterUp[0]!.heightShare).toBeLessThan(afterClamp[0]!.heightShare);
    expect(afterUp[2]!.heightShare).toBeGreaterThan(afterClamp[2]!.heightShare);
    expect(afterUp[0]!.heightShare + afterUp[2]!.heightShare).toBeCloseTo(1, 5);

    // Keyboard ArrowDown reverses back.
    divider.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    const afterDown = allTabPanels(tabs.activeTab()!);
    expect(afterDown[0]!.heightShare).toBeCloseTo(afterClamp[0]!.heightShare, 5);
    expect(afterDown[2]!.heightShare).toBeCloseTo(afterClamp[2]!.heightShare, 5);

    // On a shorter 400px Pane, minimum 120px Panel height (0.30 share) overrides MIN_STACK_SHARE (0.15).
    vi.spyOn(paneEl, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      bottom: 400,
      left: 0,
      right: 600,
      width: 600,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    divider.dispatchEvent(pointerEvent('pointerdown', 200));
    divider.dispatchEvent(pointerEvent('pointermove', 600));
    divider.dispatchEvent(pointerEvent('pointerup', 600));
    fixture.detectChanges();
    const afterMinPx = allTabPanels(tabs.activeTab()!);
    expect(afterMinPx[0]!.heightShare).toBeCloseTo(0.7, 5);
    expect(afterMinPx[2]!.heightShare).toBeCloseTo(0.3, 5);

    // Expanding middle Panel produces 2 dividers (one between Top & Middle, one between Middle & Bottom).
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')[1]!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="stack-resize-divider"]')).toHaveLength(2);

    // Collapsing two Panels down to 1 expanded leaves 0 dividers.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')[1]!.click();
    fixture.detectChanges();
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')[2]!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="stack-resize-divider"]')).toHaveLength(0);
  });

  it('stacks a sidebar Session via context menu Add to stack and preserves max-1-Panel-per-Session uniqueness', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const summary = (id: SessionId, title: string): SessionSummary => ({
      id,
      agentId: AgentId.make('claude'),
      title: { auto: title, autoIsPlaceholder: false },
      lastActivityAt: Date.now(),
    });

    const { fixture, tabs } = await mountShell('other', {
      sessionsByProject: {
        [p1]: [summary(s1, 'First Session'), summary(s2, 'Second Session')],
      },
      restored: makeRestored(
        [
          {
            projectId: p1,
            tabs: [
              {
                tabId: 't1',
                paneId: 'pane1',
                panelId: 'panel1',
                sessionId: s1,
                title: 'First Session',
              },
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

    const openContextMenu = (sessionId: SessionId): void => {
      const row = host.querySelector<HTMLElement>(
        `[data-testid="session-row"][data-session-id="${sessionId}"]`,
      )!;
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 20,
          clientY: 20,
        }),
      );
      fixture.detectChanges();
    };

    // Right-click s2 -> "Add to stack" appends s2 into the active Pane's stack.
    openContextMenu(s2);
    const addToStackItem = document.querySelector<HTMLButtonElement>(
      '[data-testid="menu-add-to-stack"]',
    );
    expect(addToStackItem).not.toBeNull();
    addToStackItem!.click();
    fixture.detectChanges();

    expect(tabs.tabs()).toHaveLength(1);
    expect(host.querySelector('[data-testid="pane-view"]')?.getAttribute('data-stacked')).toBe(
      'true',
    );
    expect(
      [...host.querySelectorAll('[data-testid="panel-title"]')].map((el) => el.textContent?.trim()),
    ).toEqual(['First Session', 'Second Session']);
    expect(tabs.active()?.session).toBe(s2);

    // Collapse s1, then choose "Add to stack" on s1 from the sidebar -> auto-expands & focuses s1 without duplicating.
    host.querySelectorAll<HTMLButtonElement>('[data-testid="panel-collapse-toggle"]')[0]!.click();
    fixture.detectChanges();
    expect(allTabPanels(tabs.activeTab()!).map((p) => p.collapsed)).toEqual([true, false]);

    openContextMenu(s1);
    document.querySelector<HTMLButtonElement>('[data-testid="menu-add-to-stack"]')!.click();
    fixture.detectChanges();

    expect(allTabPanels(tabs.activeTab()!)).toHaveLength(2);
    expect(allTabPanels(tabs.activeTab()!).map((p) => p.collapsed)).toEqual([false, false]);
    expect(tabs.active()?.session).toBe(s1);
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

  it('drags Panel headers to split edges and center stacks, enforces the 4-Pane cap, supports intra-stack reorder, and cancels on Escape', async () => {
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

    // Dragging panel1 onto pane2 center stacks into pane2 and collapses empty pane1, persisting via Tabs.update.
    header1Title.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 15, pointerId: 4 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 600, clientY: 200, pointerId: 4 }));
    fixture.detectChanges();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 600, clientY: 200, pointerId: 4 }));
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="pane-view"]')?.getAttribute('data-stacked')).toBe(
      'true',
    );
    expect(updates.length).toBe(updatesBeforeShort + 1);

    // Intra-stack reorder: drag upper panel onto lower panel's lower half.
    const stackedPaneEl = getPane(0);
    setRect(stackedPaneEl, { left: 0, top: 0, width: 800, height: 400 });
    const frames = [...stackedPaneEl.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')];
    setRect(frames[0]!, { left: 0, top: 0, width: 800, height: 200 });
    setRect(frames[1]!, { left: 0, top: 200, width: 800, height: 200 });
    const initialOrder = frames.map((el) => el.getAttribute('data-panel-id'));

    const upperTitle = frames[0]!.querySelector<HTMLElement>('[data-testid="panel-title"]')!;
    upperTitle.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 100, clientY: 15, pointerId: 5 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 300, pointerId: 5 }));
    fixture.detectChanges();
    expect(
      stackedPaneEl.querySelector('[data-testid="pane-drop-zone"]')?.getAttribute('data-drop-zone'),
    ).toBe('center');
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: 300, pointerId: 5 }));
    fixture.detectChanges();
    const reorderedIds = [
      ...stackedPaneEl.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]'),
    ].map((el) => el.getAttribute('data-panel-id'));
    expect(reorderedIds).toEqual([initialOrder[1], initialOrder[0]]);

    // Now test edge split drop + 4-Pane cap: split to 4 Panes where pane 0 has 2 Panels and panes 1..3 have 1 Panel.
    const pane0Id = PaneId.make(getPane(0).getAttribute('data-pane-id')!);
    const pSplit2 = tabs.splitPane(pane0Id, 'right')!;
    const pSplit3 = tabs.splitPane(pane0Id, 'bottom')!;
    const pSplit4 = tabs.splitPane(pane0Id, 'bottom')!;
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);
    expect(pSplit2 && pSplit3 && pSplit4).toBeTruthy();
    fixture.detectChanges();

    const panesAt4 = [...host.querySelectorAll<HTMLElement>('[data-testid="pane-view"]')];
    setRect(panesAt4[0]!, { left: 0, top: 0, width: 400, height: 200 });
    setRect(panesAt4[1]!, { left: 0, top: 200, width: 400, height: 200 });
    setRect(panesAt4[2]!, { left: 400, top: 0, width: 400, height: 200 });
    setRect(panesAt4[3]!, { left: 400, top: 200, width: 400, height: 200 });

    // Multi-Panel pane (panesAt4[0]) cannot split onto panesAt4[3]'s right edge (rx > 0.75) at 4-Pane cap.
    const multiHeader = panesAt4[0]!.querySelector<HTMLElement>('[data-testid="panel-title"]')!;
    multiHeader.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 15, pointerId: 6 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 780, clientY: 300, pointerId: 6 }));
    fixture.detectChanges();
    expect(host.querySelector('[data-testid="pane-drop-zone"]')).toBeNull();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 780, clientY: 300, pointerId: 6 }));
    fixture.detectChanges();
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);

    // Lone-Panel pane (panesAt4[1]) CAN split onto panesAt4[3]'s right edge at 4-Pane cap (collapses panesAt4[1], total stays 4).
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
  });

  it('bubbles Attention/Working to collapsed Panel headers and TabStrip, and auto-expands & focuses on sidebar click or Tabs.activations', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const s3 = SessionId.make('s3');
    const s4 = SessionId.make('s4');
    const t1 = TabId.make('t1');
    const t2 = TabId.make('t2');
    const t3 = TabId.make('t3');
    const pane1 = PaneId.make('pane1');
    const pane2 = PaneId.make('pane2');
    const pane3 = PaneId.make('pane3');
    const pExpanded = PanelId.make('panel-expanded');
    const pCollapsed = PanelId.make('panel-collapsed');
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
          sessionSummary(s2, 'Collapsed worker'),
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
                  focusedPanelId: pExpanded,
                  layout: {
                    rootPaneId: pane1,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [
                          {
                            id: pExpanded,
                            spec: { _tag: 'Session', sessionId: s1 },
                            collapsed: false,
                            heightShare: 0.5,
                          },
                          {
                            id: pCollapsed,
                            spec: { _tag: 'Session', sessionId: s2 },
                            collapsed: true,
                            heightShare: 0.5,
                          },
                        ],
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
                        panels: [
                          {
                            id: pOtherTab,
                            spec: { _tag: 'Session', sessionId: s3 },
                            collapsed: false,
                            heightShare: 1,
                          },
                        ],
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
                        panels: [
                          {
                            id: pApi,
                            spec: { _tag: 'Session', sessionId: s4 },
                            collapsed: false,
                            heightShare: 1,
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
          { id: s1, projectId: p1, title: { auto: 'Primary', autoIsPlaceholder: false } },
          { id: s2, projectId: p1, title: { auto: 'Collapsed worker', autoIsPlaceholder: false } },
          { id: s3, projectId: p1, title: { auto: 'Secondary tab', autoIsPlaceholder: false } },
          { id: s4, projectId: p2, title: { auto: 'API task', autoIsPlaceholder: false } },
        ],
      },
    });
    const host = fixture.nativeElement as HTMLElement;
    const settings = TestBed.inject(SettingsState);

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="session-row"]')).toHaveLength(3);
    });

    // Live updates: expanded s1 is running, collapsed s2 is running -> only collapsed Panel shows panel-activity-indicator, Tab shows running.
    publishChange({
      sessionId: s1,
      projectId: p1,
      state: liveState({ runningTurn: TurnId.make('turn-1') }),
    });
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      const panelBadges = host.querySelectorAll('[data-testid="panel-activity-indicator"]');
      expect(panelBadges).toHaveLength(1);
      expect(panelBadges[0]!.querySelector('[data-testid="session-running"]')).not.toBeNull();
      const tabBadge = host.querySelector('[data-testid="tab-activity-indicator"]');
      expect(tabBadge?.querySelector('[data-testid="session-running"]')).not.toBeNull();
    });

    // Collapsed s2 hits error while s1 is still running -> collapsed Panel & Tab both show attention-error (Attention > Working).
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ attention: 'error', runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        host.querySelector(
          '[data-testid="panel-activity-indicator"] [data-testid="attention-error"]',
        ),
      ).not.toBeNull();
      expect(
        host.querySelector(
          '[data-testid="tab-activity-indicator"] [data-testid="attention-error"]',
        ),
      ).not.toBeNull();
    });

    // Collapsed s2 requests needsAnswer -> needsAnswer wins on both Panel header and Tab strip.
    publishChange({
      sessionId: s2,
      projectId: p1,
      state: liveState({ attention: 'needsAnswer', runningTurn: TurnId.make('turn-2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        host.querySelector(
          '[data-testid="panel-activity-indicator"] [data-testid="attention-needsAnswer"]',
        ),
      ).not.toBeNull();
      expect(
        host.querySelector(
          '[data-testid="tab-activity-indicator"] [data-testid="attention-needsAnswer"]',
        ),
      ).not.toBeNull();
    });

    // Switch to t2 in p1, then click s2 in the sidebar -> switches back to t1, auto-expands pCollapsed, focuses it, and emits Tabs.update.
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
    expect(tabs.focusedPanel()?.id).toBe(pCollapsed);
    expect(tabs.focusedPanel()?.collapsed).toBe(false);
    expect(updates.length).toBeGreaterThan(updatesBeforeSidebarClick);

    const collapsedFrameAfterClick = host.querySelector<HTMLElement>(
      `[data-testid="panel-frame"][data-panel-id="${pCollapsed}"]`,
    )!;
    expect(collapsedFrameAfterClick.getAttribute('data-collapsed')).toBe('false');
    expect(collapsedFrameAfterClick.getAttribute('data-focused')).toBe('true');
    expect(
      collapsedFrameAfterClick
        .querySelector('[data-testid="session-view-stub"]')
        ?.getAttribute('data-focused'),
    ).toBe('true');
    expect(host.querySelectorAll('[data-testid="panel-activity-indicator"]')).toHaveLength(0);

    // Collapse s2 again, switch to Project p2, and open Settings -> OS notification activation on Tabs.activations
    // closes Settings, switches Project back to p1, auto-expands s2, focuses it, and emits Tabs.update.
    tabs.togglePanelCollapsed(pCollapsed);
    tabs.switchProject(p2);
    settings.show();
    fixture.detectChanges();
    expect(settings.open()).toBe(true);
    expect(tabs.activeProjectId()).toBe(p2);

    const updatesBeforeOsActivation = updates.length;
    Queue.offerUnsafe(activations, {
      sessionId: s2,
      projectId: p1,
      title: { auto: 'Collapsed worker', autoIsPlaceholder: false },
    });

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(settings.open()).toBe(false);
      expect(tabs.activeProjectId()).toBe(p1);
      expect(tabs.activeTab()?.id).toBe(t1);
      expect(tabs.focusedPanel()?.id).toBe(pCollapsed);
      expect(tabs.focusedPanel()?.collapsed).toBe(false);
    });
    expect(updates.length).toBeGreaterThan(updatesBeforeOsActivation);

    const frameAfterActivation = host.querySelector<HTMLElement>(
      `[data-testid="panel-frame"][data-panel-id="${pCollapsed}"]`,
    )!;
    expect(frameAfterActivation.getAttribute('data-collapsed')).toBe('false');
    expect(frameAfterActivation.getAttribute('data-focused')).toBe('true');
    expect(
      frameAfterActivation
        .querySelector('[data-testid="session-view-stub"]')
        ?.getAttribute('data-focused'),
    ).toBe('true');
  });
});
