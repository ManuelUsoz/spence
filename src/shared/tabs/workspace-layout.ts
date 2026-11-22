import type { DeviceId } from '../devices/devices.rpc';
import type { ProjectId } from '../projects/projects.rpc';
import type { SessionId } from '../sessions/sessions.rpc';
import {
  PaneId,
  TabId,
  type LeafPaneNode,
  type PaneLayout,
  type PaneNode,
  type PanelId,
  type PanelSpec,
  type ProjectWorkspace,
  type SplitDirection,
  type SplitPaneNode,
  type WorkspacePanel,
  type WorkspaceState,
  type WorkspaceTab,
} from './tabs.rpc';

export const MAX_PANES_PER_TAB = 4;
export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;

export const EMPTY_WORKSPACE: WorkspaceState = { projects: [] };

export type SplitSide = 'left' | 'right' | 'top' | 'bottom';

export interface TabIdsFactory {
  readonly tabId: TabId;
  readonly paneId: PaneId;
  readonly panelId: PanelId;
}

export interface SplitIdsFactory {
  readonly splitPaneId: PaneId;
  readonly newPaneId: PaneId;
  readonly panelId: PanelId;
}

export interface NewWorkspacePanel {
  readonly id: PanelId;
  readonly spec: PanelSpec;
}

const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio)) : 0.5;

const buildNodeMap = (layout: PaneLayout): ReadonlyMap<PaneId, PaneNode> =>
  new Map(layout.nodes.map((node) => [node.id, node]));

const keepWallpapers = (
  sessionWallpapers: WorkspaceState['sessionWallpapers'],
): Partial<Pick<WorkspaceState, 'sessionWallpapers'>> =>
  sessionWallpapers !== undefined && Object.keys(sessionWallpapers).length > 0
    ? { sessionWallpapers }
    : {};

/** Traverses a `PaneLayout` in left-to-right / top-to-bottom order and returns reachable `LeafPaneNode`s. */
export const allTabLeaves = (tab: { readonly layout: PaneLayout }): ReadonlyArray<LeafPaneNode> => {
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

/** Returns the number of reachable Leaf Panes in `tab` (or `{ layout }`). */
export const paneCount = (tab: { readonly layout: PaneLayout }): number => allTabLeaves(tab).length;

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

/** Returns the focused `WorkspacePanel` of `tab`, falling back to its first Panel. */
export const focusedPanelOf = (tab: WorkspaceTab): WorkspacePanel | undefined => {
  const panels = allTabPanels(tab);
  return panels.find((panel) => panel.id === tab.focusedPanelId) ?? panels[0];
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

/** Finds `paneId` across all Projects and Tabs. */
export const findPane = (
  workspace: WorkspaceState,
  paneId: PaneId,
):
  | {
      readonly projectId: ProjectId;
      readonly tab: WorkspaceTab;
      readonly pane: LeafPaneNode;
    }
  | undefined => {
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      const pane = allTabLeaves(tab).find((candidate) => candidate.id === paneId);
      if (pane !== undefined) return { projectId: project.projectId, tab, pane };
    }
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
export const allWorkspaceSessionIds = (
  workspace: WorkspaceState,
  includeRetained = false,
): ReadonlySet<SessionId> => {
  const ids = new Set<SessionId>();
  for (const project of workspace.projects) {
    for (const tab of project.tabs) {
      for (const panel of allTabPanels(tab)) {
        if (panel.spec._tag !== 'Session') continue;
        if (panel.spec.sessionId !== undefined) ids.add(panel.spec.sessionId);
        if (includeRetained) {
          for (const id of panel.spec.retainedSessions ?? []) ids.add(id);
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
        if (panel.spec._tag === 'Session') {
          for (const id of panel.spec.retainedSessions ?? []) ids.add(id);
          for (const id of panel.spec.workerAncestors ?? []) ids.add(id);
        }
      }
    }
  }
  return ids;
};

/** Collects every `Session` Panel `SessionId` in the active Project's active Tab. */
export const visibleSessionIds = (workspace: WorkspaceState): ReadonlySet<SessionId> => {
  const tab = activeTabOf(workspace);
  if (tab === undefined) return new Set();
  const ids = new Set<SessionId>();
  for (const panel of allTabPanels(tab)) {
    if (panel.spec._tag === 'Session' && panel.spec.sessionId !== undefined) {
      ids.add(panel.spec.sessionId);
    }
  }
  return ids;
};

/** Creates a new single-Pane Tab containing one Panel. */
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
        panels: [{ id: options.panelId, spec: options.spec }],
      },
    ],
  },
});

const isPanePanelAllowed = (panel: WorkspacePanel): boolean =>
  panel.spec._tag !== 'Changes' && panel.spec._tag !== 'Workers';

const normalizeLayout = (
  layout: PaneLayout,
  focusedPanelId: PanelId | undefined,
  filterPanel: (panel: WorkspacePanel) => boolean,
  seenSessions: Set<SessionId>,
  promoted?: Array<WorkspacePanel>,
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
      const candidates = node.panels.filter((panel) => {
        if (!filterPanel(panel)) return false;
        if (panel.spec._tag === 'Session' && panel.spec.sessionId !== undefined) {
          return !seenSessions.has(panel.spec.sessionId);
        }
        return true;
      });
      if (candidates.length === 0) return null;
      const primary =
        (focusedPanelId === undefined
          ? undefined
          : candidates.find((panel) => panel.id === focusedPanelId)) ?? candidates[0];
      if (primary === undefined) return null;
      if (primary.spec._tag === 'Session' && primary.spec.sessionId !== undefined) {
        seenSessions.add(primary.spec.sessionId);
      }
      if (promoted !== undefined) {
        for (const extra of candidates) {
          if (extra.id === primary.id) continue;
          if (
            extra.spec._tag === 'Session' &&
            extra.spec.draft !== true &&
            extra.spec.sessionId !== undefined &&
            !seenSessions.has(extra.spec.sessionId)
          ) {
            seenSessions.add(extra.spec.sessionId);
            promoted.push({ id: extra.id, spec: extra.spec });
          }
        }
      }
      collected.push({ ...node, panels: [{ id: primary.id, spec: primary.spec }] });
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
  promoted?: Array<WorkspacePanel>,
): WorkspaceTab | null => {
  const layout = normalizeLayout(
    tab.layout,
    tab.focusedPanelId,
    filterPanel,
    seenSessions,
    promoted,
  );
  if (layout === null) return null;
  const candidate: WorkspaceTab = { ...tab, layout };
  const panels = allTabPanels(candidate);
  const focused = panels.find((panel) => panel.id === tab.focusedPanelId) ?? panels[0];
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

const uniqueMigratedTabId = (usedTabIds: Set<TabId>, panelId: PanelId): TabId => {
  let candidate = TabId.make(`migrated:${panelId}`);
  let suffix = 1;
  while (usedTabIds.has(candidate)) {
    candidate = TabId.make(`migrated:${panelId}:${suffix}`);
    suffix += 1;
  }
  usedTabIds.add(candidate);
  return candidate;
};

const filterWorkspace = (
  workspace: WorkspaceState,
  options: {
    readonly validProject?: (projectId: ProjectId) => boolean;
    readonly filterPanel?: (panel: WorkspacePanel) => boolean;
    readonly pruneWallpaper?: (sessionId: SessionId) => boolean;
  } = {},
): WorkspaceState => {
  const seenSessions = new Set<SessionId>();
  const filterPanel = options.filterPanel ?? isPanePanelAllowed;
  const validProject = options.validProject ?? (() => true);

  const projects: Array<ProjectWorkspace> = [];
  for (const project of workspace.projects) {
    if (!validProject(project.projectId)) continue;
    const tabs: Array<WorkspaceTab> = [];
    const promoted: Array<WorkspacePanel> = [];
    const usedTabIds = new Set(project.tabs.map((tab) => tab.id));
    for (const tab of project.tabs) {
      const normalized = normalizeTab(tab, filterPanel, seenSessions, promoted);
      if (normalized !== null) tabs.push(normalized);
    }
    for (const extra of promoted) {
      tabs.push(
        createSinglePaneTab({
          tabId: uniqueMigratedTabId(usedTabIds, extra.id),
          paneId: PaneId.make(`migrated-pane:${extra.id}`),
          panelId: extra.id,
          spec: extra.spec,
        }),
      );
    }
    if (tabs.length === 0) continue;
    const activeTabId = resolveActiveTabId(project.tabs, project.activeTabId, tabs);
    projects.push({
      projectId: project.projectId,
      ...(project.device === undefined ? {} : { device: project.device }),
      tabs,
      ...(activeTabId === undefined ? {} : { activeTabId }),
    });
  }

  const activeProjectId =
    workspace.activeProjectId !== undefined && validProject(workspace.activeProjectId)
      ? workspace.activeProjectId
      : projects[0]?.projectId;

  const pruneWallpaper = options.pruneWallpaper;
  const nextWallpapers =
    workspace.sessionWallpapers === undefined
      ? undefined
      : pruneWallpaper === undefined
        ? workspace.sessionWallpapers
        : (Object.fromEntries(
            Object.entries(workspace.sessionWallpapers).filter(
              ([id]) => !pruneWallpaper(id as SessionId),
            ),
          ) as Record<SessionId, string>);

  return {
    projects,
    ...(activeProjectId === undefined ? {} : { activeProjectId }),
    ...keepWallpapers(nextWallpapers),
  };
};

/** Normalizes every Project, Tab, and Pane tree in `workspace`, enforcing 1-Panel-per-Pane and layout invariants. */
export const normalizeWorkspace = (
  workspace: WorkspaceState,
  validProject?: (projectId: ProjectId) => boolean,
): WorkspaceState => filterWorkspace(workspace, validProject === undefined ? {} : { validProject });

const upsertProjectTab = (
  workspace: WorkspaceState,
  projectId: ProjectId,
  tab: WorkspaceTab,
  activateProject: boolean,
  device?: DeviceId,
): WorkspaceState => {
  const existing = findProject(workspace, projectId);
  const resolvedDevice = device ?? existing?.device;
  const nextProject: ProjectWorkspace =
    existing === undefined
      ? {
          projectId,
          ...(resolvedDevice === undefined ? {} : { device: resolvedDevice }),
          tabs: [tab],
          activeTabId: tab.id,
        }
      : {
          ...existing,
          ...(resolvedDevice === undefined ? {} : { device: resolvedDevice }),
          tabs: [...existing.tabs, tab],
          activeTabId: tab.id,
        };
  const projects =
    existing === undefined
      ? [...workspace.projects, nextProject]
      : workspace.projects.map((p) => (p.projectId === projectId ? nextProject : p));
  const nextActiveProjectId = activateProject ? projectId : workspace.activeProjectId;
  return {
    projects,
    ...(nextActiveProjectId === undefined ? {} : { activeProjectId: nextActiveProjectId }),
    ...keepWallpapers(workspace.sessionWallpapers),
  };
};

const updateLayoutLeafPanels = (
  layout: PaneLayout,
  transform: (
    panels: ReadonlyArray<WorkspacePanel>,
    leafId: PaneId,
  ) => ReadonlyArray<WorkspacePanel>,
  targetPaneId?: PaneId,
): PaneLayout => ({
  ...layout,
  nodes: layout.nodes.map((node) =>
    node._tag === 'Leaf' && (targetPaneId === undefined || node.id === targetPaneId)
      ? { ...node, panels: transform(node.panels, node.id) }
      : node,
  ),
});

const updateLeafPanels = (
  tab: WorkspaceTab,
  transform: (
    panels: ReadonlyArray<WorkspacePanel>,
    leafId: PaneId,
  ) => ReadonlyArray<WorkspacePanel>,
  targetPaneId?: PaneId,
): WorkspaceTab => ({
  ...tab,
  layout: updateLayoutLeafPanels(tab.layout, transform, targetPaneId),
});

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
    readonly device?: DeviceId;
    readonly sessionId: SessionId;
    readonly createIds: () => TabIdsFactory;
    readonly activateProject?: boolean;
    readonly replacePanelId?: PanelId;
    readonly workerAncestors?: ReadonlyArray<SessionId>;
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
  const spec: PanelSpec = {
    _tag: 'Session',
    sessionId: options.sessionId,
    ...(options.workerAncestors?.length ? { workerAncestors: options.workerAncestors } : {}),
  };
  const source =
    options.replacePanelId === undefined ? undefined : findPanel(workspace, options.replacePanelId);
  if (source?.projectId === options.projectId && source.panel.spec._tag === 'Session') {
    const retained = new Set(source.panel.spec.retainedSessions);
    if (source.panel.spec.sessionId !== undefined) retained.add(source.panel.spec.sessionId);
    retained.delete(options.sessionId);
    const replacement: WorkspacePanel = {
      id: ids.panelId,
      spec: { ...spec, retainedSessions: [...retained] },
    };
    const replaced = updateTabInWorkspace(workspace, source.tab.id, (tab) =>
      updateLeafPanels(tab, (panels) =>
        panels.map((panel) => (panel.id === source.panel.id ? replacement : panel)),
      ),
    );
    const next = focusPanel(replaced, ids.panelId);
    return {
      workspace: next,
      tab: findTab(next, source.tab.id)?.tab ?? source.tab,
      tabId: source.tab.id,
      panelId: ids.panelId,
      created: true,
    };
  }
  const tab = createSinglePaneTab({ ...ids, spec });
  return {
    workspace: upsertProjectTab(workspace, options.projectId, tab, activateProject, options.device),
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
    readonly device?: DeviceId;
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
    workspace: upsertProjectTab(workspace, options.projectId, tab, true, options.device),
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
  return updateTabInWorkspace(workspace, found.tab.id, (tab) =>
    updateLeafPanels(tab, (panels) =>
      panels.map((panel) =>
        panel.id === panelId
          ? { ...panel, spec: { _tag: 'Session', sessionId, draft: true } }
          : panel,
      ),
    ),
  );
};

/** Clears a vanished Remote `sessionId` on a draft `Session` Panel so the next view starts a fresh draft. */
export const resetDraftSession = (workspace: WorkspaceState, panelId: PanelId): WorkspaceState => {
  const found = findPanel(workspace, panelId);
  if (found === undefined || found.panel.spec._tag !== 'Session') return workspace;
  if (found.panel.spec.draft !== true || found.panel.spec.sessionId === undefined) return workspace;
  return updateTabInWorkspace(workspace, found.tab.id, (tab) =>
    updateLeafPanels(tab, (panels) =>
      panels.map((panel) =>
        panel.id === panelId ? { ...panel, spec: { _tag: 'Session', draft: true } } : panel,
      ),
    ),
  );
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
  return updateTabInWorkspace(workspace, found.tab.id, (tab) =>
    updateLeafPanels(tab, (panels) =>
      panels.map((panel) =>
        panel.id === panelId ? { ...panel, spec: { _tag: 'Session', sessionId } } : panel,
      ),
    ),
  );
};

/** Activates `tabId` and its owning Project. */
export const activateTab = (workspace: WorkspaceState, tabId: TabId): WorkspaceState => {
  const found = findTab(workspace, tabId);
  if (found === undefined) return workspace;
  return {
    ...workspace,
    activeProjectId: found.projectId,
    projects: workspace.projects.map((project) =>
      project.projectId === found.projectId ? { ...project, activeTabId: tabId } : project,
    ),
  };
};

/** Focuses `panelId` inside its Tab/Project. */
export const focusPanel = (workspace: WorkspaceState, panelId: PanelId): WorkspaceState => {
  const found = findPanel(workspace, panelId);
  if (found === undefined) return workspace;
  return {
    ...workspace,
    activeProjectId: found.projectId,
    projects: workspace.projects.map((project) =>
      project.projectId === found.projectId
        ? {
            ...project,
            activeTabId: found.tab.id,
            tabs: project.tabs.map((tab) =>
              tab.id === found.tab.id ? { ...tab, focusedPanelId: panelId } : tab,
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
      ...(project.device === undefined ? {} : { device: project.device }),
      tabs: rest,
      ...(nextActiveId === undefined ? {} : { activeTabId: nextActiveId }),
    });
  }
  return {
    projects,
    ...(workspace.activeProjectId === undefined
      ? {}
      : { activeProjectId: workspace.activeProjectId }),
    ...keepWallpapers(workspace.sessionWallpapers),
  };
};

const pruneTabPanels = (
  tab: WorkspaceTab,
  shouldRemove: (panel: WorkspacePanel) => boolean,
): WorkspaceTab =>
  updateLeafPanels(tab, (panels) => panels.filter((panel) => !shouldRemove(panel)));

const prunePanelsWhere = (
  workspace: WorkspaceState,
  shouldRemove: (panel: WorkspacePanel) => boolean,
  options?: {
    readonly validProject?: (projectId: ProjectId) => boolean;
    readonly pruneWallpaper?: (sessionId: SessionId) => boolean;
  },
): WorkspaceState => {
  const pruneId = options?.pruneWallpaper;
  const updated: WorkspaceState = {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      tabs: project.tabs.map((tab) =>
        updateLeafPanels(tab, (panels) =>
          panels
            .filter((panel) => !shouldRemove(panel))
            .map((panel) => {
              if (pruneId === undefined || panel.spec._tag !== 'Session') return panel;
              const { workerAncestors, retainedSessions, ...spec } = panel.spec;
              const keep = (id: SessionId): boolean => !pruneId(id);
              const ancestors = workerAncestors?.filter(keep);
              const retained = retainedSessions?.filter(keep);
              return {
                ...panel,
                spec: {
                  ...spec,
                  ...(ancestors?.length ? { workerAncestors: ancestors } : {}),
                  ...(retained?.length ? { retainedSessions: retained } : {}),
                },
              };
            }),
        ),
      ),
    })),
  };
  return filterWorkspace(updated, options);
};

/** Closes `panelId`, collapsing empty Panes or Tabs cleanly. */
export const closePanel = (workspace: WorkspaceState, panelId: PanelId): WorkspaceState =>
  prunePanelsWhere(workspace, (panel) => panel.id === panelId);

/** Removes every Panel bound to `sessionId` and its remembered wallpaper entry. */
export const pruneSession = (workspace: WorkspaceState, sessionId: SessionId): WorkspaceState =>
  prunePanelsWhere(workspace, (panel) => panel.spec.sessionId === sessionId, {
    pruneWallpaper: (id) => id === sessionId,
  });

/** Removes every Panel matching `shouldPruneSession(sessionId)` and its remembered wallpaper entry. */
export const pruneSessions = (
  workspace: WorkspaceState,
  shouldPruneSession: (sessionId: SessionId) => boolean,
  validProject?: (projectId: ProjectId) => boolean,
): WorkspaceState =>
  prunePanelsWhere(
    workspace,
    (panel) => panel.spec.sessionId !== undefined && shouldPruneSession(panel.spec.sessionId),
    {
      ...(validProject === undefined ? {} : { validProject }),
      pruneWallpaper: shouldPruneSession,
    },
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
  return prunePanelsWhere(
    workspace,
    (panel) => {
      if (panel.spec._tag === 'Session') {
        return panel.spec.draft === true || isDraft(panel.spec.sessionId);
      }
      return draftSessionIds.has(panel.spec.sessionId) || isDraft(panel.spec.sessionId);
    },
    {
      pruneWallpaper: (id) => draftSessionIds.has(id) || isDraft(id),
    },
  );
};

const insertSplitIntoLayout = (
  layout: PaneLayout,
  targetPaneId: PaneId,
  side: SplitSide,
  ids: { readonly splitPaneId: PaneId; readonly newPaneId: PaneId },
  panel: WorkspacePanel,
): PaneLayout => {
  const direction: SplitDirection = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const before = side === 'left' || side === 'top';
  const newLeaf: LeafPaneNode = {
    _tag: 'Leaf',
    id: ids.newPaneId,
    panels: [panel],
  };
  const splitNode: SplitPaneNode = {
    _tag: 'Split',
    id: ids.splitPaneId,
    direction,
    ratio: 0.5,
    first: before ? ids.newPaneId : targetPaneId,
    second: before ? targetPaneId : ids.newPaneId,
  };
  const updatedNodes = layout.nodes.map((node) =>
    node._tag === 'Split'
      ? {
          ...node,
          first: node.first === targetPaneId ? ids.splitPaneId : node.first,
          second: node.second === targetPaneId ? ids.splitPaneId : node.second,
        }
      : node,
  );
  const rootPaneId = layout.rootPaneId === targetPaneId ? ids.splitPaneId : layout.rootPaneId;
  return {
    rootPaneId,
    nodes:
      rootPaneId === ids.splitPaneId
        ? [splitNode, ...updatedNodes, newLeaf]
        : [...updatedNodes, splitNode, newLeaf],
  };
};

/**
 * Splits `paneId` along `side`, placing a new Leaf Pane holding `spec` beside it. Enforces max-1-Panel-per-Session
 * uniqueness (focusing and expanding if `spec` references an already-open Session) and `MAX_PANES_PER_TAB = 4`.
 */
export const splitPane = (
  workspace: WorkspaceState,
  options: {
    readonly paneId: PaneId;
    readonly side: SplitSide;
    readonly spec: PanelSpec;
    readonly createIds: () => SplitIdsFactory;
  },
): {
  readonly workspace: WorkspaceState;
  readonly paneId?: PaneId;
  readonly panelId?: PanelId;
  readonly created: boolean;
} => {
  if (options.spec._tag === 'Session' && options.spec.sessionId !== undefined) {
    const existing = findSessionPanel(workspace, options.spec.sessionId);
    if (existing !== undefined) {
      return {
        workspace: focusPanel(workspace, existing.panel.id),
        paneId: existing.pane.id,
        panelId: existing.panel.id,
        created: false,
      };
    }
  }

  const found = findPane(workspace, options.paneId);
  if (found === undefined || paneCount(found.tab) >= MAX_PANES_PER_TAB) {
    return { workspace, created: false };
  }

  const ids = options.createIds();
  const nextLayout = insertSplitIntoLayout(found.tab.layout, options.paneId, options.side, ids, {
    id: ids.panelId,
    spec: options.spec,
  });

  const nextWorkspace: WorkspaceState = {
    ...workspace,
    activeProjectId: found.projectId,
    projects: workspace.projects.map((project) =>
      project.projectId === found.projectId
        ? {
            ...project,
            activeTabId: found.tab.id,
            tabs: project.tabs.map((tab) =>
              tab.id === found.tab.id
                ? { ...tab, focusedPanelId: ids.panelId, layout: nextLayout }
                : tab,
            ),
          }
        : project,
    ),
  };

  return {
    workspace: nextWorkspace,
    paneId: ids.newPaneId,
    panelId: ids.panelId,
    created: true,
  };
};

/** Returns whether moving a Panel from `sourcePaneId` onto a split edge of `targetPaneId` is valid. */
export const canSplitDrop = (
  tab: WorkspaceTab,
  sourcePaneId: PaneId,
  targetPaneId: PaneId,
): boolean => {
  const leaves = allTabLeaves(tab);
  const sourcePane = leaves.find((leaf) => leaf.id === sourcePaneId);
  const targetPane = leaves.find((leaf) => leaf.id === targetPaneId);
  return sourcePane !== undefined && targetPane !== undefined && sourcePane.id !== targetPane.id;
};

/**
 * Moves `panelId` from its source Pane into a new split on `side` of `targetPaneId` within the same Tab,
 * collapsing the empty source Pane while respecting the 4-Pane cap.
 */
export const movePanelToSplit = (
  workspace: WorkspaceState,
  options: {
    readonly panelId: PanelId;
    readonly targetPaneId: PaneId;
    readonly side: SplitSide;
    readonly createSplitIds: () => Pick<SplitIdsFactory, 'splitPaneId' | 'newPaneId'>;
  },
): WorkspaceState => {
  const source = findPanel(workspace, options.panelId);
  const target = findPane(workspace, options.targetPaneId);
  if (source === undefined || target === undefined || source.tab.id !== target.tab.id) {
    return workspace;
  }
  if (!canSplitDrop(source.tab, source.pane.id, target.pane.id)) {
    return workspace;
  }

  const pruned = pruneTabPanels(source.tab, (panel) => panel.id === options.panelId);
  const collapsedLayout = normalizeLayout(
    pruned.layout,
    source.tab.focusedPanelId,
    () => true,
    new Set(),
  );
  if (collapsedLayout === null) return workspace;

  const ids = options.createSplitIds();
  const movedPanel: WorkspacePanel = { id: source.panel.id, spec: source.panel.spec };
  const nextLayout = insertSplitIntoLayout(
    collapsedLayout,
    options.targetPaneId,
    options.side,
    ids,
    movedPanel,
  );

  return updateTabInWorkspace(workspace, source.tab.id, (tab) => ({
    ...tab,
    focusedPanelId: options.panelId,
    layout: nextLayout,
  }));
};

/** Swaps the Panels between `panelId`'s Pane and `targetPaneId` within the same Tab, focusing `panelId`. */
export const swapPanelToPane = (
  workspace: WorkspaceState,
  options: {
    readonly panelId: PanelId;
    readonly targetPaneId: PaneId;
  },
): WorkspaceState => {
  const source = findPanel(workspace, options.panelId);
  const target = findPane(workspace, options.targetPaneId);
  if (
    source === undefined ||
    target === undefined ||
    source.tab.id !== target.tab.id ||
    source.pane.id === target.pane.id
  ) {
    return workspace;
  }
  const sourcePanels = source.pane.panels;
  const targetPanels = target.pane.panels;
  return updateTabInWorkspace(workspace, source.tab.id, (tab) => ({
    ...tab,
    focusedPanelId: options.panelId,
    layout: {
      ...tab.layout,
      nodes: tab.layout.nodes.map((node) => {
        if (node._tag !== 'Leaf') return node;
        if (node.id === source.pane.id) return { ...node, panels: targetPanels };
        if (node.id === target.pane.id) return { ...node, panels: sourcePanels };
        return node;
      }),
    },
  }));
};

/** Swaps the Panels of two Panes within a Tab. */
export const swapPanePanels = (
  workspace: WorkspaceState,
  firstPaneId: PaneId,
  secondPaneId: PaneId,
): WorkspaceState => {
  const first = findPane(workspace, firstPaneId);
  if (first === undefined) return workspace;
  const panel = first.pane.panels[0];
  if (panel === undefined) return workspace;
  return swapPanelToPane(workspace, { panelId: panel.id, targetPaneId: secondPaneId });
};

/** Reorders `fromTabId` to `toTabId`'s position within `projectId`'s Tab strip without mutating `activeTabId`. */
export const reorderTabs = (
  workspace: WorkspaceState,
  projectId: ProjectId,
  fromTabId: TabId,
  toTabId: TabId,
): WorkspaceState => {
  if (fromTabId === toTabId) return workspace;
  const project = findProject(workspace, projectId);
  if (project === undefined) return workspace;
  const fromIndex = project.tabs.findIndex((tab) => tab.id === fromTabId);
  const toIndex = project.tabs.findIndex((tab) => tab.id === toTabId);
  if (fromIndex === -1 || toIndex === -1) return workspace;

  const moved = project.tabs[fromIndex];
  if (moved === undefined) return workspace;
  const remaining = project.tabs.filter((tab) => tab.id !== fromTabId);
  const nextTabs = [...remaining.slice(0, toIndex), moved, ...remaining.slice(toIndex)];

  return {
    ...workspace,
    projects: workspace.projects.map((candidate) =>
      candidate.projectId === projectId ? { ...candidate, tabs: nextTabs } : candidate,
    ),
  };
};

/** Updates `splitPaneId`'s ratio in `tabId`, clamped to `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]`. */
export const setSplitRatio = (
  workspace: WorkspaceState,
  tabId: TabId,
  splitPaneId: PaneId,
  ratio: number,
): WorkspaceState => {
  const found = findTab(workspace, tabId);
  if (found === undefined) return workspace;
  const clamped = clampRatio(ratio);
  const target = found.tab.layout.nodes.find(
    (node): node is SplitPaneNode => node._tag === 'Split' && node.id === splitPaneId,
  );
  if (target === undefined || target.ratio === clamped) return workspace;
  return updateTabInWorkspace(workspace, tabId, (tab) => ({
    ...tab,
    layout: {
      ...tab.layout,
      nodes: tab.layout.nodes.map((node) =>
        node._tag === 'Split' && node.id === splitPaneId ? { ...node, ratio: clamped } : node,
      ),
    },
  }));
};

/**
 * Opens `sessionId` in a split of `projectId`'s active Tab (defaulting to `'right'` of its focused Pane).
 * Enforces max-1-Panel-per-Session uniqueness (focusing and expanding if already open anywhere) and
 * `MAX_PANES_PER_TAB = 4` (returning `capped: true` without mutating when full). Opens a new single-Pane
 * Tab if `projectId` currently has no Tabs.
 */
export const openSessionInSplit = (
  workspace: WorkspaceState,
  options: {
    readonly projectId: ProjectId;
    readonly sessionId: SessionId;
    readonly side?: SplitSide;
    readonly createTabIds: () => TabIdsFactory;
    readonly createSplitIds: () => SplitIdsFactory;
  },
): {
  readonly workspace: WorkspaceState;
  readonly tab?: WorkspaceTab;
  readonly tabId?: TabId;
  readonly panelId?: PanelId;
  readonly created: boolean;
  readonly capped: boolean;
} => {
  const existing = findSessionPanel(workspace, options.sessionId);
  if (existing !== undefined) {
    const next = focusPanel(workspace, existing.panel.id);
    const updatedTab = findTab(next, existing.tab.id)?.tab ?? existing.tab;
    return {
      workspace: next,
      tab: updatedTab,
      tabId: existing.tab.id,
      panelId: existing.panel.id,
      created: false,
      capped: false,
    };
  }

  const activeTab = activeTabOf(workspace, options.projectId);
  if (activeTab === undefined) {
    const opened = openSessionTab(workspace, {
      projectId: options.projectId,
      sessionId: options.sessionId,
      createIds: options.createTabIds,
    });
    return { ...opened, capped: false };
  }

  if (paneCount(activeTab) >= MAX_PANES_PER_TAB) {
    return { workspace, created: false, capped: true };
  }

  const leaves = allTabLeaves(activeTab);
  const focused = focusedPanelOf(activeTab);
  const targetPane =
    (focused === undefined
      ? undefined
      : leaves.find((leaf) => leaf.panels.some((panel) => panel.id === focused.id))) ?? leaves[0];
  if (targetPane === undefined) {
    return { workspace, created: false, capped: false };
  }

  const split = splitPane(workspace, {
    paneId: targetPane.id,
    side: options.side ?? 'right',
    spec: { _tag: 'Session', sessionId: options.sessionId },
    createIds: options.createSplitIds,
  });
  const updatedTab = findTab(split.workspace, activeTab.id)?.tab;
  return {
    workspace: split.workspace,
    ...(updatedTab === undefined ? {} : { tab: updatedTab }),
    tabId: activeTab.id,
    ...(split.panelId === undefined ? {} : { panelId: split.panelId }),
    created: split.created,
    capped: !split.created,
  };
};

/** Removes `projectId` from `workspace`, clearing or falling back `activeProjectId` if needed. */
export const pruneProject = (workspace: WorkspaceState, projectId: ProjectId): WorkspaceState =>
  filterWorkspace(workspace, { validProject: (id) => id !== projectId });

/** Records `wallpaperId` for `sessionId` in `workspace.sessionWallpapers`. */
export const setSessionWallpaperInWorkspace = (
  workspace: WorkspaceState,
  sessionId: SessionId,
  wallpaperId: string,
): WorkspaceState => {
  if (workspace.sessionWallpapers?.[sessionId] === wallpaperId) return workspace;
  return {
    ...workspace,
    sessionWallpapers: {
      ...(workspace.sessionWallpapers ?? {}),
      [sessionId]: wallpaperId,
    },
  };
};
