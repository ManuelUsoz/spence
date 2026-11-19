import { Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcTest, type Rpc, type RpcGroup } from 'effect/rpc';
import { AgentsRpcs } from '../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../shared/app-info/app-info.rpc';
import { AssetsRpcs } from '../../shared/assets/assets.rpc';
import { DevicesRpcs } from '../../shared/devices/devices.rpc';
import { MessagingRpcs } from '../../shared/messaging/messaging.rpc';
import { RemoteInfoRpcs } from '../../shared/remote/remote.rpc';
import { LinksRpcs } from '../../shared/links/links.rpc';
import { ProjectsRpcs } from '../../shared/projects/projects.rpc';
import { DesktopRpcs } from '../../shared/rpc/desktop-rpcs';
import { SessionsRpcs } from '../../shared/sessions/sessions.rpc';
import { ExecutionSettingsRpcs, SettingsRpcs } from '../../shared/settings/settings.rpc';
import { SourceControlRpcs } from '../../shared/source-control/source-control.rpc';
import { WorktreesRpcs } from '../../shared/worktrees/worktrees.rpc';
import { FilesRpcs } from '../../shared/files/files.rpc';
import { FoldersRpcs } from '../../shared/folders/folders.rpc';
import { TabsRpcs } from '../../shared/tabs/tabs.rpc';
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
  'Projects.addFolder': () => Effect.die('Projects.addFolder is not served in this test'),
  'Projects.locateFolder': () => Effect.die('Projects.locateFolder is not served in this test'),
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
  'Session.steer': () => Effect.die('Session.steer is not served in this test'),
  'Session.enqueue': () => Effect.die('Session.enqueue is not served in this test'),
  'Session.setQueue': () => Effect.die('Session.setQueue is not served in this test'),
  'Session.clearQueue': () => Effect.die('Session.clearQueue is not served in this test'),
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
  'Session.countWorkers': () => Effect.die('Session.countWorkers is not served in this test'),
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
  'Session.listHandoffAttempts': () =>
    Effect.die('Session.listHandoffAttempts is not served in this test'),
});

/** Links handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerLinksUnused = LinksRpcs.toLayer({
  'Links.openExternal': () => Effect.die('Links.openExternal is not served in this test'),
});

/** Settings handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerSettingsUnused = SettingsRpcs.toLayer({
  'Settings.get': () => Effect.die('Settings.get is not served in this test'),
  'Settings.update': () => Effect.die('Settings.update is not served in this test'),
});

/** Execution Settings handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerExecutionSettingsUnused = ExecutionSettingsRpcs.toLayer({
  'ExecutionSettings.get': () => Effect.die('ExecutionSettings.get is not served in this test'),
  'ExecutionSettings.update': () =>
    Effect.die('ExecutionSettings.update is not served in this test'),
});

/** Folders handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerFoldersUnused = FoldersRpcs.toLayer({
  'Folders.browse': () => Effect.die('Folders.browse is not served in this test'),
});

/** Tabs handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerTabsUnused = TabsRpcs.toLayer({
  'Tabs.restore': () => Effect.die('Tabs.restore is not served in this test'),
  'Tabs.update': () => Effect.die('Tabs.update is not served in this test'),
  'Tabs.activations': () => Stream.die('Tabs.activations is not served in this test'),
});

/** SourceControl handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerSourceControlUnused = SourceControlRpcs.toLayer({
  // Every Session view reads the changes for its composer, so this answers 'not a Git folder' instead of dying.
  'SourceControl.changes': () =>
    Effect.succeed({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not served in this test' }),
  'SourceControl.diff': () => Effect.die('SourceControl.diff is not served in this test'),
  'SourceControl.commits': () => Effect.die('SourceControl.commits is not served in this test'),
  'SourceControl.commit': () => Effect.die('SourceControl.commit is not served in this test'),
  'SourceControl.prepareDiscard': () =>
    Effect.die('SourceControl.prepareDiscard is not served in this test'),
  'SourceControl.discard': () => Effect.die('SourceControl.discard is not served in this test'),
  'SourceControl.revert': () => Effect.die('SourceControl.revert is not served in this test'),
  'SourceControl.branches': () => Effect.die('SourceControl.branches is not served in this test'),
  'SourceControl.fetch': () => Effect.die('SourceControl.fetch is not served in this test'),
  'SourceControl.pull': () => Effect.die('SourceControl.pull is not served in this test'),
  'SourceControl.push': () => Effect.die('SourceControl.push is not served in this test'),
});

/** Worktrees handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerWorktreesUnused = WorktreesRpcs.toLayer({
  // Every Session view asks for its worktrees, so this answers 'not a Git folder' instead of dying.
  'Worktrees.list': () =>
    Effect.succeed({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not served in this test' }),
  'Worktrees.prepareDraft': () => Effect.die('Worktrees.prepareDraft is not served in this test'),
});

/** Files handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerFilesUnused = FilesRpcs.toLayer({
  'Files.list': () => Effect.die('Files.list is not served in this test'),
  'Files.read': () => Effect.die('Files.read is not served in this test'),
});

/** Devices handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerDevicesUnused = DevicesRpcs.toLayer({
  'Devices.local': () => Effect.die('Devices.local is not served in this test'),
  'Devices.rename': () => Effect.die('Devices.rename is not served in this test'),
  'Devices.setHosting': () => Effect.die('Devices.setHosting is not served in this test'),
  'Devices.watch': () => Stream.die('Devices.watch is not served in this test'),
  'Devices.nearby': () => Stream.die('Devices.nearby is not served in this test'),
  'Devices.startPairing': () => Effect.die('Devices.startPairing is not served in this test'),
  'Devices.cancelPairing': () => Effect.die('Devices.cancelPairing is not served in this test'),
  'Devices.pair': () => Effect.die('Devices.pair is not served in this test'),
  'Devices.check': () => Effect.die('Devices.check is not served in this test'),
  // The window follows its Paired devices from the start, so this answers 'none' instead of dying.
  'Devices.connections': () => Stream.concat(Stream.make([]), Stream.never),
  'Devices.connect': () => Effect.die('Devices.connect is not served in this test'),
  'Devices.unpair': () => Effect.die('Devices.unpair is not served in this test'),
  'Devices.setAllowAgents': () => Effect.die('Devices.setAllowAgents is not served in this test'),
});

/** Remote handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerRemoteUnused = RemoteInfoRpcs.toLayer({
  'Remote.hello': () => Effect.die('Remote.hello is not served in this test'),
});

/** Assets handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerAssetsUnused = AssetsRpcs.toLayer({
  'Assets.read': () => Effect.die('Assets.read is not served in this test'),
});

/** Messaging handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerMessagingUnused = MessagingRpcs.toLayer({
  'Messaging.send': () => Effect.die('Messaging.send is not served in this test'),
  'Messaging.startSession': () => Effect.die('Messaging.startSession is not served in this test'),
});

/** Every domain's `layerXUnused`; the handlers a test passes replace the ones it exercises. */
const layerUnusedHandlers = Layer.mergeAll(
  layerAppInfoUnused,
  layerAgentsUnused,
  layerProjectsUnused,
  layerSessionsUnused,
  layerSettingsUnused,
  layerExecutionSettingsUnused,
  layerFoldersUnused,
  layerLinksUnused,
  layerTabsUnused,
  layerSourceControlUnused,
  layerWorktreesUnused,
  layerFilesUnused,
  layerDevicesUnused,
  layerRemoteUnused,
  layerAssetsUnused,
  layerMessagingUnused,
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
