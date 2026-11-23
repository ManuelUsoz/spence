import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { DeviceId } from '../devices/devices.rpc';
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
    // Parent Sessions displaced by in-place Worker navigation, nearest parent last.
    workerAncestors: Schema.optionalKey(Schema.Array(SessionId)),
    // Conversations kept open in the background while navigating this Pane.
    retainedSessions: Schema.optionalKey(Schema.Array(SessionId)),
  }),
  Schema.TaggedStruct('Changes', { sessionId: SessionId }),
  Schema.TaggedStruct('Workers', { sessionId: SessionId }),
]).annotate({ identifier: 'PanelSpec' });
export type PanelSpec = typeof PanelSpec.Type;

export const WorkspacePanel = Schema.Struct({
  id: PanelId,
  spec: PanelSpec,
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
  /** The Remote device the Project lives on; absent for a Local Project. */
  device: Schema.optionalKey(DeviceId),
  tabs: Schema.Array(WorkspaceTab),
  activeTabId: Schema.optionalKey(TabId),
}).annotate({ identifier: 'ProjectWorkspace' });
export type ProjectWorkspace = typeof ProjectWorkspace.Type;

export const WorkspaceState = Schema.Struct({
  projects: Schema.Array(ProjectWorkspace),
  activeProjectId: Schema.optionalKey(ProjectId),
  sessionWallpapers: Schema.optionalKey(Schema.Record(SessionId, Schema.String)),
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
  background: Schema.optionalKey(Schema.Boolean),
  /** The Remote device the Session runs on; absent for a Local Session. */
  device: Schema.optionalKey(DeviceId),
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
  /**
   * Syncs the full per-Project workspace layout (including drafts in memory) on every change. Remote Projects'
   * workspaces and cached Session summaries are remembered separately on the viewer, never passed to local `Sessions`.
   */
  Rpc.make('Tabs.update', {
    payload: {
      workspace: WorkspaceState,
      remoteSessions: Schema.optionalKey(Schema.Array(RestoredSessionInfo)),
    },
  }),
  /** Streams Tab activation requests from main (e.g. OS notification clicks). */
  Rpc.make('Tabs.activations', { success: TabActivation, stream: true }),
);
