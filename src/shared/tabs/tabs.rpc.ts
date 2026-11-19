import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId } from '../projects/projects.rpc';
import { Attention, SessionId, SessionTitle } from '../sessions/sessions.rpc';

export const TabId = Schema.String.pipe(Schema.brand('TabId')).annotate({ identifier: 'TabId' });
export type TabId = typeof TabId.Type;

export const PaneId = Schema.String.pipe(Schema.brand('PaneId')).annotate({ identifier: 'PaneId' });
export type PaneId = typeof PaneId.Type;

export const PanelId = Schema.String.pipe(Schema.brand('PanelId')).annotate({
  identifier: 'PanelId',
});
export type PanelId = typeof PanelId.Type;

export const SplitDirection = Schema.Literals(['horizontal', 'vertical']).annotate({
  identifier: 'SplitDirection',
});
export type SplitDirection = typeof SplitDirection.Type;

export const PanelSpec = Schema.Union([
  Schema.TaggedStruct('Session', {
    sessionId: Schema.optionalKey(SessionId),
    draft: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct('Changes', { sessionId: SessionId }),
  Schema.TaggedStruct('Workers', { sessionId: SessionId }),
]).annotate({ identifier: 'PanelSpec' });
export type PanelSpec = typeof PanelSpec.Type;

export const WorkspacePanel = Schema.Struct({
  id: PanelId,
  spec: PanelSpec,
  collapsed: Schema.Boolean,
  heightShare: Schema.Number,
}).annotate({ identifier: 'WorkspacePanel' });
export type WorkspacePanel = typeof WorkspacePanel.Type;

export const LeafPaneNode = Schema.TaggedStruct('Leaf', {
  id: PaneId,
  panels: Schema.Array(WorkspacePanel),
}).annotate({ identifier: 'LeafPaneNode' });
export type LeafPaneNode = typeof LeafPaneNode.Type;

export const SplitPaneNode = Schema.TaggedStruct('Split', {
  id: PaneId,
  direction: SplitDirection,
  ratio: Schema.Number,
  first: PaneId,
  second: PaneId,
}).annotate({ identifier: 'SplitPaneNode' });
export type SplitPaneNode = typeof SplitPaneNode.Type;

export const PaneNode = Schema.Union([LeafPaneNode, SplitPaneNode]).annotate({
  identifier: 'PaneNode',
});
export type PaneNode = typeof PaneNode.Type;

export const PaneLayout = Schema.Struct({
  rootPaneId: PaneId,
  nodes: Schema.Array(PaneNode),
}).annotate({ identifier: 'PaneLayout' });
export type PaneLayout = typeof PaneLayout.Type;

export const WorkspaceTab = Schema.Struct({
  id: TabId,
  customTitle: Schema.optionalKey(Schema.String),
  layout: PaneLayout,
  focusedPanelId: PanelId,
}).annotate({ identifier: 'WorkspaceTab' });
export type WorkspaceTab = typeof WorkspaceTab.Type;

export const ProjectWorkspace = Schema.Struct({
  projectId: ProjectId,
  tabs: Schema.Array(WorkspaceTab),
  activeTabId: Schema.optionalKey(TabId),
}).annotate({ identifier: 'ProjectWorkspace' });
export type ProjectWorkspace = typeof ProjectWorkspace.Type;

export const WorkspaceState = Schema.Struct({
  projects: Schema.Array(ProjectWorkspace),
  activeProjectId: Schema.optionalKey(ProjectId),
}).annotate({ identifier: 'WorkspaceState' });
export type WorkspaceState = typeof WorkspaceState.Type;

/** Summary metadata for a Session restored in `WorkspaceState`, before `Session.changes` arrives. */
export const RestoredSessionInfo = Schema.Struct({
  id: SessionId,
  projectId: ProjectId,
  title: SessionTitle,
  attention: Schema.optionalKey(Attention),
  running: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'RestoredSessionInfo' });
export type RestoredSessionInfo = typeof RestoredSessionInfo.Type;

export const RestoredWorkspace = Schema.Struct({
  workspace: WorkspaceState,
  sessions: Schema.Array(RestoredSessionInfo),
}).annotate({ identifier: 'RestoredWorkspace' });
export type RestoredWorkspace = typeof RestoredWorkspace.Type;

/** A request from main to open or activate a Session's Tab (e.g. from clicking an OS notification). */
export const TabActivation = Schema.Struct({
  sessionId: SessionId,
  projectId: ProjectId,
  title: SessionTitle,
}).annotate({ identifier: 'TabActivation' });
export type TabActivation = typeof TabActivation.Type;

/**
 * The window's workspace Tabs and Pane layouts as main sees them. Main tracks which Sessions are open or currently
 * visible (to manage Agent lifetimes) and persists non-draft layouts across launches.
 */
export const TabsRpcs = RpcGroup.make(
  /** Restores the persisted per-Project Tab workspace and Session summaries at launch or reload. */
  Rpc.make('Tabs.restore', { success: RestoredWorkspace }),
  /** Syncs the full per-Project workspace layout (including drafts in memory) on every change. */
  Rpc.make('Tabs.update', { payload: { workspace: WorkspaceState } }),
  /** Streams Tab activation requests from main (e.g. OS notification clicks). */
  Rpc.make('Tabs.activations', { success: TabActivation, stream: true }),
);
