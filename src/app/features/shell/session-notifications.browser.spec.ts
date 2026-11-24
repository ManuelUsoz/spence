import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { toast } from '@ui/toast';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import { NotificationsRpcs } from '../../../shared/notifications/notifications.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type SessionNotification,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type WorkspacePanel,
} from '../../../shared/tabs/tabs.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { BROWSER_PANE_VIEW } from '../../core/browser-pane';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { PANEL_DEFINITION } from '../../core/panel-registry';
import { Tabs } from '../../core/tabs';
import { SessionsState } from './sessions-state';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

@Component({
  selector: 'app-browser-session-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="session-view-stub">{{ panel().id }}</div>`,
})
class SessionViewStub {
  readonly panel = input.required<WorkspacePanel>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focused = input(true);
}

@Component({
  selector: 'app-browser-install-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

const p1 = ProjectId.make('p1');
const p2 = ProjectId.make('p2');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');

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

const defaultSettings = (overrides: Partial<Settings> = {}): Settings => ({
  language: 'system',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers',
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  agents: {},
  ...overrides,
});

const renderShell = async (options?: {
  readonly notifications?: Stream.Stream<SessionNotification>;
  readonly settings?: Settings;
  readonly archived?: SessionId[];
}) => {
  const settingsValue = options?.settings ?? defaultSettings();
  const s1Summary: SessionSummary = {
    id: s1,
    agentId: AgentId.make('claude'),
    title: { auto: 'Active work', autoIsPlaceholder: false },
    lastActivityAt: 100,
    status: 'idle',
  };
  const s2Summary: SessionSummary = {
    id: s2,
    agentId: AgentId.make('claude'),
    title: { auto: 'Background work', autoIsPlaceholder: false },
    lastActivityAt: 90,
    status: 'blocked',
  };

  const tab1 = TabId.make('t1');
  const pane1 = PaneId.make('pane1');
  const panel1 = PanelId.make('panel1');
  const tab2 = TabId.make('t2');
  const pane2 = PaneId.make('pane2');
  const panel2 = PanelId.make('panel2');

  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      AppInfoRpcs.toLayer({
        'AppInfo.get': () =>
          Effect.succeed({
            name: 'spence',
            version: '0.1.0',
            electron: '45.0.0',
            chrome: '136.0.0.0',
            node: '24.0.0',
            platform: 'win32',
            cwd: '/work',
          }),
      }),
      AgentsRpcs.toLayer({
        'Agents.list': () => Effect.succeed([]),
        'Agents.rescan': () => Effect.succeed([]),
        'Agents.install': () => Stream.die('unused'),
        'Agents.cancelInstall': () => Effect.die('unused'),
        'Agents.installStatus': () => Effect.die('unused'),
        'Agents.openInstallLog': () => Effect.die('unused'),
      }),
      SettingsRpcs.toLayer({
        'Settings.get': () => Effect.succeed(settingsValue),
        'Settings.update': () => Effect.succeed(settingsValue),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([project1, project2]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.addFolder': () => Effect.die('unused'),
        'Projects.locateFolder': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () =>
          Effect.succeed({
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
                            panels: [{ id: panel1, spec: { _tag: 'Session', sessionId: s1 } }],
                          },
                        ],
                      },
                    },
                  ],
                },
                {
                  projectId: p2,
                  activeTabId: tab2,
                  tabs: [
                    {
                      id: tab2,
                      focusedPanelId: panel2,
                      layout: {
                        rootPaneId: pane2,
                        nodes: [
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
              {
                id: s1,
                projectId: p1,
                title: s1Summary.title,
                status: 'idle',
              },
              {
                id: s2,
                projectId: p2,
                title: s2Summary.title,
                status: 'blocked',
              },
            ],
          }),
        'Tabs.update': () => Effect.void,
        'Tabs.setVisibility': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      NotificationsRpcs.toLayer({
        'Notifications.events': () => options?.notifications ?? Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': ({ projectId }) =>
          Effect.succeed(projectId === p1 ? [s1Summary] : projectId === p2 ? [s2Summary] : []),
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
        'Session.archive': ({ sessionId }) =>
          Effect.sync(() => {
            options?.archived?.push(sessionId);
          }),
        'Session.unarchive': () => Effect.void,
        'Session.countWorkers': () => Effect.succeed(0),
        'Session.delete': () => Effect.void,
      }),
    ),
  );

  await render(Shell, {
    providers: [
      provideRouter([]),
      { provide: DESKTOP_LAYER, useValue: layer },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
      { provide: BROWSER_PANE_VIEW, useValue: null },
      {
        provide: PANEL_DEFINITION,
        multi: true,
        useValue: { kind: 'Session', component: SessionViewStub },
      },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });

  const tabs = TestBed.inject(Tabs);
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  return { tabs, settings: TestBed.inject(SettingsState), sessions: TestBed.inject(SessionsState) };
};

describe('SessionNotifications (Chromium browser integration)', () => {
  afterEach(() => {
    toast.dismiss();
  });

  it('renders a visible toast in real Chromium, navigates + scrolls on Open, and auto-dismisses', async () => {
    const notifications = Queue.make<SessionNotification>().pipe(Effect.runSync);
    const { tabs, settings } = await renderShell({
      notifications: Stream.fromQueue(notifications),
    });

    settings.show();
    expect(settings.open()).toBe(true);

    const turn1 = TurnId.make('turn-open');
    Queue.offerUnsafe(notifications, {
      sessionId: s2,
      projectId: p2,
      turnId: turn1,
      cause: 'blocked',
      title: 'Background work',
      sessionTitle: { auto: 'Background work', autoIsPlaceholder: false },
    });

    const toastEl = await screen.findByTestId('session-notification-toast');
    expect(toastEl.textContent).toContain('Background work');
    expect(toastEl.textContent).toContain('Waiting for your answer');

    const openBtn = await screen.findByRole('button', { name: 'Open' });
    fireEvent.click(openBtn);

    await vi.waitFor(() => {
      expect(settings.open()).toBe(false);
      expect(tabs.activeProjectId()).toBe(p2);
      expect(tabs.active()?.session).toBe(s2);
      expect(tabs.pendingTurnScroll()).toEqual({ sessionId: s2, turnId: turn1 });
      expect(screen.queryByTestId('session-notification-toast')).toBeNull();
    });

    // Verify standard auto-dismiss timeout removes a subsequent Session notification toast.
    Queue.offerUnsafe(notifications, {
      sessionId: s1,
      projectId: p1,
      cause: 'turnFinished',
      title: 'Active work',
      sessionTitle: { auto: 'Active work', autoIsPlaceholder: false },
    });

    expect(await screen.findByText('Turn finished')).toBeTruthy();
    await vi.waitFor(
      () => {
        expect(screen.queryByTestId('session-notification-toast')).toBeNull();
      },
      { timeout: 6000 },
    );
  });

  it('keeps user-action feedback toasts (Archive Undo) active when Settings.notifications is false', async () => {
    const archived: SessionId[] = [];
    const { sessions } = await renderShell({
      settings: defaultSettings({ notifications: false }),
      archived,
    });

    await sessions.archive([{ id: s1, title: 'Active work' }]);
    expect(archived).toEqual([s1]);

    expect(await screen.findByText('Archived Active work')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeTruthy();
  });
});
