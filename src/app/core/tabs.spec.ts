import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { assert, describe, expect, it, vi } from 'vitest';
import { DeviceId } from '../../shared/devices/devices.rpc';
import { ProjectId } from '../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../shared/sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type RestoredSessionInfo,
  type RestoredWorkspace,
  type TabActivation,
  type WorkspaceState,
} from '../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, allTabLeaves, allTabPanels } from '../../shared/tabs/workspace-layout';
import { ChatBackgrounds } from './chat-backgrounds';
import { makeDesktopTestLayer } from './desktop-layers';
import { DESKTOP_LAYER } from './effect-runtime';
import { Tabs, titleOf } from './tabs';

const app = ProjectId.make('app');
const api = ProjectId.make('api');
const fixBuild = { id: SessionId.make('s1'), projectId: app, title: 'Fix the build' };
const addLogin = { id: SessionId.make('s2'), projectId: api, title: 'Add login' };
const polishUi = { id: SessionId.make('s3'), projectId: app, title: 'Polish UI' };

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  title: { auto: 'Fix the build', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

const tabsLayer = (options?: {
  readonly restored?: RestoredWorkspace;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly activations?: Stream.Stream<TabActivation>;
  readonly updates?: Array<WorkspaceState>;
  readonly remoteUpdates?: Array<ReadonlyArray<RestoredSessionInfo> | undefined>;
}) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () =>
          Effect.succeed(options?.restored ?? { workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': ({ workspace, remoteSessions }) =>
          Effect.sync(() => {
            options?.updates?.push(workspace);
            options?.remoteUpdates?.push(remoteSessions);
          }),
        'Tabs.activations': () => options?.activations ?? Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => options?.changes ?? Stream.empty,
        'Session.list': () => Effect.die('unused'),
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
        'Session.events': () => Stream.die('unused'),
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

const tabs = async (options?: Parameters<typeof tabsLayer>[0]): Promise<Tabs> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: tabsLayer(options) }],
  });
  const state = TestBed.inject(Tabs);
  await vi.waitFor(() => expect(state.restored()).toBe(true));
  return state;
};

describe('Tabs', () => {
  it('maintains per-Project Tab strips and switches Projects while preserving background Tabs', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    state.open(fixBuild);
    state.open(polishUi);
    expect(state.activeProjectId()).toBe(app);
    expect(state.tabs().map((tab) => state.tabTitle(tab).label)).toEqual([
      'Fix the build',
      'Polish UI',
    ]);
    expect(state.active()?.title).toBe('Polish UI');

    // Opening a Session in another Project switches activeProjectId and active Tab strip.
    state.open(addLogin);
    expect(state.activeProjectId()).toBe(api);
    expect(state.tabs().map((tab) => state.tabTitle(tab).label)).toEqual(['Add login']);
    expect(state.isOpen(fixBuild.id)).toBe(true);
    expect(state.isOpen(addLogin.id)).toBe(true);

    // Switching Project in the sidebar swaps the visible Tab strip back to app without closing api's Tab.
    state.switchProject(app);
    expect(state.activeProjectId()).toBe(app);
    expect(state.tabs().map((tab) => state.tabTitle(tab).label)).toEqual([
      'Fix the build',
      'Polish UI',
    ]);
    expect(state.active()?.session).toBe(polishUi.id);

    // Re-opening addLogin switches back to api and focuses its existing Tab.
    state.open(addLogin);
    expect(state.activeProjectId()).toBe(api);
    expect(state.tabs()).toHaveLength(1);
    expect(updates.at(-1)?.projects).toHaveLength(2);
  });

  it('starts a reusable draft on startDraft vs always opening a fresh draft Tab on newTab', async () => {
    const state = await tabs();

    const d1 = state.startDraft(app);
    expect(state.active()?.session).toBeNull();
    expect(state.draftOf(app)?.id).toBe(d1.id);
    expect(state.draftOf(api)).toBeNull();

    state.open(fixBuild);
    expect(state.startDraft(app).id).toBe(d1.id);
    expect(state.tabs()).toHaveLength(2);

    // newTab always opens a new Tab even when a draft already exists in the Project.
    const d2 = state.newTab(app);
    expect(d2.id).not.toBe(d1.id);
    expect(state.tabs()).toHaveLength(3);
    expect(state.activeTab()?.id).toBe(d2.id);
  });

  it('renames Tabs with customTitle and clears customTitle on blank', async () => {
    const state = await tabs();
    const tab = state.open(fixBuild);
    expect(state.tabTitle(tab)).toEqual({ label: 'Fix the build', untitled: false, custom: false });

    state.renameTab(tab.id, '  Auth refactor  ');
    expect(state.tabTitle(state.activeTab()!)).toEqual({
      label: 'Auth refactor',
      untitled: false,
      custom: true,
    });

    state.renameTab(tab.id, '   ');
    expect(state.tabTitle(state.activeTab()!)).toEqual({
      label: 'Fix the build',
      untitled: false,
      custom: false,
    });
  });

  it('closes Tabs and Panels shifting active Tab to neighbor within the active Project', async () => {
    const state = await tabs();
    const d1 = state.newTab(app);
    const t1 = state.open(fixBuild);
    const t2 = state.open(polishUi);
    state.open(addLogin);
    state.switchProject(app);
    state.activateTab(t1.id);
    expect(state.active()?.session).toBe(fixBuild.id);

    state.closeTab(t1.id);
    expect(state.tabs().map((t) => t.id)).toEqual([d1.id, t2.id]);
    expect(state.activeTab()?.id).toBe(t2.id);

    // Closing the focused Panel in a single-Panel Tab closes the Tab.
    state.closePanel(state.focusedPanel()!.id);
    expect(state.tabs().map((t) => t.id)).toEqual([d1.id]);

    state.closeTab(d1.id);
    expect(state.tabs()).toEqual([]);
    expect(state.active()).toBeNull();
    // api's Tab remains open in the background.
    expect(state.isOpen(addLogin.id)).toBe(true);
  });

  it('cycles and jumps within the active Project Tab strip only', async () => {
    const state = await tabs();
    state.next();
    state.prev();
    state.activateIndex(0);
    state.activateLast();
    expect(state.active()).toBeNull();

    const t1 = state.newTab(app);
    const t2 = state.open(fixBuild);
    const t3 = state.open(polishUi);
    state.open(addLogin);
    state.switchProject(app);
    state.activateTab(t1.id);

    state.next();
    expect(state.activeTab()?.id).toBe(t2.id);
    state.next();
    expect(state.activeTab()?.id).toBe(t3.id);
    state.next();
    expect(state.activeTab()?.id).toBe(t1.id);

    state.prev();
    expect(state.activeTab()?.id).toBe(t3.id);

    state.activateIndex(0);
    expect(state.activeTab()?.id).toBe(t1.id);
    state.activateIndex(9);
    expect(state.activeTab()?.id).toBe(t1.id);
    state.activateLast();
    expect(state.activeTab()?.id).toBe(t3.id);
  });

  it('restores WorkspaceState, drafts, customTitle, attention, and running state at launch', async () => {
    const draftId = SessionId.make('draft-session');
    const tApi = TabId.make('tab-api');
    const tApp = TabId.make('tab-app');
    const tDraft = TabId.make('tab-draft');
    const pApi = PanelId.make('panel-api');
    const pApp = PanelId.make('panel-app');
    const pDraft = PanelId.make('panel-draft');

    const state = await tabs({
      restored: {
        workspace: {
          activeProjectId: app,
          projects: [
            {
              projectId: api,
              activeTabId: tApi,
              tabs: [
                {
                  id: tApi,
                  customTitle: 'API auth',
                  focusedPanelId: pApi,
                  layout: {
                    rootPaneId: PaneId.make('pane-api'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-api'),
                        panels: [
                          {
                            id: pApi,
                            spec: { _tag: 'Session', sessionId: addLogin.id },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              projectId: app,
              activeTabId: tApp,
              tabs: [
                {
                  id: tApp,
                  focusedPanelId: pApp,
                  layout: {
                    rootPaneId: PaneId.make('pane-app'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-app'),
                        panels: [
                          {
                            id: pApp,
                            spec: { _tag: 'Session', sessionId: fixBuild.id },
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  id: tDraft,
                  focusedPanelId: pDraft,
                  layout: {
                    rootPaneId: PaneId.make('pane-draft'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-draft'),
                        panels: [
                          {
                            id: pDraft,
                            spec: { _tag: 'Session', sessionId: draftId, draft: true },
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
          {
            id: addLogin.id,
            projectId: api,
            title: { auto: addLogin.title, autoIsPlaceholder: false },
            attention: 'needsAnswer',
            running: true,
          },
          {
            id: fixBuild.id,
            projectId: app,
            title: { auto: fixBuild.title, autoIsPlaceholder: false },
          },
          {
            id: draftId,
            projectId: app,
            title: { autoIsPlaceholder: false },
          },
        ],
      },
    });

    expect(state.activeProjectId()).toBe(app);
    expect(state.tabs().map((t) => state.tabTitle(t).label)).toEqual([
      'Fix the build',
      'New Session',
    ]);
    expect(state.active()?.session).toBe(fixBuild.id);
    expect(state.draftOf(app)?.id).toBe(tDraft);

    state.switchProject(api);
    expect(state.tabs().map((t) => state.tabTitle(t).label)).toEqual(['API auth']);
    expect(state.tabActivity(state.activeTab()!)).toBe('needsAnswer');
  });

  it('tracks live attention, running, and title updates from Session.changes and handles Tabs.activations across Tabs', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const tApp = TabId.make('tab-app');
    const tApp2 = TabId.make('tab-app-2');
    const pApp = PanelId.make('panel-app');
    const pApp2 = PanelId.make('panel-app-2');

    const state = await tabs({
      changes: Stream.fromQueue(changes),
      activations: Stream.fromQueue(activations),
      restored: {
        workspace: {
          activeProjectId: api,
          projects: [
            {
              projectId: app,
              activeTabId: tApp,
              tabs: [
                {
                  id: tApp,
                  focusedPanelId: pApp,
                  layout: {
                    rootPaneId: PaneId.make('pane-app'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-app'),
                        panels: [{ id: pApp, spec: { _tag: 'Session', sessionId: fixBuild.id } }],
                      },
                    ],
                  },
                },
                {
                  id: tApp2,
                  focusedPanelId: pApp2,
                  layout: {
                    rootPaneId: PaneId.make('pane-app-2'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-app-2'),
                        panels: [{ id: pApp2, spec: { _tag: 'Session', sessionId: polishUi.id } }],
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
            id: fixBuild.id,
            projectId: app,
            title: { auto: fixBuild.title, autoIsPlaceholder: false },
          },
          {
            id: polishUi.id,
            projectId: app,
            title: { auto: polishUi.title, autoIsPlaceholder: false },
          },
        ],
      },
    });

    Queue.offerUnsafe(changes, {
      sessionId: fixBuild.id,
      projectId: app,
      state: liveState({
        attention: 'error',
        runningTurn: TurnId.make('t1'),
        title: { auto: 'Updated title', autoIsPlaceholder: false },
      }),
    });

    state.switchProject(app);
    await vi.waitFor(() => {
      const tab = state.activeTab()!;
      expect(state.tabTitle(tab).label).toBe('Updated title');
      expect(state.tabActivity(tab)).toBe('error');
    });

    // OS notification click for background polishUi switches Project and focuses its Tab/Panel.
    state.open(addLogin);
    expect(state.activeProjectId()).toBe(api);

    Queue.offerUnsafe(activations, {
      sessionId: polishUi.id,
      projectId: app,
      title: { auto: polishUi.title, autoIsPlaceholder: false },
    });

    await vi.waitFor(() => expect(state.activeProjectId()).toBe(app));
    expect(state.activeTab()?.id).toBe(tApp2);
    expect(state.focusedPanel()?.id).toBe(pApp2);
  });

  it("opens a Remote Session's Tab on its Device when its notification is clicked", async () => {
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const state = await tabs({ activations: Stream.fromQueue(activations) });
    const studio = DeviceId.make('device-studio');

    Queue.offerUnsafe(activations, {
      device: studio,
      sessionId: addLogin.id,
      projectId: api,
      title: { auto: 'Add login', autoIsPlaceholder: false },
    });

    await vi.waitFor(() =>
      expect(state.active()).toMatchObject({ session: addLogin.id, device: studio }),
    );
  });

  it('closes Sessions and Projects cleanly, and promotes drafts by PanelId', async () => {
    const state = await tabs();
    const v0 = state.sessionsVersion();
    const draft = state.newTab(app);
    const draftPanelId = draft.focusedPanelId;

    state.attachDraft(draftPanelId, fixBuild.id);
    expect(state.active()?.draftSession).toBe(fixBuild.id);
    expect(state.active()?.session).toBeNull();

    state.keep(draftPanelId, fixBuild.id);
    expect(state.sessionsVersion()).toBe(v0 + 1);
    expect(state.active()?.session).toBe(fixBuild.id);

    state.open(addLogin);
    state.closeSession(fixBuild.id);
    expect(state.isOpen(fixBuild.id)).toBe(false);
    expect(state.isOpen(addLogin.id)).toBe(true);

    state.closeProject(api);
    expect(state.isOpen(addLogin.id)).toBe(false);
    expect(state.activeProjectId()).toBeNull();
  });

  it('focuses another Pane Panel inside a Split Tab without duplicating updates', async () => {
    const updates: WorkspaceState[] = [];
    const tApp = TabId.make('tab-app');
    const splitId = PaneId.make('split-app');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const p1 = PanelId.make('panel-1');
    const p2 = PanelId.make('panel-2');

    const state = await tabs({
      updates,
      restored: {
        workspace: {
          activeProjectId: app,
          projects: [
            {
              projectId: app,
              activeTabId: tApp,
              tabs: [
                {
                  id: tApp,
                  focusedPanelId: p1,
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
                        panels: [{ id: p1, spec: { _tag: 'Session', sessionId: fixBuild.id } }],
                      },
                      {
                        _tag: 'Leaf',
                        id: pane2,
                        panels: [{ id: p2, spec: { _tag: 'Session', sessionId: polishUi.id } }],
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
            id: fixBuild.id,
            projectId: app,
            title: { auto: fixBuild.title, autoIsPlaceholder: false },
          },
          {
            id: polishUi.id,
            projectId: app,
            title: { auto: polishUi.title, autoIsPlaceholder: false },
          },
        ],
      },
    });

    const beforeUpdates = updates.length;
    // Already focused -> no-op.
    state.focusPanel(p1);
    expect(updates.length).toBe(beforeUpdates);

    state.focusPanel(p2);
    expect(state.focusedPanel()?.id).toBe(p2);
    expect(updates.length).toBe(beforeUpdates + 1);
  });

  it('splits Panes up to the 4-Pane cap, clamps and persists split ratios, and collapses empty Panes on close or delete', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    const tab = state.open(fixBuild);
    expect(state.paneCount(tab)).toBe(1);
    const firstPaneId = allTabLeaves(tab)[0]!.id;

    // 1-up -> side-by-side (horizontal split right).
    const rightPanelId = state.splitPane(firstPaneId, 'right');
    expect(rightPanelId).not.toBeNull();
    let active = state.activeTab()!;
    expect(state.paneCount(active)).toBe(2);
    expect(active.focusedPanelId).toBe(rightPanelId);
    const rootSplit = active.layout.nodes.find((n) => n.id === active.layout.rootPaneId);
    expect(rootSplit?._tag).toBe('Split');
    if (rootSplit?._tag === 'Split') {
      expect(rootSplit.direction).toBe('horizontal');
      expect(rootSplit.ratio).toBe(0.5);
      expect(rootSplit.first).toBe(firstPaneId);
    }

    // Side-by-side -> 1+2 (vertical split bottom on the right Pane).
    const rightPaneId = allTabLeaves(active)[1]!.id;
    const bottomRightPanelId = state.splitPane(rightPaneId, 'bottom', {
      _tag: 'Session',
      sessionId: polishUi.id,
    });
    expect(bottomRightPanelId).not.toBeNull();
    active = state.activeTab()!;
    expect(state.paneCount(active)).toBe(3);
    expect(active.focusedPanelId).toBe(bottomRightPanelId);

    // 1+2 -> 2x2 (vertical split top on the left Pane — new Pane becomes first child).
    const topLeftPanelId = state.splitPane(firstPaneId, 'top');
    expect(topLeftPanelId).not.toBeNull();
    active = state.activeTab()!;
    expect(state.paneCount(active)).toBe(4);
    expect(allTabLeaves(active)[0]!.panels[0]!.id).toBe(topLeftPanelId);

    // 5th split is blocked at MAX_PANES_PER_TAB = 4 without emitting Tabs.update.
    const updatesBeforeCap = updates.length;
    expect(state.splitPane(firstPaneId, 'left')).toBeNull();
    expect(state.paneCount(state.activeTab()!)).toBe(4);
    expect(updates.length).toBe(updatesBeforeCap);

    // Resizing clamps ratios to [0.15, 0.85], persists via Tabs.update, and no-ops when unchanged.
    const rootId = active.layout.rootPaneId;
    state.setSplitRatio(active.id, rootId, 0.35);
    let updatedRoot = state.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(updatedRoot?._tag === 'Split' ? updatedRoot.ratio : null).toBe(0.35);
    expect(updates.at(-1)).toEqual(state.workspace());

    const updatesBeforeNoop = updates.length;
    state.setSplitRatio(active.id, rootId, 0.35);
    expect(updates.length).toBe(updatesBeforeNoop);

    state.setSplitRatio(active.id, rootId, 0.02);
    updatedRoot = state.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(updatedRoot?._tag === 'Split' ? updatedRoot.ratio : null).toBe(0.15);

    state.setSplitRatio(active.id, rootId, 0.99);
    updatedRoot = state.activeTab()!.layout.nodes.find((n) => n.id === rootId);
    expect(updatedRoot?._tag === 'Split' ? updatedRoot.ratio : null).toBe(0.85);

    // Deleting a Session (closeSession) removes its Panel and collapses its Pane while preserving root split ratio.
    state.closeSession(polishUi.id);
    active = state.activeTab()!;
    expect(state.paneCount(active)).toBe(3);
    updatedRoot = active.layout.nodes.find((n) => n.id === rootId);
    expect(updatedRoot?._tag === 'Split' ? updatedRoot.ratio : null).toBe(0.85);

    // Closing remaining Panes collapses Splits cleanly until closing the last Pane closes the Tab.
    state.closePanel(topLeftPanelId!);
    expect(state.paneCount(state.activeTab()!)).toBe(2);
    state.closePanel(rightPanelId!);
    expect(state.paneCount(state.activeTab()!)).toBe(1);
    expect(state.activeTab()!.layout.rootPaneId).toBe(firstPaneId);
    state.closePanel(state.focusedPanel()!.id);
    expect(state.tabs()).toEqual([]);
  });

  it('opens Sessions into a split Pane while enforcing max-1-Panel-per-Session uniqueness and the 4-Pane cap', async () => {
    const updates: WorkspaceState[] = [];
    const s4 = { id: SessionId.make('s4'), projectId: app, title: 'Fourth' };
    const s5 = { id: SessionId.make('s5'), projectId: app, title: 'Fifth' };
    const s6 = { id: SessionId.make('s6'), projectId: app, title: 'Sixth' };
    const tApi = TabId.make('tab-api');
    const tApiSecond = TabId.make('tab-api-second');
    const pLogin = PanelId.make('panel-login-api');
    const pOther = PanelId.make('panel-other-api');
    const otherApi = SessionId.make('s-api-other');

    const state = await tabs({
      updates,
      restored: {
        workspace: {
          activeProjectId: app,
          projects: [
            {
              projectId: api,
              activeTabId: tApi,
              tabs: [
                {
                  id: tApi,
                  focusedPanelId: pOther,
                  layout: {
                    rootPaneId: PaneId.make('pane-api'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-api'),
                        panels: [{ id: pOther, spec: { _tag: 'Session', sessionId: otherApi } }],
                      },
                    ],
                  },
                },
                {
                  id: tApiSecond,
                  focusedPanelId: pLogin,
                  layout: {
                    rootPaneId: PaneId.make('pane-api-2'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-api-2'),
                        panels: [{ id: pLogin, spec: { _tag: 'Session', sessionId: addLogin.id } }],
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
            id: otherApi,
            projectId: api,
            title: { auto: 'Other API', autoIsPlaceholder: false },
          },
          {
            id: addLogin.id,
            projectId: api,
            title: { auto: addLogin.title, autoIsPlaceholder: false },
          },
        ],
      },
    });

    // Project `app` starts with 0 Tabs: openSessionInSplit creates its first single-Pane Tab.
    const firstTab = state.openSessionInSplit(fixBuild);
    expect(firstTab).not.toBeNull();
    expect(state.tabs()).toHaveLength(1);
    expect(state.paneCount(state.activeTab()!)).toBe(1);
    expect(state.active()?.session).toBe(fixBuild.id);

    // Opening a second Session in split splits the active Tab side-by-side (2 Panes).
    const split2 = state.openSessionInSplit(polishUi, 'right');
    expect(split2?.id).toBe(firstTab!.id);
    expect(state.paneCount(state.activeTab()!)).toBe(2);
    expect(state.active()?.session).toBe(polishUi.id);

    // Re-opening fixBuild via openSessionInSplit focuses its existing Panel instead of duplicating it.
    const refocused = state.openSessionInSplit(fixBuild);
    expect(refocused?.id).toBe(firstTab!.id);
    expect(state.paneCount(state.activeTab()!)).toBe(2);
    expect(state.active()?.session).toBe(fixBuild.id);

    // Fill to 4 Panes in app's active Tab.
    expect(state.openSessionInSplit(s4, 'bottom')).not.toBeNull();
    expect(state.openSessionInSplit(s5, 'bottom')).not.toBeNull();
    expect(state.paneCount(state.activeTab()!)).toBe(4);

    // Opening a 5th unopened Session in split is blocked at the 4-Pane cap with no Tabs.update.
    const updatesBeforeCap = updates.length;
    expect(state.openSessionInSplit(s6)).toBeNull();
    expect(state.paneCount(state.activeTab()!)).toBe(4);
    expect(state.isOpen(s6.id)).toBe(false);
    expect(updates.length).toBe(updatesBeforeCap);

    // Opening an already-open Session in another Project while active Tab is at 4 Panes still focuses it.
    const focusedExisting = state.openSessionInSplit(addLogin);
    expect(focusedExisting?.id).toBe(tApiSecond);
    expect(state.activeProjectId()).toBe(api);
    expect(state.focusedPanel()?.id).toBe(pLogin);
  });

  it('resolves SessionTitle with user > auto > image count > null', () => {
    expect(titleOf({ autoIsPlaceholder: false })).toBeNull();
    expect(titleOf({ autoImageCount: 1, autoIsPlaceholder: true })).toBe('Image');
    expect(titleOf({ autoImageCount: 3, autoIsPlaceholder: true })).toBe('3 Images');
    expect(titleOf({ auto: 'Auto', autoImageCount: 2, autoIsPlaceholder: false })).toBe('Auto');
    expect(
      titleOf({ user: 'Custom', auto: 'Auto', autoImageCount: 2, autoIsPlaceholder: false }),
    ).toBe('Custom');
  });

  it('opens, rebinds, and dismisses full-Tab Changes and Workers overlays and opens Workers in the Parent Pane', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    const tab = state.open(fixBuild);
    state.open(polishUi);
    state.activateTab(tab.id);
    const sourcePaneId = allTabLeaves(state.activeTab()!)[0]!.id;
    const beforeOverlayUpdates = updates.length;

    // Opening Changes shows full-Tab overlay on `tab` without modifying Panes or emitting Tabs.update.
    expect(state.openChangesPanel(fixBuild.id, sourcePaneId)).toBe(tab.id);
    expect(updates.length).toBe(beforeOverlayUpdates);
    expect(state.paneCount(state.activeTab()!)).toBe(1);
    expect(state.activeTabOverlay()).toEqual({
      kind: 'Changes',
      sessionId: fixBuild.id,
      sourcePaneId,
    });

    // Rebinding overlay updates its sessionId cleanly.
    state.rebindTabOverlaySession(tab.id, polishUi.id);
    expect(state.tabOverlay(tab.id)?.sessionId).toBe(polishUi.id);

    // Opening Workers switches the overlay to Workers; closeTabOverlay dismisses it back to Panes.
    expect(state.openWorkersPanel(fixBuild.id, sourcePaneId)).toBe(tab.id);
    expect(state.activeTabOverlay()?.kind).toBe('Workers');
    state.closeTabOverlay(tab.id);
    expect(state.activeTabOverlay()).toBeNull();

    const worker1 = { id: SessionId.make('w1'), projectId: app, title: 'Worker One' };
    const worker2 = { id: SessionId.make('w2'), projectId: app, title: 'Worker Two' };
    const ancestors = [fixBuild.id];
    const otherSessions = ['Alpha', 'Beta', 'Gamma'].map((title) => ({
      id: SessionId.make(title),
      projectId: app,
      title,
    }));

    state.openWorkerInSplit(worker1, ancestors);
    const split = state.activeTab();
    const splitWorker = state.active();
    assert(split !== null && splitWorker !== null);
    expect(state.paneCount(split)).toBe(2);
    state.returnToParent(fixBuild, splitWorker.panelId);
    for (const session of otherSessions) state.openSessionInSplit(session);
    const before = state.activeTab();
    assert(before !== null);
    expect(state.paneCount(before)).toBe(4);
    expect(state.canOpenWorkerInSplit(worker1.id, app, ancestors)).toBe(false);

    state.openWorkersPanel(fixBuild.id, sourcePaneId);
    expect(state.openWorkerFromPanel(worker1, ancestors, sourcePaneId).id).toBe(tab.id);
    expect(state.activeTabOverlay()).toBeNull();
    expect(state.active()?.session).toBe(worker1.id);
    const workerPanel = state.active()?.panelId;
    state.openWorkerFromPanel(worker1, ancestors);
    expect(state.active()?.panelId).toBe(workerPanel);

    const switched = state.openWorkerFromPanel(worker2, ancestors);
    expect(state.isOpen(worker1.id)).toBe(false);
    expect(state.active()?.session).toBe(worker2.id);
    expect(state.tabs()).toHaveLength(2);
    const beforeByPane = new Map(before.layout.nodes.map((node) => [node.id, node]));
    for (const node of switched.layout.nodes) {
      if (node.id !== sourcePaneId) expect(node).toEqual(beforeByPane.get(node.id));
    }

    const worker = state.active();
    assert(worker !== null);
    const restored = state.returnToParent(fixBuild, worker.panelId);
    expect(state.active()?.session).toBe(fixBuild.id);
    expect(state.activeTab()?.id).toBe(tab.id);
    expect(state.paneCount(restored)).toBe(4);
    expect(
      allTabLeaves(restored).find((pane) => pane.id === sourcePaneId)?.panels[0]?.spec,
    ).toEqual({
      _tag: 'Session',
      sessionId: fixBuild.id,
      retainedSessions: [worker1.id, worker2.id],
    });

    state.openWorkerFromPanel(worker1, ancestors);
    state.openWorkersPanel(worker1.id, sourcePaneId);
    state.closeSessionWithDescendants(fixBuild.id);
    expect(state.isOpen(worker1.id)).toBe(false);
    expect(state.tabOverlay(tab.id)).toBeNull();
  });

  it('returns through nested Workers in the same Pane', async () => {
    const state = await tabs();
    const tab = state.open(fixBuild);
    const child = { id: SessionId.make('child'), projectId: app, title: 'Child' };
    const grandchild = { id: SessionId.make('grandchild'), projectId: app, title: 'Grandchild' };
    state.openWorkerFromPanel(child, [fixBuild.id]);
    state.openWorkerFromPanel(grandchild, [child.id]);

    const grandchildPanel = state.active();
    assert(grandchildPanel !== null);
    const childTab = state.returnToParent(child, grandchildPanel.panelId);
    expect(state.active()?.session).toBe(child.id);
    expect(childTab.layout.rootPaneId).toBe(tab.layout.rootPaneId);

    const childPanel = state.active();
    assert(childPanel !== null);
    const parentTab = state.returnToParent(fixBuild, childPanel.panelId);
    expect(state.active()?.session).toBe(fixBuild.id);
    expect(parentTab.layout.rootPaneId).toBe(tab.layout.rootPaneId);
    expect(state.tabs()).toHaveLength(1);
  });

  it('tracks per-Project MRU Tab order in mruTabs', async () => {
    const state = await tabs();
    const t1 = state.open(fixBuild);
    const t2 = state.open(polishUi);
    const t3 = state.newTab(app);
    expect(state.mruTabs().map((t) => t.id)).toEqual([t3.id, t2.id, t1.id]);

    state.activateTab(t1.id);
    expect(state.mruTabs().map((t) => t.id)).toEqual([t1.id, t3.id, t2.id]);
    // Strip order remains unchanged.
    expect(state.tabs().map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
  });

  it('assigns varied per-Session wallpapers, resolves modes, and preserves draft wallpaper pick when kept', async () => {
    const state = await tabs();
    const backgrounds = TestBed.inject(ChatBackgrounds);
    backgrounds.applySettings({
      chatBackgroundMode: 'different',
      customWallpapers: [
        { id: 'custom-amber', name: 'Amber', mimeType: 'image/png', data: 'AQID' },
        { id: 'custom-rose', name: 'Rose', mimeType: 'image/png', data: 'BAUG' },
      ],
    });
    const t1 = state.newTab(app);
    const draftPanel = allTabPanels(t1)[0]!;
    state.setPanelWallpaper(draftPanel.id, 'custom-rose');
    expect(state.panelWallpaper(draftPanel)?.id).toBe('custom-rose');

    // Attaching and promoting keeps the user's picked wallpaper on the Session in WorkspaceState.
    state.attachDraft(draftPanel.id, fixBuild.id);
    state.keep(draftPanel.id, fixBuild.id);
    expect(state.workspace().sessionWallpapers?.[fixBuild.id]).toBe('custom-rose');
    expect(state.panelWallpaperId(allTabPanels(state.activeTab()!)[0]!)).toBe('custom-rose');
    const other = state.open(polishUi);
    expect(state.panelWallpaper(allTabPanels(other)[0]!)?.id).toBe('custom-amber');
    state.activateTab(t1.id);

    // Mode 'same' overrides panelWallpaper with selectedId; 'solid' hides it cleanly.
    backgrounds.applySettings({ chatBackgroundMode: 'same', chatBackgroundId: 'custom-amber' });
    expect(state.panelWallpaper(allTabPanels(state.activeTab()!)[0]!)?.id).toBe('custom-amber');
    backgrounds.applySettings({ chatBackgroundMode: 'solid' });
    expect(state.panelWallpaper(allTabPanels(state.activeTab()!)[0]!)).toBeNull();
    backgrounds.applySettings({ chatBackgroundMode: 'different' });
    expect(state.panelWallpaper(allTabPanels(state.activeTab()!)[0]!)?.id).toBe('custom-rose');
  });

  it('computes panelActivity and aggregates tabActivity across all Panels with priority needsAnswer > error > running', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const state = await tabs({ changes: Stream.fromQueue(changes) });

    const tab = state.open(fixBuild);
    const paneId = allTabLeaves(tab)[0]!.id;
    state.splitPane(paneId, 'right', { _tag: 'Session', sessionId: polishUi.id });
    state.splitPane(paneId, 'bottom');
    const panels = allTabPanels(state.activeTab()!);
    const fixPanel = panels[0]!;
    const draftPanel = panels[1]!;
    const polishPanel = panels[2]!;

    // Initially no activity and draft without sessionId has null activity.
    expect(state.panelActivity(draftPanel)).toBeNull();
    expect(state.panelActivity(fixPanel)).toBeNull();
    expect(state.tabActivity(state.activeTab()!)).toBeNull();

    // Non-Session panel has null activity.
    expect(
      state.panelActivity({
        id: PanelId.make('changes-1'),
        spec: { _tag: 'Changes', sessionId: fixBuild.id },
      }),
    ).toBeNull();

    // Running Panel reports 'running' on both panelActivity and tabActivity.
    Queue.offerUnsafe(changes, {
      sessionId: fixBuild.id,
      projectId: app,
      state: liveState({ runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      const currentFix = allTabPanels(state.activeTab()!)[0]!;
      expect(state.panelActivity(currentFix)).toBe('running');
      expect(state.tabActivity(state.activeTab()!)).toBe('running');
    });

    // Error on another Panel overrides 'running' on tabActivity.
    Queue.offerUnsafe(changes, {
      sessionId: polishUi.id,
      projectId: app,
      state: liveState({ attention: 'error' }),
    });
    await vi.waitFor(() => {
      expect(state.panelActivity(polishPanel)).toBe('error');
      expect(state.tabActivity(state.activeTab()!)).toBe('error');
    });

    // needsAnswer overrides both error and running, and panelActivity prefers needsAnswer over running on same Session.
    Queue.offerUnsafe(changes, {
      sessionId: fixBuild.id,
      projectId: app,
      state: liveState({ attention: 'needsAnswer', runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      expect(state.panelActivity(fixPanel)).toBe('needsAnswer');
      expect(state.tabActivity(state.activeTab()!)).toBe('needsAnswer');
    });
  });

  it('moves Panels across splits, swaps two Panes cleanly, checks canDropSplit, and reorders Tabs via Tabs.update', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    const tab1 = state.open(fixBuild);
    const pane1 = allTabLeaves(tab1)[0]!.id;
    const panel1 = tab1.focusedPanelId;
    const panel2 = state.splitPane(pane1, 'right')!;
    const pane2 = allTabLeaves(state.activeTab()!).find((leaf) =>
      leaf.panels.some((p) => p.id === panel2),
    )!.id;

    expect(state.canDropSplit(tab1.id, pane1, pane1)).toBe(false);
    expect(state.canDropSplit(tab1.id, pane1, pane2)).toBe(true);

    // Swap panel1 and panel2 across pane1 and pane2 via swapPanelToPane -> persists cleanly.
    const updatesBeforeSwap = updates.length;
    expect(state.swapPanelToPane(panel1, pane2)).toBe(true);
    expect(updates.length).toBe(updatesBeforeSwap + 1);
    expect(
      allTabLeaves(state.activeTab()!)
        .find((l) => l.id === pane2)
        ?.panels.map((p) => p.id),
    ).toEqual([panel1]);
    expect(
      allTabLeaves(state.activeTab()!)
        .find((l) => l.id === pane1)
        ?.panels.map((p) => p.id),
    ).toEqual([panel2]);

    // Move panel1 to split below pane1 -> keeps 2 Panes while changing split direction.
    expect(state.movePanelToSplit(panel1, pane1, 'bottom')).toBe(true);
    expect(state.paneCount(state.activeTab()!)).toBe(2);

    // Fill to 4 Panes; moving any lone Panel to another Pane edge stays allowed because source collapses cleanly.
    state.splitPane(pane1, 'right');
    state.splitPane(pane1, 'bottom');
    expect(state.paneCount(state.activeTab()!)).toBe(4);
    const paneFor1 = allTabLeaves(state.activeTab()!).find((l) =>
      l.panels.some((p) => p.id === panel1),
    )!.id;
    expect(state.canDropSplit(tab1.id, paneFor1, pane1)).toBe(true);
    expect(state.movePanelToSplit(panel1, pane1, 'left')).toBe(true);
    expect(state.paneCount(state.activeTab()!)).toBe(4);

    // Reorder Tabs in app without affecting api or activeTabId.
    const t2 = state.newTab(app);
    const t3 = state.newTab(app);
    state.open(addLogin);
    state.switchProject(app);
    state.activateTab(t2.id);

    const updatesBeforeReorder = updates.length;
    expect(state.reorderTabs(app, tab1.id, t3.id)).toBe(true);
    expect(updates.length).toBe(updatesBeforeReorder + 1);
    expect(state.tabs().map((t) => t.id)).toEqual([t2.id, t3.id, tab1.id]);
    expect(state.activeTab()?.id).toBe(t2.id);
  });

  it("remembers Remote Projects' workspaces and cached Session summaries via Tabs.update", async () => {
    const updates: Array<WorkspaceState> = [];
    const remoteUpdates: Array<ReadonlyArray<RestoredSessionInfo> | undefined> = [];
    const state = await tabs({ updates, remoteUpdates });
    const studio = DeviceId.make('studio');

    state.open(fixBuild);
    state.open({ ...addLogin, device: studio });
    state.startDraft(api, studio);

    expect(updates.at(-1)?.projects.find((p) => p.projectId === api)?.device).toBe(studio);
    expect(remoteUpdates.at(-1)).toEqual([
      {
        id: addLogin.id,
        projectId: api,
        title: { auto: 'Add login', autoIsPlaceholder: false },
      },
    ]);
  });

  it('restores Remote Projects and their cached Session titles on their Device', async () => {
    const studio = DeviceId.make('studio');
    const draft = SessionId.make('d1');
    const p1Tab = TabId.make('t-local');
    const p2Tab1 = TabId.make('t-remote-kept');
    const p2Tab2 = TabId.make('t-remote-draft');
    const state = await tabs({
      restored: {
        workspace: {
          activeProjectId: api,
          projects: [
            {
              projectId: app,
              activeTabId: p1Tab,
              tabs: [
                {
                  id: p1Tab,
                  focusedPanelId: PanelId.make('panel-local'),
                  layout: {
                    rootPaneId: PaneId.make('pane-local'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-local'),
                        panels: [
                          {
                            id: PanelId.make('panel-local'),
                            spec: { _tag: 'Session', sessionId: fixBuild.id },
                          },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            {
              projectId: api,
              device: studio,
              activeTabId: p2Tab1,
              tabs: [
                {
                  id: p2Tab1,
                  focusedPanelId: PanelId.make('panel-r1'),
                  layout: {
                    rootPaneId: PaneId.make('pane-r1'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-r1'),
                        panels: [
                          {
                            id: PanelId.make('panel-r1'),
                            spec: { _tag: 'Session', sessionId: addLogin.id },
                          },
                        ],
                      },
                    ],
                  },
                },
                {
                  id: p2Tab2,
                  focusedPanelId: PanelId.make('panel-r2'),
                  layout: {
                    rootPaneId: PaneId.make('pane-r2'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-r2'),
                        panels: [
                          {
                            id: PanelId.make('panel-r2'),
                            spec: { _tag: 'Session', sessionId: draft, draft: true },
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
          {
            id: fixBuild.id,
            projectId: app,
            title: { user: 'Fix the build', autoIsPlaceholder: false },
          },
          {
            id: addLogin.id,
            projectId: api,
            title: { user: 'Add login', autoIsPlaceholder: false },
          },
        ],
      },
    });

    expect(state.activeProjectId()).toBe(api);
    expect(state.activeDevice()).toBe(studio);
    expect(state.tabs().map((t) => state.tabTitle(t).label)).toEqual(['Add login', 'New Session']);
    expect(state.active()).toMatchObject({ session: addLogin.id, device: studio });
  });

  it('a draft whose Session vanished starts over as a fresh draft', async () => {
    const studio = DeviceId.make('studio');
    const draft = SessionId.make('d1');
    const panelId = PanelId.make('panel-r-draft');
    const tabId = TabId.make('tab-r-draft');
    const state = await tabs({
      restored: {
        workspace: {
          activeProjectId: api,
          projects: [
            {
              projectId: api,
              device: studio,
              activeTabId: tabId,
              tabs: [
                {
                  id: tabId,
                  focusedPanelId: panelId,
                  layout: {
                    rootPaneId: PaneId.make('pane-r-draft'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-r-draft'),
                        panels: [
                          {
                            id: panelId,
                            spec: { _tag: 'Session', sessionId: draft, draft: true },
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

    expect(state.active()).toMatchObject({ device: studio, session: null, draftSession: draft });
    state.resetDraft(panelId);

    expect(state.active()).toMatchObject({ device: studio, session: null });
    expect(state.active()?.draftSession).toBeUndefined();
  });
});
