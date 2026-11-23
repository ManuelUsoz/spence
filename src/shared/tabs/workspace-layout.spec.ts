import { describe, expect, it } from '@effect/vitest';
import { ProjectId } from '../projects/projects.rpc';
import { SessionId } from '../sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from './tabs.rpc';
import {
  EMPTY_WORKSPACE,
  MAX_PANES_PER_TAB,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  activateTab,
  allTabLeaves,
  allTabPanels,
  allWorkspaceSessionIds,
  attachDraftSession,
  canSplitDrop,
  closePanel,
  closeTab,
  createSinglePaneTab,
  findSessionPanel,
  focusPanel,
  movePanelToSplit,
  normalizeWorkspace,
  openDraftTab,
  openSessionInSplit,
  openSessionTab,
  paneCount,
  promoteDraftSession,
  pruneProject,
  pruneSession,
  renameTab,
  reorderTabs,
  setSessionWallpaperInWorkspace,
  splitPane,
  stripDrafts,
  swapPanePanels,
  swapPanelToPane,
  switchProject,
  visibleSessionIds,
} from './workspace-layout';

const makeSplitIds = () => {
  let next = 0;
  return () => {
    next += 1;
    return {
      splitPaneId: PaneId.make(`split-${next}`),
      newPaneId: PaneId.make(`split-pane-${next}`),
      panelId: PanelId.make(`split-panel-${next}`),
    };
  };
};

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

  it('focuses an already-open Session Panel across split Panes and Tabs without duplicating', () => {
    const tabId = TabId.make('t1');
    const splitId = PaneId.make('split-1');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
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
                    panels: [{ id: panelA, spec: { _tag: 'Session', sessionId: s1 } }],
                  },
                  {
                    _tag: 'Leaf',
                    id: pane2,
                    panels: [{ id: panelB, spec: { _tag: 'Session', sessionId: s2 } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(visibleSessionIds(initial)).toEqual(new Set([s1, s2]));
    const reopened = openSessionTab(initial, {
      projectId: p1,
      sessionId: s2,
      createIds: makeIds(),
    });
    expect(reopened.created).toBe(false);
    expect(reopened.panelId).toBe(panelB);
    expect(visibleSessionIds(reopened.workspace)).toEqual(new Set([s1, s2]));
    expect(reopened.workspace.projects[0]?.tabs[0]?.focusedPanelId).toBe(panelB);

    const refocusedA = focusPanel(reopened.workspace, panelA);
    expect(refocusedA.projects[0]?.tabs[0]?.focusedPanelId).toBe(panelA);
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

  it('closing a Panel collapses empty Panes/Splits and closes empty Tabs', () => {
    const tabId = TabId.make('t1');
    const splitId = PaneId.make('split');
    const pane1 = PaneId.make('pane-1');
    const pane2 = PaneId.make('pane-2');
    const pA = PanelId.make('pa');
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
                    panels: [{ id: pA, spec: { _tag: 'Session', sessionId: s1 } }],
                  },
                  {
                    _tag: 'Leaf',
                    id: pane2,
                    panels: [{ id: pC, spec: { _tag: 'Session', sessionId: s2 } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    // Closing pA removes pane1 and collapses the Split into pane2 as the root.
    const afterCloseA = closePanel(initial, pA);
    const tabAfterA = afterCloseA.projects[0]!.tabs[0]!;
    expect(tabAfterA.layout.rootPaneId).toBe(pane2);
    expect(tabAfterA.layout.nodes).toHaveLength(1);
    expect(tabAfterA.focusedPanelId).toBe(pC);

    // Closing pC closes the now-empty Tab.
    const afterCloseC = closePanel(afterCloseA, pC);
    expect(afterCloseC.projects).toEqual([]);
  });

  it('prunes deleted Sessions, sessionWallpapers, drafts, and removed Projects cleanly', () => {
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
              { id: PanelId.make('p-s1'), spec: { _tag: 'Session' as const, sessionId: s1 } },
            ],
          },
          {
            _tag: 'Leaf' as const,
            id: pane2,
            panels: [
              { id: PanelId.make('p-s2'), spec: { _tag: 'Session' as const, sessionId: s2 } },
            ],
          },
        ],
      },
    };
    const s4 = SessionId.make('s4');
    const ws: WorkspaceState = {
      activeProjectId: p1,
      sessionWallpapers: {
        [s1]: 'cobalt-halftone',
        [s2]: 'amber-halftone',
        [s3]: 'rose-halftone',
        [s4]: 'emerald-halftone',
      },
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
              spec: { _tag: 'Session', sessionId: s4 },
            }),
          ],
        },
      ],
    };

    // Pruning s1 removes Session s1, collapses split -> pane2, and removes s1's wallpaper entry.
    const prunedS1 = pruneSession(ws, s1);
    const remainingTab2 = prunedS1.projects[0]?.tabs.find((t) => t.id === tab2.id);
    expect(remainingTab2?.layout.rootPaneId).toBe(pane2);
    expect(allTabPanels(remainingTab2!).map((p) => p.spec)).toEqual([
      { _tag: 'Session', sessionId: s2 },
    ]);
    expect(prunedS1.sessionWallpapers?.[s1]).toBeUndefined();
    expect(prunedS1.sessionWallpapers?.[s2]).toBe('amber-halftone');

    // Stripping drafts drops tab1 (sole draft panel) and shifts activeTabId to tab2 while cleaning draft wallpapers.
    const stripped = stripDrafts(prunedS1, (id) => id === undefined || id === s3);
    expect(stripped.projects[0]?.tabs.map((t) => t.id)).toEqual([tab2.id]);
    expect(stripped.projects[0]?.activeTabId).toBe(tab2.id);
    expect(stripped.sessionWallpapers?.[s3]).toBeUndefined();
    expect(stripped.sessionWallpapers?.[s4]).toBe('emerald-halftone');

    // Pruning p1 removes p1 and falls back activeProjectId to p2.
    const prunedP1 = pruneProject(stripped, p1);
    expect(prunedP1.projects.map((p) => p.projectId)).toEqual([p2]);
    expect(prunedP1.activeProjectId).toBe(p2);
  });

  it('normalizes ratios, duplicates, unreachable nodes, 1-Panel-per-Leaf (promoting stacked Sessions), and legacy aux Panels', () => {
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
                      },
                      {
                        id: PanelId.make('p-aux'),
                        spec: { _tag: 'Changes', sessionId: s1 },
                      },
                      {
                        id: PanelId.make('p-stacked'),
                        spec: { _tag: 'Session', sessionId: s3 },
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
    const tabs = normalized.projects[0]!.tabs;
    expect(normalized.projects[0]!.activeTabId).toBe(tabs[0]!.id);
    // leaf1 kept p1 (s1), dropped legacy Changes panel, promoted stacked s3 to a new Tab, and dropped duplicate s1 in leaf2.
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.layout.rootPaneId).toBe(leaf1);
    expect(tabs[0]!.layout.nodes).toHaveLength(1);
    expect(allTabPanels(tabs[0]!).map((p) => p.spec)).toEqual([{ _tag: 'Session', sessionId: s1 }]);
    expect(tabs[0]!.focusedPanelId).toBe(PanelId.make('p1'));
    expect(allTabPanels(tabs[1]!).map((p) => p.spec)).toEqual([{ _tag: 'Session', sessionId: s3 }]);

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
                    panels: [{ id: PanelId.make('pa'), spec: { _tag: 'Session', sessionId: s1 } }],
                  },
                  {
                    _tag: 'Leaf',
                    id: leaf2,
                    panels: [{ id: PanelId.make('pb'), spec: { _tag: 'Session', sessionId: s2 } }],
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

  it('opens Sessions in split Panes via openSessionInSplit (splitting under 4 Panes, opening a Tab at 4, and focusing existing)', () => {
    const createIds = makeIds();
    const createSplitIds = makeSplitIds();
    const s4 = SessionId.make('s4');
    const s5 = SessionId.make('s5');

    // Without an active Tab in Project, openSessionInSplit creates a fresh Tab.
    const first = openSessionInSplit(EMPTY_WORKSPACE, {
      projectId: p1,
      sessionId: s1,
      createTabIds: createIds,
      createSplitIds,
    });
    expect(first.created).toBe(true);
    expect(first.capped).toBe(false);
    expect(first.workspace.projects[0]?.tabs).toHaveLength(1);

    // Splitting into the active Tab adds s2 side-by-side.
    const split2 = openSessionInSplit(first.workspace, {
      projectId: p1,
      sessionId: s2,
      createTabIds: createIds,
      createSplitIds,
    });
    expect(split2.created).toBe(true);
    expect(split2.tabId).toBe(first.tabId);
    expect(paneCount(split2.tab!)).toBe(2);

    const split3 = openSessionInSplit(split2.workspace, {
      projectId: p1,
      sessionId: s3,
      side: 'bottom',
      createTabIds: createIds,
      createSplitIds,
    });
    expect(paneCount(split3.tab!)).toBe(3);

    const split4 = openSessionInSplit(split3.workspace, {
      projectId: p1,
      sessionId: s4,
      createTabIds: createIds,
      createSplitIds,
    });
    expect(paneCount(split4.tab!)).toBe(MAX_PANES_PER_TAB);

    // At MAX_PANES_PER_TAB, openSessionInSplit returns capped: true and does not exceed 4 Panes.
    const fifth = openSessionInSplit(split4.workspace, {
      projectId: p1,
      sessionId: s5,
      createTabIds: createIds,
      createSplitIds,
    });
    expect(fifth.created).toBe(false);
    expect(fifth.capped).toBe(true);
    expect(paneCount(fifth.workspace.projects[0]!.tabs[0]!)).toBe(MAX_PANES_PER_TAB);

    // Re-opening an already open Session in another Project focuses it without duplicating.
    const withP2 = openSessionTab(fifth.workspace, {
      projectId: p2,
      sessionId: SessionId.make('s-p2'),
      createIds,
    }).workspace;
    const focusedS2 = openSessionInSplit(withP2, {
      projectId: p2,
      sessionId: s2,
      createTabIds: createIds,
      createSplitIds,
    });
    expect(focusedS2.created).toBe(false);
    expect(focusedS2.capped).toBe(false);
    expect(focusedS2.workspace.activeProjectId).toBe(p1);
    expect(focusedS2.panelId).toBe(split2.panelId);
  });

  it('replaces a Session in its Pane while preserving existing Session uniqueness', () => {
    const createIds = makeIds();
    const base = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const worker = openSessionTab(base.workspace, {
      projectId: p1,
      sessionId: s2,
      replacePanelId: base.panelId,
      workerAncestors: [s1],
      createIds,
    });
    expect(worker.tabId).toBe(base.tabId);
    expect(worker.tab.layout.rootPaneId).toBe(base.tab.layout.rootPaneId);
    expect(worker.panelId).not.toBe(base.panelId);
    expect(allTabPanels(worker.tab)).toEqual([
      {
        id: worker.panelId,
        spec: { _tag: 'Session', sessionId: s2, workerAncestors: [s1], retainedSessions: [s1] },
      },
    ]);

    const elsewhere = openSessionTab(worker.workspace, { projectId: p2, sessionId: s3, createIds });
    const alreadyOpen = openSessionTab(elsewhere.workspace, {
      projectId: p1,
      sessionId: s3,
      replacePanelId: worker.panelId,
      createIds,
    });
    expect(alreadyOpen.tabId).toBe(elsewhere.tabId);
    expect(alreadyOpen.workspace.activeProjectId).toBe(p2);
    expect(findSessionPanel(alreadyOpen.workspace, s2)?.panel.id).toBe(worker.panelId);
  });

  it('moves a Panel to split another Pane edge and swaps two Panes on center drop cleanly', () => {
    const createIds = makeIds();
    const createSplitIds = makeSplitIds();
    const s4 = SessionId.make('s4');

    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const pane1 = allTabLeaves(first.tab)[0]!.id;
    const split2 = splitPane(first.workspace, {
      paneId: pane1,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s2 },
      createIds: createSplitIds,
    });
    const pane2 = split2.paneId!;
    const p1Panel = first.panelId;
    const p2Panel = split2.panelId!;

    // Dragging a lone Panel onto its own Pane is a no-op (both split and swap).
    const tab2 = split2.workspace.projects[0]!.tabs[0]!;
    expect(canSplitDrop(tab2, pane1, pane1)).toBe(false);
    expect(canSplitDrop(tab2, pane1, pane2)).toBe(true);
    expect(
      movePanelToSplit(split2.workspace, {
        panelId: p1Panel,
        targetPaneId: pane1,
        side: 'bottom',
        createSplitIds,
      }),
    ).toBe(split2.workspace);
    expect(
      swapPanelToPane(split2.workspace, {
        panelId: p1Panel,
        targetPaneId: pane1,
      }),
    ).toBe(split2.workspace);

    // Moving p2Panel onto 'top' of pane1 keeps 2 Panes while swapping orientation cleanly.
    const moved = movePanelToSplit(split2.workspace, {
      panelId: p2Panel,
      targetPaneId: pane1,
      side: 'top',
      createSplitIds,
    });
    const tabAfterMove = moved.projects[0]!.tabs[0]!;
    expect(paneCount(tabAfterMove)).toBe(2);
    expect(tabAfterMove.focusedPanelId).toBe(p2Panel);
    const leaves = allTabLeaves(tabAfterMove);
    const newPane2 = leaves.find((l) => l.panels[0]?.id === p2Panel)!.id;

    // Add s3 and s4 so paneCount === 4; moving any Pane's lone Panel still succeeds because source collapses.
    const with3 = splitPane(moved, {
      paneId: pane1,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s3 },
      createIds: createSplitIds,
    });
    const with4 = splitPane(with3.workspace, {
      paneId: newPane2,
      side: 'left',
      spec: { _tag: 'Session', sessionId: s4 },
      createIds: createSplitIds,
    });
    const tabWith4 = with4.workspace.projects[0]!.tabs[0]!;
    expect(paneCount(tabWith4)).toBe(4);
    expect(canSplitDrop(tabWith4, pane1, newPane2)).toBe(true);
    const reorderedSplit = movePanelToSplit(with4.workspace, {
      panelId: p1Panel,
      targetPaneId: newPane2,
      side: 'bottom',
      createSplitIds,
    });
    expect(paneCount(reorderedSplit.projects[0]!.tabs[0]!)).toBe(4);

    // swapPanelToPane and swapPanePanels exchange the Panels inside two Panes while leaving layout tree shape untouched.
    const paneForP1 = findSessionPanel(reorderedSplit, s1)!.pane.id;
    const paneForS3 = findSessionPanel(reorderedSplit, s3)!.pane.id;
    const swapped = swapPanelToPane(reorderedSplit, {
      panelId: p1Panel,
      targetPaneId: paneForS3,
    });
    expect(findSessionPanel(swapped, s1)?.pane.id).toBe(paneForS3);
    expect(findSessionPanel(swapped, s3)?.pane.id).toBe(paneForP1);
    expect(swapped.projects[0]!.tabs[0]!.focusedPanelId).toBe(p1Panel);

    const swappedBack = swapPanePanels(swapped, paneForS3, paneForP1);
    expect(findSessionPanel(swappedBack, s1)?.pane.id).toBe(paneForP1);
    expect(findSessionPanel(swappedBack, s3)?.pane.id).toBe(paneForS3);
  });

  it('stores per-session wallpapers and preserves sessionWallpapers across layout transforms', () => {
    const createIds = makeIds();
    const createSplitIds = makeSplitIds();
    const first = openSessionTab(EMPTY_WORKSPACE, { projectId: p1, sessionId: s1, createIds });
    const withBg = setSessionWallpaperInWorkspace(first.workspace, s1, 'cobalt-halftone');
    expect(withBg.sessionWallpapers).toEqual({ [s1]: 'cobalt-halftone' });
    // Setting the same wallpaper is a no-op reference identity return.
    expect(setSessionWallpaperInWorkspace(withBg, s1, 'cobalt-halftone')).toBe(withBg);

    const updatedBg = setSessionWallpaperInWorkspace(withBg, s2, 'rose-halftone');
    const afterSplit = splitPane(updatedBg, {
      paneId: allTabLeaves(first.tab)[0]!.id,
      side: 'right',
      spec: { _tag: 'Session', sessionId: s2 },
      createIds: createSplitIds,
    }).workspace;
    expect(afterSplit.sessionWallpapers).toEqual({
      [s1]: 'cobalt-halftone',
      [s2]: 'rose-halftone',
    });
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
