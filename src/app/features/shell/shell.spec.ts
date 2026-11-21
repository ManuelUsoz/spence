import { Injector, inject } from '@angular/core';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type LiveState,
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
  type WorkspacePanel,
  type WorkspaceState,
} from '../../../shared/tabs/tabs.rpc';
import {
  EMPTY_WORKSPACE,
  MIN_STACK_SHARE,
  allTabLeaves,
  allTabPanels,
} from '../../../shared/tabs/workspace-layout';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
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
  readonly changesBySession?: (sessionId: SessionId) => ChangesResult;
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
        running: sessionId !== undefined && (tabs.sessionStatus(sessionId)?.running ?? false),
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

  it('opens Session-pinned Changes and Workers Panels side by side, re-binds via @ui/select, opens Workers into the Tab, and prunes pinned Panels on Session delete', async () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const w1 = SessionId.make('worker-1');
    const summary = (id: SessionId, title: string): SessionSummary => ({
      id,
      agentId: AgentId.make('claude'),
      title: { auto: title, autoIsPlaceholder: false },
      lastActivityAt: Date.now(),
    });
    const liveWithWorkers = (workers: LiveState['workers']): LiveState => ({
      agentStatus: 'ready',
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

    // Open Changes from Session Panel header -> splits right and mounts ChangesPage pinned to s1.
    expect(host.querySelector('[data-testid="open-workers-count"]')?.textContent?.trim()).toBe('1');
    host.querySelector<HTMLButtonElement>('[data-testid="open-changes"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="changes-head"]')?.textContent).toContain('feat/one');
    });
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);
    expect(host.querySelector('[data-testid="panel-bound-session"]')?.textContent?.trim()).toBe(
      'One',
    );

    // Open a second Changes Panel pinned to s2 side by side in the same Tab.
    tabs.openChangesPanel(s2, allTabLeaves(tabs.activeTab()!)[0]!.id);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="changes-head"]')).toHaveLength(2);
    });
    const heads = [...host.querySelectorAll('[data-testid="changes-head"]')].map((el) =>
      el.textContent?.trim(),
    );
    expect(heads).toEqual(expect.arrayContaining(['feat/one', 'feat/two']));

    // Re-bind the first Changes Panel (pinned to s1) to s2 via @ui/select -> updates mounted ChangesPage.
    const firstChangesFrame = [
      ...host.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]'),
    ].find(
      (el) =>
        el.getAttribute('data-panel-kind') === 'Changes' &&
        el.querySelector('[data-testid="panel-bound-session"]')?.textContent?.trim() === 'One',
    )!;
    firstChangesFrame
      .querySelector<HTMLButtonElement>('[data-testid="panel-session-picker"] button')!
      .click();
    fixture.detectChanges();
    await fixture.whenStable();
    [...document.querySelectorAll<HTMLElement>('hlm-select-item')]
      .find((item) => item.textContent?.trim() === 'Two')!
      .click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        firstChangesFrame.querySelector('[data-testid="changes-head"]')?.textContent,
      ).toContain('feat/two');
    });
    expect(
      firstChangesFrame.querySelector('[data-testid="panel-bound-session"]')?.textContent?.trim(),
    ).toBe('Two');

    // Open Workers Panel from s1 header -> mounts WorkersPanelHost (4th Pane) and clicking Worker stacks at 4 Panes.
    host.querySelector<HTMLButtonElement>('[data-testid="open-workers"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelector('[data-testid="workers-panel"]')).not.toBeNull();
    });
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(4);
    host.querySelector<HTMLButtonElement>('[data-testid="worker-row"]')!.click();
    fixture.detectChanges();
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(4);
    expect(tabs.active()?.session).toBe(w1);

    // Deleting s2 removes both Changes Panels pinned to s2, collapsing their Panes cleanly.
    const sessionsState = TestBed.inject(SessionsState);
    await sessionsState.delete([{ id: s2, title: 'Two' }]);
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-action"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="changes-page"]')).toHaveLength(0);
    });
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(2);

    // Deleting s1 removes s1's Session Panel and pinned Workers Panel, leaving only w1.
    await sessionsState.delete([{ id: s1, title: 'One' }]);
    fixture.detectChanges();
    document.querySelector<HTMLButtonElement>('[data-testid="confirm-action"]')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(host.querySelectorAll('[data-testid="workers-panel"]')).toHaveLength(0);
    });
    expect(host.querySelectorAll('[data-testid="pane-view"]')).toHaveLength(1);
    expect(tabs.active()?.session).toBe(w1);
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
});
