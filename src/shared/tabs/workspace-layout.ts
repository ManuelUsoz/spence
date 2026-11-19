import type { ProjectId } from '../projects/projects.rpc';
import type { SessionId } from '../sessions/sessions.rpc';
import type {
  LeafPaneNode,
  PaneId,
  PaneLayout,
  PaneNode,
  PanelId,
  PanelSpec,
  ProjectWorkspace,
  TabId,
  WorkspacePanel,
  WorkspaceState,
  WorkspaceTab,
} from './tabs.rpc';

export const MAX_PANES_PER_TAB = 4;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const MIN_STACK_SHARE = 0.15;

export const EMPTY_WORKSPACE: WorkspaceState = { projects: [] };

export interface TabIdsFactory {
  readonly tabId: TabId;
  readonly paneId: PaneId;
  readonly panelId: PanelId;
}

const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)) : 0.5;

const buildNodeMap = (layout: PaneLayout): ReadonlyMap<PaneId, PaneNode> =>
  new Map(layout.nodes.map((node) => [node.id, node]));

/** Traverses a `PaneLayout` in left-to-right / top-to-bottom order and returns reachable `LeafPaneNode`s. */
export const allTabLeaves = (tab: WorkspaceTab): ReadonlyArray<LeafPaneNode> => {
  const byId = buildNodeMap(tab.layout);
  const visited = new Set<PaneId>();
  const leaves: Array<LeafPaneNode> = [];
  const visit = (paneId: PaneId): void => {
    if (visited.has(paneId)) return;
    visited.add(paneId);
    const node = byId.get(paneId);
    if (node === undefined) return;
    if (node._tag === 'Leaf') {
      leaves.push(node);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  visit(tab.layout.rootPaneId);
  return leaves;
};

/** Returns all Panels in `tab` in layout traversal order. */
export const allTabPanels = (tab: WorkspaceTab): ReadonlyArray<WorkspacePanel> =>
  allTabLeaves(tab).flatMap((leaf) => leaf.panels);

/** Returns the `ProjectWorkspace` for `projectId`, if present. */
export const findProject = (
  workspace: WorkspaceState,
  projectId: ProjectId,
): ProjectWorkspace | undefined =>
  workspace.projects.find((project) => project.projectId === projectId);

/** Returns the currently active `ProjectWorkspace`, if `activeProjectId` matches one. */
export const activeProjectWorkspace = (workspace: WorkspaceState): ProjectWorkspace | undefined =>
  workspace.activeProjectId === undefined
    ? undefined
    : findProject(workspace, workspace.activeProjectId);

/** Returns the active `WorkspaceTab` for `projectId` (defaulting to `workspace.activeProjectId`). */
export const activeTabOf = (
  workspace: WorkspaceState,
  projectId: ProjectId | undefined = workspace.activeProjectId,
): WorkspaceTab | undefined => {
  if (projectId === undefined) return undefined;
  const project = findProject(workspace, projectId);
  if (project === undefined || project.tabs.length === 0) return undefined;
  return project.tabs.find((tab) => tab.id === project.activeTabId) ?? project.tabs[0];
};

/** Returns the focused `WorkspacePanel` of `tab`, falling back to its first expanded Panel. */
export const focusedPanelOf = (tab: WorkspaceTab): WorkspacePanel | undefined => {
  const panels = allTabPanels(tab);
  return (
    panels.find((panel) => panel.id === tab.focusedPanelId) ??
    panels.find((panel) => !panel.collapsed) ??
    panels[0]
  );
};

/** Finds `tabId` across all Projects. */
export const findTab = (
  workspace: WorkspaceState,
  tabId: TabId,
):
  | { readonly projectId: ProjectId; readonly tab: WorkspaceTab; readonly index: number }
  | undefined => {
  for (const project of workspace.projects) {
    const index = project.tabs.findIndex((tab) => tab.id === tabId);
    const tab = project.tabs[index];
    if (tab !== undefined) return { projectId: project.projectId, tab, index };
  }
  return undefined;
};

/** Finds `panelId` across all Projects and Tabs. */
export const findPanel = (
  workspace: WorkspaceState,
  panelId: PanelId,
):
  | {
      readonly projectId: ProjectId;
      readonly tab: WorkspaceTab;
      readonly pane: LeafPaneNode;
      readonly panel: WorkspacePanel;
    }
  | undefined => {
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const pane of allTabLeaves(tab)) {
        const panel = pane.panels.find((candidate) => candidate.id === panelId);
        if (panel !== undefined) return { projectId: project.projectId, tab, pane, panel };
      }
    }
  }
  return undefined;
};

/** Finds the unique `Session` Panel bound to `sessionId` across all Projects and Tabs. */
export const findSessionPanel = (
  workspace: WorkspaceState,
  sessionId: SessionId,
):
  | {
      readonly projectId: ProjectId;
      readonly tab: WorkspaceTab;
      readonly pane: LeafPaneNode;
      readonly panel: WorkspacePanel;
    }
  | undefined => {
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const pane of allTabLeaves(tab)) {
        const panel = pane.panels.find(
          (candidate) =>
            candidate.spec._tag === 'Session' && candidate.spec.sessionId === sessionId,
        );
        if (panel !== undefined) return { projectId: project.projectId, tab, pane, panel };
      }
    }
  }
  return undefined;
};

/** Finds the first draft `Session` Panel in `projectId`, if any. */
export const findDraftPanel = (
  workspace: WorkspaceState,
  projectId: ProjectId,
):
  | { readonly tab: WorkspaceTab; readonly pane: LeafPaneNode; readonly panel: WorkspacePanel }
  | undefined => {
  const project = findProject(workspace, projectId);
  if (project === undefined) return undefined;
  for (const tab of project.tabs) {
    for (const pane of allTabLeaves(tab)) {
      const panel = pane.panels.find(
        (candidate) => candidate.spec._tag === 'Session' && candidate.spec.draft === true,
      );
      if (panel !== undefined) return { tab, pane, panel };
    }
  }
  return undefined;
};

/** Collects every `Session` Panel `SessionId` open anywhere in `workspace`. */
export const allWorkspaceSessionIds = (workspace: WorkspaceState): ReadonlySet<SessionId> => {
  const ids = new Set<SessionId>();
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const panel of allTabPanels(tab)) {
        if (panel.spec._tag === 'Session' && panel.spec.sessionId !== undefined) {
          ids.add(panel.spec.sessionId);
        }
      }
    }
  }
  return ids;
};

/** Collects every `SessionId` referenced by any Panel (`Session`, `Changes`, or `Workers`). */
export const allReferencedSessionIds = (workspace: WorkspaceState): ReadonlySet<SessionId> => {
  const ids = new Set<SessionId>();
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const panel of allTabPanels(tab)) {
        if (panel.spec.sessionId !== undefined) ids.add(panel.spec.sessionId);
      }
    }
  }
  return ids;
};

/** Collects every expanded `Session` Panel `SessionId` in the active Project's active Tab. */
export const visibleSessionIds = (workspace: WorkspaceState): ReadonlySet<SessionId> => {
  const tab = activeTabOf(workspace);
  if (tab === undefined) return new Set();
  const ids = new Set<SessionId>();
  for (const panel of allTabPanels(tab)) {
    if (!panel.collapsed && panel.spec._tag === 'Session' && panel.spec.sessionId !== undefined) {
      ids.add(panel.spec.sessionId);
    }
  }
  return ids;
};

/** Creates a new single-Pane Tab containing one expanded Panel. */
export const createSinglePaneTab = (options: {
  readonly tabId: TabId;
  readonly paneId: PaneId;
  readonly panelId: PanelId;
  readonly spec: PanelSpec;
  readonly customTitle?: string;
}): WorkspaceTab => ({
  id: options.tabId,
  ...(options.customTitle === undefined || options.customTitle.trim() === ''
    ? {}
    : { customTitle: options.customTitle.trim() }),
  focusedPanelId: options.panelId,
  layout: {
    rootPaneId: options.paneId,
    nodes: [
      {
        _tag: 'Leaf',
        id: options.paneId,
        panels: [{ id: options.panelId, spec: options.spec, collapsed: false, heightShare: 1 }],
      },
    ],
  },
});

const normalizePanels = (panels: ReadonlyArray<WorkspacePanel>): ReadonlyArray<WorkspacePanel> => {
  if (panels.length === 0) return [];
  if (panels.length === 1) {
    const only = panels[0];
    return only === undefined
      ? []
      : [{ ...only, collapsed: false, heightShare: only.heightShare > 0 ? only.heightShare : 1 }];
  }
  const hasExpanded = panels.some((panel) => !panel.collapsed);
  return panels.map((panel, index) => ({
    ...panel,
    collapsed: hasExpanded ? panel.collapsed : index !== 0,
    heightShare:
      Number.isFinite(panel.heightShare) && panel.heightShare > 0 ? panel.heightShare : 1,
  }));
};

const normalizeLayout = (
  layout: PaneLayout,
  filterPanel: (panel: WorkspacePanel) => boolean,
  seenSessions: Set<SessionId>,
): PaneLayout | null => {
  const byId = buildNodeMap(layout);
  const visited = new Set<PaneId>();
  const collected: Array<PaneNode> = [];

  const visit = (paneId: PaneId): PaneId | null => {
    if (visited.has(paneId)) return null;
    visited.add(paneId);
    const node = byId.get(paneId);
    if (node === undefined) return null;

    if (node._tag === 'Leaf') {
      const kept = node.panels.filter((panel) => {
        if (!filterPanel(panel)) return false;
        if (panel.spec._tag === 'Session' && panel.spec.sessionId !== undefined) {
          if (seenSessions.has(panel.spec.sessionId)) return false;
          seenSessions.add(panel.spec.sessionId);
        }
        return true;
      });
      const panels = normalizePanels(kept);
      if (panels.length === 0) return null;
      collected.push({ ...node, panels });
      return node.id;
    }

    const first = visit(node.first);
    const second = visit(node.second);
    if (first === null && second === null) return null;
    if (first === null) return second;
    if (second === null) return first;
    collected.push({ ...node, ratio: clampRatio(node.ratio), first, second });
    return node.id;
  };

  const rootPaneId = visit(layout.rootPaneId);
  if (rootPaneId === null) return null;
  // Keep parent nodes before children or root first so traversal is tidy.
  const ordered = [
    ...collected.filter((node) => node.id === rootPaneId),
    ...collected.filter((node) => node.id !== rootPaneId),
  ];
  return { rootPaneId, nodes: ordered };
};

const normalizeTab = (
  tab: WorkspaceTab,
  filterPanel: (panel: WorkspacePanel) => boolean,
  seenSessions: Set<SessionId>,
): WorkspaceTab | null => {
  const layout = normalizeLayout(tab.layout, filterPanel, seenSessions);
  if (layout === null) return null;
  const candidate: WorkspaceTab = { ...tab, layout };
  const panels = allTabPanels(candidate);
  const focused =
    panels.find((panel) => panel.id === tab.focusedPanelId) ??
    panels.find((panel) => !panel.collapsed) ??
    panels[0];
  if (focused === undefined) return null;
  const { customTitle: _drop, ...rest } = candidate;
  const trimmedTitle = tab.customTitle?.trim();
  return {
    ...rest,
    ...(trimmedTitle === undefined || trimmedTitle === '' ? {} : { customTitle: trimmedTitle }),
    focusedPanelId: focused.id,
  };
};

const resolveActiveTabId = (
  oldTabs: ReadonlyArray<WorkspaceTab>,
  oldActiveId: TabId | undefined,
  nextTabs: ReadonlyArray<WorkspaceTab>,
): TabId | undefined => {
  if (nextTabs.length === 0) return undefined;
  if (oldActiveId !== undefined && nextTabs.some((tab) => tab.id === oldActiveId)) {
    return oldActiveId;
  }
  if (oldActiveId !== undefined) {
    const oldIndex = oldTabs.findIndex((tab) => tab.id === oldActiveId);
    if (oldIndex !== -1) {
      for (let i = oldIndex + 1; i < oldTabs.length; i += 1) {
        const candidate = oldTabs[i];
        if (candidate !== undefined && nextTabs.some((tab) => tab.id === candidate.id)) {
          return candidate.id;
        }
      }
      for (let i = oldIndex - 1; i >= 0; i -= 1) {
        const candidate = oldTabs[i];
        if (candidate !== undefined && nextTabs.some((tab) => tab.id === candidate.id)) {
          return candidate.id;
        }
      }
    }
  }
  return nextTabs[0]?.id;
};

const filterWorkspace = (
  workspace: WorkspaceState,
  options: {
    readonly validProject?: (projectId: ProjectId) => boolean;
    readonly filterPanel?: (panel: WorkspacePanel) => boolean;
  } = {},
): WorkspaceState => {
  const seenSessions = new Set<SessionId>();
  const filterPanel = options.filterPanel ?? (() => true);
  const validProject = options.validProject ?? (() => true);

  const projects: Array<ProjectWorkspace> = [];
  for (const project of workspace.projects) {
    if (!validProject(project.projectId)) continue;
    const tabs: Array<WorkspaceTab> = [];
    for (const tab of project.tabs) {
      const normalized = normalizeTab(tab, filterPanel, seenSessions);
      if (normalized !== null) tabs.push(normalized);
    }
    if (tabs.length === 0) continue;
    const activeTabId = resolveActiveTabId(project.tabs, project.activeTabId, tabs);
    projects.push({
      projectId: project.projectId,
      tabs,
      ...(activeTabId === undefined ? {} : { activeTabId }),
    });
  }

  const activeProjectId =
    workspace.activeProjectId !== undefined && validProject(workspace.activeProjectId)
      ? workspace.activeProjectId
      : projects[0]?.projectId;

  return {
    projects,
    ...(activeProjectId === undefined ? {} : { activeProjectId }),
  };
};

/** Normalizes every Project, Tab, and Pane tree in `workspace`, enforcing all layout invariants. */
export const normalizeWorkspace = (
  workspace: WorkspaceState,
  validProject?: (projectId: ProjectId) => boolean,
): WorkspaceState => filterWorkspace(workspace, validProject === undefined ? {} : { validProject });

const upsertProjectTab = (
  workspace: WorkspaceState,
  projectId: ProjectId,
  tab: WorkspaceTab,
  activateProject: boolean,
): WorkspaceState => {
  const existing = findProject(workspace, projectId);
  const nextProject: ProjectWorkspace =
    existing === undefined
      ? { projectId, tabs: [tab], activeTabId: tab.id }
      : { ...existing, tabs: [...existing.tabs, tab], activeTabId: tab.id };
  const projects =
    existing === undefined
      ? [...workspace.projects, nextProject]
      : workspace.projects.map((p) => (p.projectId === projectId ? nextProject : p));
  const nextActiveProjectId = activateProject ? projectId : workspace.activeProjectId;
  return {
    projects,
    ...(nextActiveProjectId === undefined ? {} : { activeProjectId: nextActiveProjectId }),
  };
};

const updateTabInWorkspace = (
  workspace: WorkspaceState,
  tabId: TabId,
  transform: (tab: WorkspaceTab, project: ProjectWorkspace) => WorkspaceTab,
): WorkspaceState => ({
  ...workspace,
  projects: workspace.projects.map((project) =>
    project.tabs.some((tab) => tab.id === tabId)
      ? {
          ...project,
          tabs: project.tabs.map((tab) => (tab.id === tabId ? transform(tab, project) : tab)),
        }
      : project,
  ),
});

/** Opens or focuses the unique `Session` Panel for `sessionId`, auto-expanding it if collapsed. */
export const openSessionTab = (
  workspace: WorkspaceState,
  options: {
    readonly projectId: ProjectId;
    readonly sessionId: SessionId;
    readonly createIds: () => TabIdsFactory;
    readonly activateProject?: boolean;
  },
): {
  readonly workspace: WorkspaceState;
  readonly tab: WorkspaceTab;
  readonly tabId: TabId;
  readonly panelId: PanelId;
  readonly created: boolean;
} => {
  const activateProject = options.activateProject ?? true;
  const existing = findSessionPanel(workspace, options.sessionId);
  if (existing !== undefined) {
    const next = focusPanel(workspace, existing.panel.id);
    const updatedTab = findTab(next, existing.tab.id)?.tab ?? existing.tab;
    if (activateProject) {
      return {
        workspace: next,
        tab: updatedTab,
        tabId: existing.tab.id,
        panelId: existing.panel.id,
        created: false,
      };
    }
    const { activeProjectId: _drop, ...rest } = next;
    return {
      workspace:
        workspace.activeProjectId === undefined
          ? rest
          : { ...rest, activeProjectId: workspace.activeProjectId },
      tab: updatedTab,
      tabId: existing.tab.id,
      panelId: existing.panel.id,
      created: false,
    };
  }
  const ids = options.createIds();
  const tab = createSinglePaneTab({
    ...ids,
    spec: { _tag: 'Session', sessionId: options.sessionId },
  });
  return {
    workspace: upsertProjectTab(workspace, options.projectId, tab, activateProject),
    tab,
    tabId: ids.tabId,
    panelId: ids.panelId,
    created: true,
  };
};

/** Opens a new draft Tab in `projectId` (or focuses the existing Project draft when `reuseExisting` is true). */
export const openDraftTab = (
  workspace: WorkspaceState,
  options: {
    readonly projectId: ProjectId;
    readonly createIds: () => TabIdsFactory;
    readonly reuseExisting?: boolean;
  },
): {
  readonly workspace: WorkspaceState;
  readonly tab: WorkspaceTab;
  readonly tabId: TabId;
  readonly panelId: PanelId;
  readonly created: boolean;
} => {
  if (options.reuseExisting === true) {
    const existing = findDraftPanel(workspace, options.projectId);
    if (existing !== undefined) {
      const next = focusPanel(workspace, existing.panel.id);
      return {
        workspace: next,
        tab: findTab(next, existing.tab.id)?.tab ?? existing.tab,
        tabId: existing.tab.id,
        panelId: existing.panel.id,
        created: false,
      };
    }
  }
  const ids = options.createIds();
  const tab = createSinglePaneTab({
    ...ids,
    spec: { _tag: 'Session', draft: true },
  });
  return {
    workspace: upsertProjectTab(workspace, options.projectId, tab, true),
    tab,
    tabId: ids.tabId,
    panelId: ids.panelId,
    created: true,
  };
};

/** Records the main-created `sessionId` on an unprompted draft `Session` Panel without changing active focus. */
export const attachDraftSession = (
  workspace: WorkspaceState,
  panelId: PanelId,
  sessionId: SessionId,
): WorkspaceState => {
  const found = findPanel(workspace, panelId);
  if (found === undefined || found.panel.spec._tag !== 'Session') return workspace;
  if (found.panel.spec.draft !== true && found.panel.spec.sessionId !== undefined) return workspace;
  if (found.panel.spec.sessionId === sessionId) return workspace;
  return updateTabInWorkspace(workspace, found.tab.id, (tab) => ({
    ...tab,
    layout: {
      ...tab.layout,
      nodes: tab.layout.nodes.map((node) =>
        node._tag === 'Leaf'
          ? {
              ...node,
              panels: node.panels.map((panel) =>
                panel.id === panelId
                  ? { ...panel, spec: { _tag: 'Session', sessionId, draft: true } }
                  : panel,
              ),
            }
          : node,
      ),
    },
  }));
};

/** Promotes a draft `Session` Panel to a kept Session once its first Message is sent. */
export const promoteDraftSession = (
  workspace: WorkspaceState,
  panelId: PanelId,
  sessionId: SessionId,
): WorkspaceState => {
  const found = findPanel(workspace, panelId);
  if (found === undefined || found.panel.spec._tag !== 'Session') return workspace;
  if (found.panel.spec.sessionId === sessionId && found.panel.spec.draft !== true) return workspace;
  return updateTabInWorkspace(workspace, found.tab.id, (tab) => ({
    ...tab,
    layout: {
      ...tab.layout,
      nodes: tab.layout.nodes.map((node) =>
        node._tag === 'Leaf'
          ? {
              ...node,
              panels: node.panels.map((panel) =>
                panel.id === panelId ? { ...panel, spec: { _tag: 'Session', sessionId } } : panel,
              ),
            }
          : node,
      ),
    },
  }));
};

/** Activates `tabId` and its owning Project without altering Panel collapsed state. */
export const activateTab = (workspace: WorkspaceState, tabId: TabId): WorkspaceState => {
  const found = findTab(workspace, tabId);
  if (found === undefined) return workspace;
  return {
    activeProjectId: found.projectId,
    projects: workspace.projects.map((project) =>
      project.projectId === found.projectId ? { ...project, activeTabId: tabId } : project,
    ),
  };
};

/** Focuses `panelId` inside its Tab/Project and auto-expands it if collapsed. */
export const focusPanel = (workspace: WorkspaceState, panelId: PanelId): WorkspaceState => {
  const found = findPanel(workspace, panelId);
  if (found === undefined) return workspace;
  return {
    activeProjectId: found.projectId,
    projects: workspace.projects.map((project) =>
      project.projectId === found.projectId
        ? {
            ...project,
            activeTabId: found.tab.id,
            tabs: project.tabs.map((tab) =>
              tab.id === found.tab.id
                ? {
                    ...tab,
                    focusedPanelId: panelId,
                    layout: {
                      ...tab.layout,
                      nodes: tab.layout.nodes.map((node) =>
                        node._tag === 'Leaf'
                          ? {
                              ...node,
                              panels: node.panels.map((panel) =>
                                panel.id === panelId && panel.collapsed
                                  ? { ...panel, collapsed: false }
                                  : panel,
                              ),
                            }
                          : node,
                      ),
                    },
                  }
                : tab,
            ),
          }
        : project,
    ),
  };
};

/** Switches the active Project while leaving all Projects' Tabs untouched. */
export const switchProject = (workspace: WorkspaceState, projectId: ProjectId): WorkspaceState => ({
  ...workspace,
  activeProjectId: projectId,
});

/** Sets `customTitle` on `tabId`, or clears `customTitle` when blank. */
export const renameTab = (
  workspace: WorkspaceState,
  tabId: TabId,
  customTitle: string | undefined,
): WorkspaceState => {
  const trimmed = customTitle?.trim() ?? '';
  return updateTabInWorkspace(workspace, tabId, (tab) => {
    const { customTitle: _drop, ...rest } = tab;
    return trimmed === '' ? rest : { ...rest, customTitle: trimmed };
  });
};

/** Closes `tabId`, shifting `activeTabId` to the next Tab (else previous, else undefined). */
export const closeTab = (workspace: WorkspaceState, tabId: TabId): WorkspaceState => {
  const found = findTab(workspace, tabId);
  if (found === undefined) return workspace;
  const projects: Array<ProjectWorkspace> = [];
  for (const project of workspace.projects) {
    if (project.projectId !== found.projectId) {
      projects.push(project);
      continue;
    }
    const rest = project.tabs.filter((tab) => tab.id !== tabId);
    if (rest.length === 0) continue;
    const nextActiveId =
      project.activeTabId === tabId
        ? (rest[found.index] ?? rest[found.index - 1])?.id
        : project.activeTabId;
    projects.push({
      projectId: project.projectId,
      tabs: rest,
      ...(nextActiveId === undefined ? {} : { activeTabId: nextActiveId }),
    });
  }
  return {
    projects,
    ...(workspace.activeProjectId === undefined
      ? {}
      : { activeProjectId: workspace.activeProjectId }),
  };
};

const removePanelsFromLeaf = (
  panels: ReadonlyArray<WorkspacePanel>,
  shouldRemove: (panel: WorkspacePanel) => boolean,
): ReadonlyArray<WorkspacePanel> => {
  const kept: Array<WorkspacePanel> = [];
  let removedExpandedAt: number | undefined;
  for (const panel of panels) {
    if (shouldRemove(panel)) {
      if (!panel.collapsed && removedExpandedAt === undefined) removedExpandedAt = kept.length;
      continue;
    }
    kept.push(panel);
  }
  if (kept.length === 0) return [];
  if (kept.some((panel) => !panel.collapsed)) return kept;
  const expandIndex =
    removedExpandedAt !== undefined && removedExpandedAt < kept.length
      ? removedExpandedAt
      : kept.length - 1;
  return kept.map((panel, index) =>
    index === expandIndex ? { ...panel, collapsed: false } : panel,
  );
};

const pruneTabPanels = (
  tab: WorkspaceTab,
  shouldRemove: (panel: WorkspacePanel) => boolean,
): WorkspaceTab => ({
  ...tab,
  layout: {
    ...tab.layout,
    nodes: tab.layout.nodes.map((node) =>
      node._tag === 'Leaf'
        ? { ...node, panels: removePanelsFromLeaf(node.panels, shouldRemove) }
        : node,
    ),
  },
});

const prunePanelsWhere = (
  workspace: WorkspaceState,
  shouldRemove: (panel: WorkspacePanel) => boolean,
  validProject?: (projectId: ProjectId) => boolean,
): WorkspaceState => {
  const updated: WorkspaceState = {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      tabs: project.tabs.map((tab) => pruneTabPanels(tab, shouldRemove)),
    })),
  };
  return filterWorkspace(updated, validProject === undefined ? {} : { validProject });
};

/** Closes `panelId`, auto-expanding a sibling Panel if needed and collapsing empty Panes or Tabs. */
export const closePanel = (workspace: WorkspaceState, panelId: PanelId): WorkspaceState =>
  prunePanelsWhere(workspace, (panel) => panel.id === panelId);

/** Removes every `Session`, `Changes`, and `Workers` Panel bound to `sessionId`. */
export const pruneSession = (workspace: WorkspaceState, sessionId: SessionId): WorkspaceState =>
  prunePanelsWhere(workspace, (panel) => panel.spec.sessionId === sessionId);

/** Removes every Panel matching `shouldPruneSession(sessionId)` (including pinned auxiliary Panels). */
export const pruneSessions = (
  workspace: WorkspaceState,
  shouldPruneSession: (sessionId: SessionId) => boolean,
  validProject?: (projectId: ProjectId) => boolean,
): WorkspaceState =>
  prunePanelsWhere(
    workspace,
    (panel) => panel.spec.sessionId !== undefined && shouldPruneSession(panel.spec.sessionId),
    validProject,
  );

/** Strips draft `Session` Panels (and any auxiliary Panels pinned to stripped `SessionId`s). */
export const stripDrafts = (
  workspace: WorkspaceState,
  isDraft: (sessionId: SessionId | undefined) => boolean,
): WorkspaceState => {
  const draftSessionIds = new Set<SessionId>();
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const panel of allTabPanels(tab)) {
        if (
          panel.spec._tag === 'Session' &&
          (panel.spec.draft === true || isDraft(panel.spec.sessionId))
        ) {
          if (panel.spec.sessionId !== undefined) draftSessionIds.add(panel.spec.sessionId);
        }
      }
    }
  }
  return prunePanelsWhere(workspace, (panel) => {
    if (panel.spec._tag === 'Session') {
      return panel.spec.draft === true || isDraft(panel.spec.sessionId);
    }
    return draftSessionIds.has(panel.spec.sessionId) || isDraft(panel.spec.sessionId);
  });
};

/** Removes `projectId` from `workspace`, clearing or falling back `activeProjectId` if needed. */
export const pruneProject = (workspace: WorkspaceState, projectId: ProjectId): WorkspaceState =>
  filterWorkspace(workspace, { validProject: (id) => id !== projectId });
