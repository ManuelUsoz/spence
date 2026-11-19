import { describe, expect, it } from '@effect/vitest';
import { ProjectId } from '../projects/projects.rpc';
import { SessionId } from '../sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from './tabs.rpc';
import {
  EMPTY_WORKSPACE,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  activateTab,
  allTabPanels,
  allWorkspaceSessionIds,
  attachDraftSession,
  closePanel,
  closeTab,
  createSinglePaneTab,
  findSessionPanel,
  focusPanel,
  normalizeWorkspace,
  openDraftTab,
  openSessionTab,
  promoteDraftSession,
  pruneProject,
  pruneSession,
  renameTab,
  stripDrafts,
  switchProject,
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
});
