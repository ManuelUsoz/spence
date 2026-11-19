import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
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
  type RestoredWorkspace,
  type TabActivation,
  type WorkspaceState,
} from '../../shared/tabs/tabs.rpc';
import {
  EMPTY_WORKSPACE,
  MIN_STACK_SHARE,
  allTabLeaves,
  allTabPanels,
} from '../../shared/tabs/workspace-layout';
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
}) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () =>
          Effect.succeed(options?.restored ?? { workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': ({ workspace }) =>
          Effect.sync(() => {
            options?.updates?.push(workspace);
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
                            collapsed: false,
                            heightShare: 1,
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

  it('tracks live attention, running, and title updates from Session.changes and handles Tabs.activations (auto-expanding collapsed Panels)', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const activations = Effect.runSync(Queue.unbounded<TabActivation>());
    const tApp = TabId.make('tab-app');
    const pApp = PanelId.make('panel-app');
    const pCollapsed = PanelId.make('panel-collapsed');

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
                        panels: [
                          {
                            id: pApp,
                            spec: { _tag: 'Session', sessionId: fixBuild.id },
                            collapsed: false,
                            heightShare: 0.5,
                          },
                          {
                            id: pCollapsed,
                            spec: { _tag: 'Session', sessionId: polishUi.id },
                            collapsed: true,
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

    // OS notification click for collapsed polishUi switches Project, focuses it, and auto-expands it.
    state.open(addLogin);
    expect(state.activeProjectId()).toBe(api);

    Queue.offerUnsafe(activations, {
      sessionId: polishUi.id,
      projectId: app,
      title: { auto: polishUi.title, autoIsPlaceholder: false },
    });

    await vi.waitFor(() => expect(state.activeProjectId()).toBe(app));
    expect(state.focusedPanel()?.id).toBe(pCollapsed);
    expect(state.focusedPanel()?.collapsed).toBe(false);
    expect(allTabPanels(state.activeTab()!).every((p) => !p.collapsed)).toBe(true);
  });

  it('closes Sessions (including pinned auxiliary Panels) and Projects cleanly, and promotes drafts by PanelId', async () => {
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

  it('focuses an arbitrary Panel inside a Tab (auto-expanding if collapsed) without duplicating updates', async () => {
    const updates: WorkspaceState[] = [];
    const tApp = TabId.make('tab-app');
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
                    rootPaneId: PaneId.make('pane-app'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-app'),
                        panels: [
                          {
                            id: p1,
                            spec: { _tag: 'Session', sessionId: fixBuild.id },
                            collapsed: false,
                            heightShare: 0.5,
                          },
                          {
                            id: p2,
                            spec: { _tag: 'Session', sessionId: polishUi.id },
                            collapsed: true,
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
    // Already focused & expanded -> no-op.
    state.focusPanel(p1);
    expect(updates.length).toBe(beforeUpdates);

    state.focusPanel(p2);
    expect(state.focusedPanel()?.id).toBe(p2);
    expect(state.focusedPanel()?.collapsed).toBe(false);
    expect(updates.length).toBe(beforeUpdates + 1);
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

  it('adds Panels to a Pane stack via addPanelToStack and openSessionInStack while preserving uniqueness and persisting', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    // openSessionInStack on an empty Project creates a new Tab.
    const initialTab = state.openSessionInStack(fixBuild);
    expect(state.tabs()).toHaveLength(1);
    expect(state.active()?.session).toBe(fixBuild.id);
    const paneId = allTabLeaves(initialTab)[0]!.id;

    // addPanelToStack appends a draft Session Panel to the Pane and focuses it.
    const beforeCount = updates.length;
    const addedDraft = state.addPanelToStack(paneId);
    expect(addedDraft).not.toBeNull();
    expect(addedDraft?.spec).toEqual({ _tag: 'Session', draft: true });
    expect(addedDraft?.collapsed).toBe(false);
    expect(state.focusedPanel()?.id).toBe(addedDraft?.id);
    expect(allTabPanels(state.activeTab()!)).toHaveLength(2);
    expect(updates.length).toBe(beforeCount + 1);

    // openSessionInStack appends polishUi into the active Tab's focused Pane.
    state.openSessionInStack(polishUi);
    expect(state.tabs()).toHaveLength(1);
    expect(allTabPanels(state.activeTab()!).map((p) => p.spec.sessionId)).toEqual([
      fixBuild.id,
      undefined,
      polishUi.id,
    ]);
    expect(state.active()?.session).toBe(polishUi.id);

    // Re-opening fixBuild via openSessionInStack focuses its existing Panel without duplicating it.
    state.openSessionInStack(fixBuild);
    expect(allTabPanels(state.activeTab()!)).toHaveLength(3);
    expect(state.active()?.session).toBe(fixBuild.id);
  });

  it('toggles stacked Panel collapse (blocking sole-expanded collapse) and resizes stack heightShares via Tabs.update', async () => {
    const updates: WorkspaceState[] = [];
    const state = await tabs({ updates });

    const tab = state.open(fixBuild);
    const paneId = allTabLeaves(tab)[0]!.id;
    const firstPanelId = tab.focusedPanelId;
    state.openSessionInStack(polishUi, paneId);
    const secondPanelId = state.focusedPanel()!.id;

    // Collapsing focused secondPanel collapses it, moves focus to firstPanel, and persists.
    const beforeCollapse = updates.length;
    state.togglePanelCollapsed(secondPanelId);
    expect(updates.length).toBe(beforeCollapse + 1);
    expect(state.focusedPanel()?.id).toBe(firstPanelId);
    expect(allTabPanels(state.activeTab()!).map((p) => p.collapsed)).toEqual([false, true]);

    // Attempting to collapse sole expanded firstPanel is a no-op with no extra Tabs.update.
    const beforeBlocked = updates.length;
    state.togglePanelCollapsed(firstPanelId);
    expect(updates.length).toBe(beforeBlocked);
    expect(allTabPanels(state.activeTab()!).map((p) => p.collapsed)).toEqual([false, true]);

    // Expanding secondPanel restores both expanded and focuses secondPanel.
    state.togglePanelCollapsed(secondPanelId);
    expect(state.focusedPanel()?.id).toBe(secondPanelId);
    expect(allTabPanels(state.activeTab()!).map((p) => p.collapsed)).toEqual([false, false]);

    // resizeStackPanels updates shares, clamps to >= MIN_STACK_SHARE, and persists via Tabs.update.
    const beforeResize = updates.length;
    state.resizeStackPanels(paneId, firstPanelId, secondPanelId, 0.05, 1.3);
    expect(updates.length).toBe(beforeResize + 1);
    expect(allTabPanels(state.activeTab()!).map((p) => p.heightShare)).toEqual([
      MIN_STACK_SHARE,
      1.3,
    ]);
  });
});
