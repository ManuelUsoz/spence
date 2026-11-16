import { Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcTest, type Rpc, type RpcGroup } from 'effect/rpc';
import { AgentsRpcs } from '../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../shared/app-info/app-info.rpc';
import { FilesRpcs } from '../../shared/files/files.rpc';
import { HistoryRpcs } from '../../shared/history/history.rpc';
import { ProjectsRpcs } from '../../shared/projects/projects.rpc';
import { DesktopRpcs } from '../../shared/rpc/desktop-rpcs';
import { SessionsRpcs } from '../../shared/sessions/sessions.rpc';
import { SettingsRpcs } from '../../shared/settings/settings.rpc';
import { SourceControlRpcs } from '../../shared/source-control/source-control.rpc';
import { TabsRpcs } from '../../shared/tabs/tabs.rpc';
import { WorktreesRpcs } from '../../shared/worktrees/worktrees.rpc';
import { layerClientProtocol } from '../../shared/rpc/message-port-protocol';
import { DesktopApi } from './desktop-api';
import type { DesktopBridgeError } from './desktop-error';
import { acquireDesktopPort } from './desktop-port';

/** Production implementation: an RPC client over a fresh port, closed with the scope. */
export const layerDesktop: Layer.Layer<DesktopApi, DesktopBridgeError> = Layer.unwrap(
  Effect.map(acquireDesktopPort, (port) =>
    Layer.effect(DesktopApi, RpcClient.make(DesktopRpcs)).pipe(
      Layer.provide(layerClientProtocol(port)),
    ),
  ),
);

/** AppInfo handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerAppInfoUnused = AppInfoRpcs.toLayer({
  'AppInfo.get': () => Effect.die('AppInfo.get is not served in this test'),
});

/** Agents handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerAgentsUnused = AgentsRpcs.toLayer({
  'Agents.list': () => Effect.die('Agents.list is not served in this test'),
  'Agents.installCommand': () => Effect.die('Agents.installCommand is not served in this test'),
  'Agents.install': () => Stream.die('Agents.install is not served in this test'),
  'Agents.openInstallLog': () => Effect.die('Agents.openInstallLog is not served in this test'),
});

/** Projects handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerProjectsUnused = ProjectsRpcs.toLayer({
  'Projects.list': () => Effect.die('Projects.list is not served in this test'),
  'Projects.add': () => Effect.die('Projects.add is not served in this test'),
  'Projects.rename': () => Effect.die('Projects.rename is not served in this test'),
  'Projects.remove': () => Effect.die('Projects.remove is not served in this test'),
  'Projects.locate': () => Effect.die('Projects.locate is not served in this test'),
  'Projects.check': () => Effect.die('Projects.check is not served in this test'),
  'Projects.setSettings': () => Effect.die('Projects.setSettings is not served in this test'),
});

/** Sessions handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerSessionsUnused = SessionsRpcs.toLayer({
  'Session.list': () => Effect.die('Session.list is not served in this test'),
  'Session.changes': () => Stream.die('Session.changes is not served in this test'),
  'Session.create': () => Effect.die('Session.create is not served in this test'),
  'Session.setAgent': () => Effect.die('Session.setAgent is not served in this test'),
  'Session.prompt': () => Effect.die('Session.prompt is not served in this test'),
  'Session.openAgentLog': () => Effect.void,
  'Session.retryAgent': () => Effect.void,
  'Session.loginAgent': () => Effect.void,
  'Session.cancel': () => Effect.die('Session.cancel is not served in this test'),
  'Session.stopAgent': () => Effect.die('Session.stopAgent is not served in this test'),
  'Session.rename': () => Effect.die('Session.rename is not served in this test'),
  'Session.setOption': () => Effect.die('Session.setOption is not served in this test'),
  'Session.clearContext': () => Effect.die('Session.clearContext is not served in this test'),
  'Session.compact': () => Effect.die('Session.compact is not served in this test'),
  'Session.startEmptyContext': () =>
    Effect.die('Session.startEmptyContext is not served in this test'),
  'Session.archive': () => Effect.die('Session.archive is not served in this test'),
  'Session.unarchive': () => Effect.die('Session.unarchive is not served in this test'),
  'Session.delete': () => Effect.die('Session.delete is not served in this test'),
  'Session.answerPermission': () =>
    Effect.die('Session.answerPermission is not served in this test'),
  'Session.events': () => Stream.die('Session.events is not served in this test'),
  'Session.getComposer': () => Effect.die('Session.getComposer is not served in this test'),
  'Session.setComposer': () => Effect.die('Session.setComposer is not served in this test'),
  'Session.prepareHandoff': () => Effect.die('Session.prepareHandoff is not served in this test'),
  'Session.revalidateHandoff': () =>
    Effect.die('Session.revalidateHandoff is not served in this test'),
  'Session.executeHandoff': () => Effect.die('Session.executeHandoff is not served in this test'),
  'Session.selectDraftWorktree': () =>
    Effect.die('Session.selectDraftWorktree is not served in this test'),
  'Session.locateWorktree': () => Effect.die('Session.locateWorktree is not served in this test'),
  'Session.listHandoffAttempts': () =>
    Effect.die('Session.listHandoffAttempts is not served in this test'),
});

/** Settings handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerSettingsUnused = SettingsRpcs.toLayer({
  'Settings.get': () => Effect.die('Settings.get is not served in this test'),
  'Settings.update': () => Effect.die('Settings.update is not served in this test'),
});

/** Tabs handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerTabsUnused = TabsRpcs.toLayer({
  'Tabs.restore': () => Effect.die('Tabs.restore is not served in this test'),
  'Tabs.update': () => Effect.die('Tabs.update is not served in this test'),
  'Tabs.activations': () => Stream.die('Tabs.activations is not served in this test'),
});

/** Every domain's `layerXUnused`; the handlers a test passes replace the ones it exercises. */
const layerFilesUnused = FilesRpcs.toLayer({
  'Files.listDir': () => Effect.die('unused RPC: Files.listDir'),
  'Files.readPreview': () => Effect.die('unused RPC: Files.readPreview'),
  'Files.openExternal': () => Effect.die('unused RPC: Files.openExternal'),
  'Files.watch': () => Stream.never,
});
const layerHistoryUnused = HistoryRpcs.toLayer({
  'History.list': () => Effect.die('unused RPC: History.list'),
});
const layerSourceControlUnused = SourceControlRpcs.toLayer({
  'SourceControl.status': () => Effect.die('unused RPC: SourceControl.status'),
  'SourceControl.diff': () => Effect.die('unused RPC: SourceControl.diff'),
  'SourceControl.commits': () => Effect.die('unused RPC: SourceControl.commits'),
  'SourceControl.commitDetail': () => Effect.die('unused RPC: SourceControl.commitDetail'),
  'SourceControl.commitFileDiff': () => Effect.die('unused RPC: SourceControl.commitFileDiff'),
  'SourceControl.listOperations': () => Effect.die('unused RPC: SourceControl.listOperations'),
  'SourceControl.getOperation': () => Effect.die('unused RPC: SourceControl.getOperation'),
  'SourceControl.operationEvents': () => Stream.die('unused RPC: SourceControl.operationEvents'),
  'SourceControl.reconcileOperation': () =>
    Effect.die('unused RPC: SourceControl.reconcileOperation'),
  'SourceControl.dismissOperation': () => Effect.die('unused RPC: SourceControl.dismissOperation'),
  'SourceControl.cancelOperation': () => Effect.die('unused RPC: SourceControl.cancelOperation'),
});
const layerWorktreesUnused = WorktreesRpcs.toLayer({
  'Worktrees.inventory': () => Effect.die('unused RPC: Worktrees.inventory'),
  'Worktrees.refresh': () => Effect.die('unused RPC: Worktrees.refresh'),
  'Worktrees.prepareCreate': () => Effect.die('unused RPC: Worktrees.prepareCreate'),
  'Worktrees.revalidateCreate': () => Effect.die('unused RPC: Worktrees.revalidateCreate'),
  'Worktrees.executeCreate': () => Effect.die('unused RPC: Worktrees.executeCreate'),
  'Worktrees.pickDestination': () => Effect.die('unused RPC: Worktrees.pickDestination'),
  'Worktrees.locate': () => Effect.die('unused RPC: Worktrees.locate'),
});

const layerUnusedHandlers = Layer.mergeAll(
  layerAppInfoUnused,
  layerAgentsUnused,
  layerFilesUnused,
  layerHistoryUnused,
  layerProjectsUnused,
  layerSessionsUnused,
  layerSettingsUnused,
  layerSourceControlUnused,
  layerTabsUnused,
  layerWorktreesUnused,
);

type DesktopHandler = Rpc.ToHandler<RpcGroup.Rpcs<typeof DesktopRpcs>>;

/**
 * Test implementation: the real client served in-memory by the given handlers,
 * so tests exercise the same contract as production. Give only the domains under test;
 * the others die if called.
 */
export const makeDesktopTestLayer = <Handlers extends DesktopHandler>(
  handlers: Layer.Layer<Handlers>,
): Layer.Layer<DesktopApi> =>
  Layer.effect(DesktopApi, RpcTest.makeClient(DesktopRpcs)).pipe(
    Layer.provide(Layer.mergeAll(layerUnusedHandlers, handlers)),
  );
