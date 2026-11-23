import { Effect, Layer, Stream } from 'effect';
import {
  TabsRpcs,
  type RestoredSessionInfo,
  type RestoredWorkspace,
  type WorkspaceState,
} from '../../src/shared/tabs/tabs.rpc';
import {
  allReferencedSessionIds,
  allWorkspaceSessionIds,
  stripDrafts,
} from '../../src/shared/tabs/workspace-layout';
import { layerSessionStoreLive } from '../sessions/session-store';
import { Sessions } from '../sessions/sessions';
import { layerTabActivations, TabActivations } from '../sessions/tab-activations';
import { Remembered } from '../settings/remembered';
import { layerSettingsMain } from '../settings/window';
import { layerSessionsLive } from './sessions';

const splitWorkspace = (
  workspace: WorkspaceState,
  remoteSessions: ReadonlyArray<RestoredSessionInfo>,
): { readonly local: WorkspaceState; readonly remote: RestoredWorkspace } => {
  const localProjects = workspace.projects.filter((project) => project.device === undefined);
  const remoteProjects = workspace.projects.filter((project) => project.device !== undefined);
  const activeIsRemote = remoteProjects.some(
    (project) => project.projectId === workspace.activeProjectId,
  );
  const localActive =
    !activeIsRemote && workspace.activeProjectId !== undefined
      ? workspace.activeProjectId
      : localProjects[0]?.projectId;
  const remoteActive = activeIsRemote ? workspace.activeProjectId : undefined;
  const remoteClean = stripDrafts(
    {
      projects: remoteProjects,
      ...(remoteActive === undefined ? {} : { activeProjectId: remoteActive }),
    },
    () => true,
  );
  const remoteIds = allWorkspaceSessionIds(remoteClean);
  return {
    local: {
      projects: localProjects,
      ...(localActive === undefined ? {} : { activeProjectId: localActive }),
      ...(workspace.sessionWallpapers === undefined
        ? {}
        : { sessionWallpapers: workspace.sessionWallpapers }),
    },
    remote: {
      workspace: remoteClean,
      sessions: remoteSessions.filter((info) => remoteIds.has(info.id)),
    },
  };
};

/** The Tabs to open at launch: Local ones from Sessions, Remote ones from their remembered workspaces. */
const restoreTabs = Effect.fnUntraced(function* () {
  const local = yield* Sessions.use((sessions) => sessions.restoreTabs);
  const remote = yield* Remembered.use((remembered) => remembered.remoteWorkspace);
  if (remote.workspace.projects.length === 0) return local;
  const projects = [...local.workspace.projects, ...remote.workspace.projects];
  const activeProjectId =
    remote.workspace.activeProjectId ?? local.workspace.activeProjectId ?? projects[0]?.projectId;
  const knownIds = new Set(local.sessions.map((info) => info.id));
  const remoteReferenced = allReferencedSessionIds(remote.workspace);
  const sessions = [
    ...local.sessions,
    ...remote.sessions.filter((info) => remoteReferenced.has(info.id) && !knownIds.has(info.id)),
  ];
  return {
    workspace: {
      ...local.workspace,
      projects,
      ...(activeProjectId === undefined ? {} : { activeProjectId }),
    },
    sessions,
  } satisfies RestoredWorkspace;
});

export const layerTabsHandlers = TabsRpcs.toLayer({
  'Tabs.restore': () => restoreTabs(),
  'Tabs.update': ({ workspace, remoteSessions }) => {
    const { local, remote } = splitWorkspace(workspace, remoteSessions ?? []);
    return Effect.andThen(
      Sessions.use((sessions) => sessions.setTabs(local)),
      Remembered.use((remembered) => remembered.rememberRemoteWorkspace(remote)),
    );
  },
  'Tabs.activations': () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const activations = yield* TabActivations;
        const sessions = yield* Sessions;
        return Stream.merge(activations.stream, sessions.backgroundTabs);
      }),
    ),
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      layerSessionsLive,
      layerSessionStoreLive,
      layerTabActivations,
      layerSettingsMain,
    ),
  ),
);
