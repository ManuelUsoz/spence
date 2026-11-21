import { describe, expect, it } from '@effect/vitest';
import { ProjectId } from '../projects/projects.rpc';
import { SessionId } from '../sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from './tabs.rpc';
import {
  EMPTY_WORKSPACE,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  MIN_STACK_SHARE,
  activateTab,
  addPanelToPane,
  allTabLeaves,
  allTabPanels,
  allWorkspaceSessionIds,
  attachDraftSession,
  closePanel,
  closeTab,
  createSinglePaneTab,
  findSessionPanel,
  focusPanel,
  movePanelToSplit,
  movePanelToStack,
  normalizeWorkspace,
  openDraftTab,
  openSessionInStack,
  openSessionTab,
  paneCount,
  promoteDraftSession,
  pruneProject,
  pruneSession,
  renameTab,
  reorderTabs,
  setStackHeightShares,
  splitPane,
  stripDrafts,
  switchProject,
  togglePanelCollapsed,
  visibleSessionIds,
} from './workspace-layout';

const p1 = ProjectId.make('p1');
const p2 = ProjectId.make('p2');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');
const s3 = SessionId.make('s3');

const makeIds = () => {
  let next = 0;
  return () => {
    next += 1;
    return {
      tabId: TabId.make(`tab-${next}`),
      paneId: PaneId.make(`pane-${next}`),
      panelId: PanelId.make(`panel-${next}`),
    };
  };
};

describe('workspace-layout', () => {
  it('opens a single-Pane Session Tab per Project and enforces max 1 Panel per SessionId', () => {
    const createIds = makeIds();
    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    expect(first.created).toBe(true);
    expect(first.workspace.activeProjectId).toBe(p1);
    expect(first.workspace.projects).toHaveLength(1);
    expect(first.workspace.projects[0]?.activeTabId).toBe(first.tabId);
    expect(allWorkspaceSessionIds(first.workspace)).toEqual(new Set([s1]));
    expect(visibleSessionIds(first.workspace)).toEqual(new Set([s1]));

    // Opening another Session in p2 switches activeProjectId while leaving p1's Tab alive.
    const second = openSessionTab(first.workspace, { projectId: p2, sessionId: s2, createIds });
    expect(second.created).toBe(true);
    expect(second.workspace.activeProjectId).toBe(p2);
    expect(allWorkspaceSessionIds(second.workspace)).toEqual(new Set([s1, s2]));
    expect(visibleSessionIds(second.workspace)).toEqual(new Set([s2]));

    // Re-opening s1 focuses its existing Tab and switches back to p1 without creating a duplicate.
    const refocused = openSessionTab(second.workspace, { projectId: p1, sessionId: s1, createIds });
    expect(refocused.created).toBe(false);
    expect(refocused.tabId).toBe(first.tabId);
    expect(refocused.panelId).toBe(first.panelId);
    expect(refocused.workspace.activeProjectId).toBe(p1);
    expect(refocused.workspace.projects[0]?.tabs).toHaveLength(1);
  });

  it('auto-expands a collapsed Session Panel when re-opened or focused', () => {
    const tabId = TabId.make('t1');
    const paneId = PaneId.make('pane-1');
    const panelA = PanelId.make('panel-a');
    const panelB = PanelId.make('panel-b');
    const initial: WorkspaceState = {
      activeProjectId: p1,
      projects: [
        {
          projectId: p1,
          activeTabId: tabId,
          tabs: [
            {
              id: tabId,
              focusedPanelId: panelA,
              layout: {
                rootPaneId: paneId,
                nodes: [
                  {
                    _tag: 'Leaf',
                    id: paneId,
                    panels: [
                      {
                        id: panelA,
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: false,
                        heightShare: 0.5,
                      },
                      {
                        id: panelB,
                        spec: { _tag: 'Session', sessionId: s2 },
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
    };

    expect(visibleSessionIds(initial)).toEqual(new Set([s1]));
    const reopened = openSessionTab(initial, {
      projectId: p1,
      sessionId: s2,
      createIds: makeIds(),
    });
    expect(reopened.created).toBe(false);
    expect(reopened.panelId).toBe(panelB);
    expect(visibleSessionIds(reopened.workspace)).toEqual(new Set([s1, s2]));
    expect(findSessionPanel(reopened.workspace, s2)?.panel.collapsed).toBe(false);
    expect(reopened.workspace.projects[0]?.tabs[0]?.focusedPanelId).toBe(panelB);

    const focusedA = focusPanel(initial, panelB);
    expect(findSessionPanel(focusedA, s2)?.panel.collapsed).toBe(false);
  });

  it('opens new draft Tabs on demand vs reusing an existing Project draft, and attaches/promotes drafts', () => {
    const createIds = makeIds();
    const d1 = openDraftTab(EMPTY_WORKSPACE, { projectId: p1, createIds });
    expect(d1.created).toBe(true);
    const d2 = openDraftTab(d1.workspace, { projectId: p1, createIds });
    expect(d2.created).toBe(true);
    expect(d2.tabId).not.toBe(d1.tabId);
    expect(d2.workspace.projects[0]?.tabs).toHaveLength(2);

    // Reusing existing draft focuses the first draft in p1.
    const reused = openDraftTab(d2.workspace, { projectId: p1, createIds, reuseExisting: true });
    expect(reused.created).toBe(false);
    expect(reused.tabId).toBe(d1.tabId);
    expect(reused.workspace.projects[0]?.activeTabId).toBe(d1.tabId);

    // Attaching a SessionId keeps draft: true; promoting clears draft: true.
    const attached = attachDraftSession(reused.workspace, d1.panelId, s1);
    expect(findSessionPanel(attached, s1)?.panel.spec).toEqual({
      _tag: 'Session',
      sessionId: s1,
      draft: true,
    });
    const promoted = promoteDraftSession(attached, d1.panelId, s1);
    expect(findSessionPanel(promoted, s1)?.panel.spec).toEqual({
      _tag: 'Session',
      sessionId: s1,
    });
  });

  it('renames Tabs cleanly and clears customTitle on blank input', () => {
    const createIds = makeIds();
    const { workspace, tabId } = openSessionTab(EMPTY_WORKSPACE, {
      projectId: p1,
      sessionId: s1,
      createIds,
    });

    const renamed = renameTab(workspace, tabId, '  Auth bugfix  ');
    expect(renamed.projects[0]?.tabs[0]?.customTitle).toBe('Auth bugfix');

    const cleared = renameTab(renamed, tabId, '   ');
    expect(cleared.projects[0]?.tabs[0]?.customTitle).toBeUndefined();
    expect('customTitle' in (cleared.projects[0]?.tabs[0] ?? {})).toBe(false);
  });

  it('closes Tabs shifting activeTabId to same index else previous else undefined, preserving other Projects', () => {
    const createIds = makeIds();
    let ws = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds }).workspace;
    const second = openSessionTab(ws, { projectId: p1, sessionId: s2, createIds });
    ws = openSessionTab(second.workspace, { projectId: p1, sessionId: s3, createIds }).workspace;
    ws = activateTab(ws, second.tabId);

    const tabsP1 = ws.projects[0]?.tabs ?? [];
    expect(tabsP1).toHaveLength(3);

    // Closing middle active tab activates the third tab (same index 1).
    ws = closeTab(ws, second.tabId);
    expect(ws.projects[0]?.tabs.map((t) => t.id)).toEqual([tabsP1[0]!.id, tabsP1[2]!.id]);
    expect(ws.projects[0]?.activeTabId).toBe(tabsP1[2]!.id);

    // Closing last active tab shifts left to index 0.
    ws = closeTab(ws, tabsP1[2]!.id);
    expect(ws.projects[0]?.tabs.map((t) => t.id)).toEqual([tabsP1[0]!.id]);
    expect(ws.projects[0]?.activeTabId).toBe(tabsP1[0]!.id);

    // Closing the final Tab leaves p1 with no tabs while keeping activeProjectId = p1.
    ws = closeTab(ws, tabsP1[0]!.id);
    expect(ws.projects).toEqual([]);
    expect(ws.activeProjectId).toBe(p1);
  });

  it('switches Projects without mutating any Tabs', () => {
    const createIds = makeIds();
    let ws = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds }).workspace;
    ws = openSessionTab(ws, { projectId: p2, sessionId: s2, createIds }).workspace;
    const switched = switchProject(ws, p1);
    expect(switched.activeProjectId).toBe(p1);
    expect(allWorkspaceSessionIds(switched)).toEqual(new Set([s1, s2]));
  });

  it('closing a Panel collapses empty Panes/Splits, keeps >= 1 expanded Panel, and closes empty Tabs', () => {
    const tabId = TabId.make('t1');
    const splitId = PaneId.make('split');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const pA = PanelId.make('pa');
    const pB = PanelId.make('pb');
    const pC = PanelId.make('pc');

    const initial: WorkspaceState = {
      activeProjectId: p1,
      projects: [
        {
          projectId: p1,
          activeTabId: tabId,
          tabs: [
            {
              id: tabId,
              focusedPanelId: pA,
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
                    panels: [
                      {
                        id: pA,
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: false,
                        heightShare: 0.5,
                      },
                      {
                        id: pB,
                        spec: { _tag: 'Changes', sessionId: s1 },
                        collapsed: true,
                        heightShare: 0.5,
                      },
                    ],
                  },
                  {
                    _tag: 'Leaf',
                    id: pane2,
                    panels: [
                      {
                        id: pC,
                        spec: { _tag: 'Session', sessionId: s2 },
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
    };

    // Closing the sole expanded panel pA auto-expands pB (now single panel in pane1) and refocuses.
    const afterCloseA = closePanel(initial, pA);
    const tabAfterA = afterCloseA.projects[0]!.tabs[0]!;
    expect(allTabPanels(tabAfterA).map((p) => [p.id, p.collapsed])).toEqual([
      [pB, false],
      [pC, false],
    ]);
    expect(tabAfterA.focusedPanelId).toBe(pB);

    // Closing pB removes pane1 and collapses the Split into pane2 as the root.
    const afterCloseB = closePanel(afterCloseA, pB);
    const tabAfterB = afterCloseB.projects[0]!.tabs[0]!;
    expect(tabAfterB.layout.rootPaneId).toBe(pane2);
    expect(tabAfterB.layout.nodes).toHaveLength(1);
    expect(tabAfterB.focusedPanelId).toBe(pC);

    // Closing pC closes the now-empty Tab.
    const afterCloseC = closePanel(afterCloseB, pC);
    expect(afterCloseC.projects).toEqual([]);
  });

  it('prunes deleted Sessions (and pinned Changes/Workers Panels), drafts, and removed Projects cleanly', () => {
    const splitId = PaneId.make('split');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const tab1 = createSinglePaneTab({
      tabId: TabId.make('t1'),
      paneId: PaneId.make('pane-single'),
      panelId: PanelId.make('panel-draft'),
      spec: { _tag: 'Session', sessionId: s3, draft: true },
    });
    const tab2 = {
      id: TabId.make('t2'),
      focusedPanelId: PanelId.make('p-s1'),
      layout: {
        rootPaneId: splitId,
        nodes: [
          {
            _tag: 'Split' as const,
            id: splitId,
            direction: 'vertical' as const,
            ratio: 0.5,
            first: pane1,
            second: pane2,
          },
          {
            _tag: 'Leaf' as const,
            id: pane1,
            panels: [
              {
                id: PanelId.make('p-s1'),
                spec: { _tag: 'Session' as const, sessionId: s1 },
                collapsed: false,
                heightShare: 0.5,
              },
              {
                id: PanelId.make('p-s1-changes'),
                spec: { _tag: 'Changes' as const, sessionId: s1 },
                collapsed: true,
                heightShare: 0.5,
              },
            ],
          },
          {
            _tag: 'Leaf' as const,
            id: pane2,
            panels: [
              {
                id: PanelId.make('p-s1-workers'),
                spec: { _tag: 'Workers' as const, sessionId: s1 },
                collapsed: false,
                heightShare: 0.5,
              },
              {
                id: PanelId.make('p-s2'),
                spec: { _tag: 'Session' as const, sessionId: s2 },
                collapsed: true,
                heightShare: 0.5,
              },
            ],
          },
        ],
      },
    };
    const ws: WorkspaceState = {
      activeProjectId: p1,
      projects: [
        { projectId: p1, activeTabId: tab1.id, tabs: [tab1, tab2] },
        {
          projectId: p2,
          activeTabId: TabId.make('t3'),
          tabs: [
            createSinglePaneTab({
              tabId: TabId.make('t3'),
              paneId: PaneId.make('pane-p2'),
              panelId: PanelId.make('panel-p2'),
              spec: { _tag: 'Session', sessionId: SessionId.make('s4') },
            }),
          ],
        },
      ],
    };

    // Pruning s1 removes Session s1 AND its pinned Changes/Workers panels, auto-expanding s2 and collapsing split -> pane2.
    const prunedS1 = pruneSession(ws, s1);
    const remainingTab2 = prunedS1.projects[0]?.tabs.find((t) => t.id === tab2.id);
    expect(remainingTab2?.layout.rootPaneId).toBe(pane2);
    expect(allTabPanels(remainingTab2!).map((p) => [p.spec._tag, p.collapsed])).toEqual([
      ['Session', false],
    ]);

    // Stripping drafts drops tab1 (sole draft panel) and shifts activeTabId to tab2.
    const stripped = stripDrafts(prunedS1, (id) => id === undefined || id === s3);
    expect(stripped.projects[0]?.tabs.map((t) => t.id)).toEqual([tab2.id]);
    expect(stripped.projects[0]?.activeTabId).toBe(tab2.id);

    // Pruning p1 removes p1 and falls back activeProjectId to p2.
    const prunedP1 = pruneProject(stripped, p1);
    expect(prunedP1.projects.map((p) => p.projectId)).toEqual([p2]);
    expect(prunedP1.activeProjectId).toBe(p2);
  });

  it('normalizes ratios, duplicates, unreachable nodes, and collapsed-only leaves', () => {
    const root = PaneId.make('root');
    const orphan = PaneId.make('orphan');
    const leaf1 = PaneId.make('leaf1');
    const leaf2 = PaneId.make('leaf2');
    const malformed: WorkspaceState = {
      activeProjectId: p1,
      projects: [
        {
          projectId: p1,
          activeTabId: TabId.make('missing-tab'),
          tabs: [
            {
              id: TabId.make('t1'),
              focusedPanelId: PanelId.make('nonexistent'),
              layout: {
                rootPaneId: root,
                nodes: [
                  {
                    _tag: 'Split',
                    id: root,
                    direction: 'horizontal',
                    ratio: 0.99,
                    first: leaf1,
                    second: leaf2,
                  },
                  {
                    _tag: 'Leaf',
                    id: leaf1,
                    panels: [
                      {
                        id: PanelId.make('p1'),
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: true,
                        heightShare: 0.5,
                      },
                      {
                        id: PanelId.make('p2'),
                        spec: { _tag: 'Changes', sessionId: s1 },
                        collapsed: true,
                        heightShare: 0.5,
                      },
                    ],
                  },
                  {
                    _tag: 'Leaf',
                    id: leaf2,
                    panels: [
                      {
                        id: PanelId.make('p3-dup'),
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: false,
                        heightShare: 1,
                      },
                    ],
                  },
                  {
                    _tag: 'Leaf',
                    id: orphan,
                    panels: [
                      {
                        id: PanelId.make('p4'),
                        spec: { _tag: 'Session', sessionId: s2 },
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
    };

    const normalized = normalizeWorkspace(malformed);
    const tab = normalized.projects[0]!.tabs[0]!;
    expect(normalized.projects[0]!.activeTabId).toBe(tab.id);
    // Duplicate s1 panel in leaf2 was dropped, collapsing Split to leaf1.
    expect(tab.layout.rootPaneId).toBe(leaf1);
    expect(tab.layout.nodes).toHaveLength(1);
    // All-collapsed leaf1 auto-expanded its first panel; focusedPanelId repaired.
    expect(allTabPanels(tab).map((p) => p.collapsed)).toEqual([false, true]);
    expect(tab.focusedPanelId).toBe(PanelId.make('p1'));

    // Also verify split ratio clamping.
    const clamped = normalizeWorkspace({
      activeProjectId: p1,
      projects: [
        {
          projectId: p1,
          tabs: [
            {
              id: TabId.make('t1'),
              focusedPanelId: PanelId.make('pa'),
              layout: {
                rootPaneId: root,
                nodes: [
                  {
                    _tag: 'Split',
                    id: root,
                    direction: 'horizontal',
                    ratio: 0.02,
                    first: leaf1,
                    second: leaf2,
                  },
                  {
                    _tag: 'Leaf',
                    id: leaf1,
                    panels: [
                      {
                        id: PanelId.make('pa'),
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: false,
                        heightShare: 1,
                      },
                    ],
                  },
                  {
                    _tag: 'Leaf',
                    id: leaf2,
                    panels: [
                      {
                        id: PanelId.make('pb'),
                        spec: { _tag: 'Session', sessionId: s2 },
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
    });
    const splitNode = clamped.projects[0]!.tabs[0]!.layout.nodes[0]!;
    expect(splitNode._tag).toBe('Split');
    if (splitNode._tag === 'Split') {
      expect(splitNode.ratio).toBe(MIN_SPLIT_RATIO);
    }
    expect(MAX_SPLIT_RATIO).toBe(0.85);
  });

  it('appends expanded Panels to a Pane stack and preserves max-1-Panel-per-Session on openSessionInStack', () => {
    const createIds = makeIds();
    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const paneId = allTabLeaves(first.tab)[0]!.id;

    // addPanelToPane appends an expanded draft Panel to the Pane and focuses it.
    const draftPanelId = PanelId.make('panel-draft-stacked');
    const withDraft = addPanelToPane(first.workspace, paneId, {
      id: draftPanelId,
      spec: { _tag: 'Session', draft: true },
      collapsed: true, // forced expanded on append
      heightShare: 1,
    });
    const tabAfterAdd = withDraft.projects[0]!.tabs[0]!;
    expect(allTabLeaves(tabAfterAdd)).toHaveLength(1);
    expect(allTabPanels(tabAfterAdd).map((p) => [p.id, p.collapsed])).toEqual([
      [first.panelId, false],
      [draftPanelId, false],
    ]);
    expect(tabAfterAdd.focusedPanelId).toBe(draftPanelId);

    // Unknown paneId is a no-op returning the same workspace reference.
    expect(
      addPanelToPane(withDraft, PaneId.make('missing'), {
        id: PanelId.make('ignored'),
        spec: { _tag: 'Session', draft: true },
        collapsed: false,
        heightShare: 1,
      }),
    ).toBe(withDraft);

    // openSessionInStack appends s2 to the active Tab's focused Pane when not yet open.
    const stackedS2 = openSessionInStack(withDraft, {
      projectId: p1,
      sessionId: s2,
      createIds,
    });
    expect(stackedS2.created).toBe(true);
    expect(stackedS2.tabId).toBe(first.tabId);
    expect(allTabPanels(stackedS2.tab).map((p) => p.spec.sessionId)).toEqual([s1, undefined, s2]);
    expect(stackedS2.tab.focusedPanelId).toBe(stackedS2.panelId);
    expect(allTabPanels(stackedS2.tab).every((p) => !p.collapsed)).toBe(true);

    // openSessionInStack on an already-open Session (even in another Project or collapsed) focuses & auto-expands it without duplicating.
    const withP2 = openSessionTab(stackedS2.workspace, {
      projectId: p2,
      sessionId: s3,
      createIds,
    }).workspace;
    // Mark s1 collapsed in p1 to verify openSessionInStack auto-expands it when revisiting from p2.
    const withCollapsedS1: WorkspaceState = {
      ...withP2,
      projects: withP2.projects.map((proj) =>
        proj.projectId === p1
          ? {
              ...proj,
              tabs: proj.tabs.map((tab) => ({
                ...tab,
                layout: {
                  ...tab.layout,
                  nodes: tab.layout.nodes.map((node) =>
                    node._tag === 'Leaf'
                      ? {
                          ...node,
                          panels: node.panels.map((panel) =>
                            panel.id === first.panelId ? { ...panel, collapsed: true } : panel,
                          ),
                        }
                      : node,
                  ),
                },
              })),
            }
          : proj,
      ),
    };
    const focusedExisting = openSessionInStack(withCollapsedS1, {
      projectId: p1,
      sessionId: s1,
      createIds,
    });
    expect(focusedExisting.created).toBe(false);
    expect(focusedExisting.workspace.activeProjectId).toBe(p1);
    expect(focusedExisting.tabId).toBe(first.tabId);
    expect(focusedExisting.panelId).toBe(first.panelId);
    expect(findSessionPanel(focusedExisting.workspace, s1)?.panel.collapsed).toBe(false);
    expect(allTabPanels(focusedExisting.tab)).toHaveLength(3);

    // openSessionInStack on a Project with no active Tab creates a new Tab.
    const fresh = openSessionInStack(EMPTY_WORKSPACE, {
      projectId: p2,
      sessionId: s3,
      createIds,
    });
    expect(fresh.created).toBe(true);
    expect(fresh.workspace.activeProjectId).toBe(p2);
    expect(fresh.workspace.projects[0]?.tabs).toHaveLength(1);
    expect(allTabPanels(fresh.tab).map((p) => p.spec.sessionId)).toEqual([s3]);

    // openSessionInStack with an explicit targetPaneId appends to that specific Pane even if another Pane is focused.
    const splitPaneId = PaneId.make('split-root');
    const leftPane = PaneId.make('pane-left');
    const rightPane = PaneId.make('pane-right');
    const splitWs: WorkspaceState = {
      activeProjectId: p1,
      projects: [
        {
          projectId: p1,
          activeTabId: TabId.make('tab-split'),
          tabs: [
            {
              id: TabId.make('tab-split'),
              focusedPanelId: PanelId.make('left-panel'),
              layout: {
                rootPaneId: splitPaneId,
                nodes: [
                  {
                    _tag: 'Split',
                    id: splitPaneId,
                    direction: 'horizontal',
                    ratio: 0.5,
                    first: leftPane,
                    second: rightPane,
                  },
                  {
                    _tag: 'Leaf',
                    id: leftPane,
                    panels: [
                      {
                        id: PanelId.make('left-panel'),
                        spec: { _tag: 'Session', sessionId: s1 },
                        collapsed: false,
                        heightShare: 1,
                      },
                    ],
                  },
                  {
                    _tag: 'Leaf',
                    id: rightPane,
                    panels: [
                      {
                        id: PanelId.make('right-panel'),
                        spec: { _tag: 'Session', sessionId: s2 },
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
    };
    const targeted = openSessionInStack(splitWs, {
      projectId: p1,
      sessionId: s3,
      targetPaneId: rightPane,
      createIds,
    });
    expect(targeted.paneId).toBe(rightPane);
    expect(
      allTabLeaves(targeted.tab)
        .find((l) => l.id === rightPane)
        ?.panels.map((p) => p.spec.sessionId),
    ).toEqual([s2, s3]);
  });

  it('toggles Panel collapse with >= 1 expanded invariant, shifts focus away on collapse, and clamps stack heightShares', () => {
    const createIds = makeIds();
    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const paneId = allTabLeaves(first.tab)[0]!.id;

    // Collapsing the sole Panel in a Pane is a no-op.
    expect(togglePanelCollapsed(first.workspace, first.panelId)).toBe(first.workspace);

    const second = openSessionInStack(first.workspace, { projectId: p1, sessionId: s2, createIds });
    const third = openSessionInStack(second.workspace, { projectId: p1, sessionId: s3, createIds });
    const pA = first.panelId;
    const pB = second.panelId;
    const pC = third.panelId;
    expect(third.tab.focusedPanelId).toBe(pC);

    // Collapsing the focused Panel (pC) moves focus to an expanded Panel in that Pane.
    const collapsedC = togglePanelCollapsed(third.workspace, pC);
    const tabAfterC = collapsedC.projects[0]!.tabs[0]!;
    expect(allTabPanels(tabAfterC).map((p) => [p.id, p.collapsed])).toEqual([
      [pA, false],
      [pB, false],
      [pC, true],
    ]);
    expect([pA, pB]).toContain(tabAfterC.focusedPanelId);

    // Collapsing pA leaves pB as the sole expanded Panel and shifts focus to pB.
    const focusedA = focusPanel(collapsedC, pA);
    const onlyB = togglePanelCollapsed(focusedA, pA);
    const tabOnlyB = onlyB.projects[0]!.tabs[0]!;
    expect(allTabPanels(tabOnlyB).map((p) => [p.id, p.collapsed])).toEqual([
      [pA, true],
      [pB, false],
      [pC, true],
    ]);
    expect(tabOnlyB.focusedPanelId).toBe(pB);

    // Collapsing the sole expanded Panel pB is a strict no-op.
    expect(togglePanelCollapsed(onlyB, pB)).toBe(onlyB);

    // Expanding a collapsed Panel (pC) expands AND focuses it.
    const expandedC = togglePanelCollapsed(onlyB, pC);
    const tabExpandedC = expandedC.projects[0]!.tabs[0]!;
    expect(allTabPanels(tabExpandedC).map((p) => [p.id, p.collapsed])).toEqual([
      [pA, true],
      [pB, false],
      [pC, false],
    ]);
    expect(tabExpandedC.focusedPanelId).toBe(pC);

    // setStackHeightShares updates shares, clamps positive shares to >= MIN_STACK_SHARE, and ignores non-positive/NaN.
    const resized = setStackHeightShares(expandedC, paneId, {
      [pB]: 0.02,
      [pC]: 1.4,
      [pA]: -0.5,
    });
    const panelsAfterResize = allTabPanels(resized.projects[0]!.tabs[0]!);
    expect(panelsAfterResize.map((p) => [p.id, p.heightShare])).toEqual([
      [pA, 1],
      [pB, MIN_STACK_SHARE],
      [pC, 1.4],
    ]);

    // Closing the sole expanded Panel (pB when A & C are collapsed) auto-expands a neighbor.
    const closedB = closePanel(onlyB, pB);
    const panelsAfterCloseB = allTabPanels(closedB.projects[0]!.tabs[0]!);
    expect(panelsAfterCloseB.map((p) => [p.id, p.collapsed])).toEqual([
      [pA, true],
      [pC, false],
    ]);
    expect(closedB.projects[0]!.tabs[0]!.focusedPanelId).toBe(pC);
  });

  it('moves a Panel to a split on another Pane edge, collapsing empty source Panes and enforcing the 4-Pane cap', () => {
    const createIds = makeIds();
    let splitSeq = 0;
    const createSplitIds = () => {
      splitSeq += 1;
      return {
        splitPaneId: PaneId.make(`moved-split-${splitSeq}`),
        newPaneId: PaneId.make(`moved-pane-${splitSeq}`),
        panelId: PanelId.make(`unused-${splitSeq}`),
      };
    };

    const s4 = SessionId.make('s4');
    const s5 = SessionId.make('s5');

    // Start with 2 Panes: pane1 (s1) | pane2 (s2, collapsed s3)
    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const pane1 = allTabLeaves(first.tab)[0]!.id;
    const split2 = splitPane(first.workspace, {
      paneId: pane1,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s2 },
      createIds: createSplitIds,
    });
    const pane2 = split2.paneId!;
    const p2Panel = split2.panelId!;
    const withStack = openSessionInStack(split2.workspace, {
      projectId: p1,
      sessionId: s3,
      targetPaneId: pane2,
      createIds,
    });
    const p3Panel = withStack.panelId;
    // Collapse p3Panel and focus p2Panel so p2Panel is sole expanded in pane2.
    let ws = togglePanelCollapsed(withStack.workspace, p3Panel);

    // Dragging lone s1 onto its own Pane (pane1) is a no-op.
    expect(
      movePanelToSplit(ws, {
        panelId: first.panelId,
        targetPaneId: pane1,
        side: 'bottom',
        createSplitIds,
      }),
    ).toBe(ws);

    // Dragging sole expanded panel p2Panel from pane2 onto 'top' of pane1 splits pane1 vertically and auto-expands p3Panel in pane2.
    ws = movePanelToSplit(ws, {
      panelId: p2Panel,
      targetPaneId: pane1,
      side: 'top',
      createSplitIds,
    });
    const tabAfterMove1 = ws.projects[0]!.tabs[0]!;
    expect(paneCount(tabAfterMove1)).toBe(3);
    expect(tabAfterMove1.focusedPanelId).toBe(p2Panel);
    expect(findSessionPanel(ws, s3)?.panel.collapsed).toBe(false);
    expect(findSessionPanel(ws, s2)?.panel.collapsed).toBe(false);
    expect(findSessionPanel(ws, s2)?.pane.id).not.toBe(pane1);

    // Add a 4th Pane and stack s5 into pane2 so paneCount === 4 and pane2 has 2 Panels while pane1 has 1 Panel.
    const split4 = splitPane(ws, {
      paneId: pane1,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s4 },
      createIds: createSplitIds,
    });
    ws = openSessionInStack(split4.workspace, {
      projectId: p1,
      sessionId: s5,
      targetPaneId: pane2,
      createIds,
    }).workspace;
    expect(paneCount(ws.projects[0]!.tabs[0]!)).toBe(4);

    // At 4 Panes, moving a Panel out of multi-Panel pane2 to split pane1 is blocked.
    expect(
      movePanelToSplit(ws, {
        panelId: p3Panel,
        targetPaneId: pane1,
        side: 'bottom',
        createSplitIds,
      }),
    ).toBe(ws);

    // At 4 Panes, moving the lone Panel from pane1 to split pane2 IS allowed because pane1 collapses (total stays 4).
    const movedLone = movePanelToSplit(ws, {
      panelId: first.panelId,
      targetPaneId: pane2,
      side: 'bottom',
      createSplitIds,
    });
    expect(movedLone).not.toBe(ws);
    const tabAt4 = movedLone.projects[0]!.tabs[0]!;
    expect(paneCount(tabAt4)).toBe(4);
    expect(tabAt4.focusedPanelId).toBe(first.panelId);
    expect(allTabLeaves(tabAt4).some((leaf) => leaf.id === pane1)).toBe(false);
  });

  it('moves a Panel into another Pane stack, reorders within a stack, and preserves >= 1 expanded invariants', () => {
    const createIds = makeIds();
    let splitSeq = 0;
    const createSplitIds = () => {
      splitSeq += 1;
      return {
        splitPaneId: PaneId.make(`s-${splitSeq}`),
        newPaneId: PaneId.make(`p-${splitSeq}`),
        panelId: PanelId.make(`u-${splitSeq}`),
      };
    };

    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const pane1 = allTabLeaves(first.tab)[0]!.id;
    const split2 = splitPane(first.workspace, {
      paneId: pane1,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s2 },
      createIds: createSplitIds,
    });
    const pane2 = split2.paneId!;
    const stacked3 = openSessionInStack(split2.workspace, {
      projectId: p1,
      sessionId: s3,
      targetPaneId: pane2,
      createIds,
    });
    const panel1 = first.panelId;
    const panel2 = split2.panelId!;
    const panel3 = stacked3.panelId;

    // Collapse panel3 so panel2 is sole expanded in pane2.
    let ws = togglePanelCollapsed(stacked3.workspace, panel3);

    // Move panel2 (sole expanded in pane2) into pane1 at index 0 -> auto-expands panel3 in pane2.
    ws = movePanelToStack(ws, { panelId: panel2, targetPaneId: pane1, insertIndex: 0 });
    const tab1 = ws.projects[0]!.tabs[0]!;
    expect(tab1.focusedPanelId).toBe(panel2);
    expect(
      allTabLeaves(tab1)
        .find((l) => l.id === pane1)
        ?.panels.map((p) => p.id),
    ).toEqual([panel2, panel1]);
    expect(findSessionPanel(ws, s3)?.panel.collapsed).toBe(false);

    // Reorder within pane1: move panel2 from index 0 to index 1.
    ws = movePanelToStack(ws, { panelId: panel2, targetPaneId: pane1, insertIndex: 1 });
    expect(
      allTabLeaves(ws.projects[0]!.tabs[0]!)
        .find((l) => l.id === pane1)
        ?.panels.map((p) => p.id),
    ).toEqual([panel1, panel2]);

    // Move lone panel3 from pane2 into pane1 -> collapses pane2 away cleanly.
    ws = movePanelToStack(ws, { panelId: panel3, targetPaneId: pane1 });
    const finalTab = ws.projects[0]!.tabs[0]!;
    expect(paneCount(finalTab)).toBe(1);
    expect(finalTab.layout.rootPaneId).toBe(pane1);
    expect(allTabPanels(finalTab).map((p) => p.id)).toEqual([panel1, panel2, panel3]);
    expect(finalTab.focusedPanelId).toBe(panel3);
  });

  it('reorders Tabs within a Project without affecting other Projects or activeTabId', () => {
    const createIds = makeIds();
    const t1 = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const t2 = openSessionTab(t1.workspace, { projectId: p1, sessionId: s2, createIds });
    const t3 = openSessionTab(t2.workspace, { projectId: p1, sessionId: s3, createIds });
    const otherProj = openSessionTab(t3.workspace, {
      projectId: p2,
      sessionId: SessionId.make('s4'),
      createIds,
    });
    const ws = activateTab(otherProj.workspace, t2.tabId);

    const movedRight = reorderTabs(ws, p1, t1.tabId, t3.tabId);
    expect(movedRight.projects[0]?.tabs.map((t) => t.id)).toEqual([t2.tabId, t3.tabId, t1.tabId]);
    expect(movedRight.projects[0]?.activeTabId).toBe(t2.tabId);
    expect(movedRight.projects[1]?.tabs.map((t) => t.id)).toEqual([otherProj.tabId]);

    const movedLeft = reorderTabs(movedRight, p1, t1.tabId, t2.tabId);
    expect(movedLeft.projects[0]?.tabs.map((t) => t.id)).toEqual([t1.tabId, t2.tabId, t3.tabId]);
    expect(movedLeft.projects[0]?.activeTabId).toBe(t2.tabId);

    // No-op when fromTabId === toTabId or missing.
    expect(reorderTabs(movedLeft, p1, t1.tabId, t1.tabId)).toBe(movedLeft);
    expect(reorderTabs(movedLeft, p1, t1.tabId, otherProj.tabId)).toBe(movedLeft);
  });
});
