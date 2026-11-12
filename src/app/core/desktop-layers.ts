import { Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcTest, type Rpc, type RpcGroup } from 'effect/rpc';
import { AgentsRpcs } from '../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../shared/app-info/app-info.rpc';
import { ProjectsRpcs } from '../../shared/projects/projects.rpc';
import { DesktopRpcs } from '../../shared/rpc/desktop-rpcs';
import { SessionsRpcs } from '../../shared/sessions/sessions.rpc';
import { SettingsRpcs } from '../../shared/settings/settings.rpc';
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
  'Projects.check': () => Effect.die('Projects.check is not served in this test'),
  'Projects.setSettings': () => Effect.die('Projects.setSettings is not served in this test'),
});

/** Sessions handlers that die: lets tests of other domains build `DesktopRpcs`. */
export const layerSessionsUnused = SessionsRpcs.toLayer({
  'Session.list': () => Effect.die('Session.list is not served in this test'),
  'Session.create': () => Effect.die('Session.create is not served in this test'),
  'Session.prompt': () => Effect.die('Session.prompt is not served in this test'),
  'Session.cancel': () => Effect.die('Session.cancel is not served in this test'),
  'Session.setOption': () => Effect.die('Session.setOption is not served in this test'),
  'Session.clearContext': () => Effect.die('Session.clearContext is not served in this test'),
  'Session.answerPermission': () =>
    Effect.die('Session.answerPermission is not served in this test'),
  'Session.events': () => Stream.die('Session.events is not served in this test'),
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
});

/** Every domain's `layerXUnused`; the handlers a test passes replace the ones it exercises. */
const layerUnusedHandlers = Layer.mergeAll(
  layerAppInfoUnused,
  layerAgentsUnused,
  layerProjectsUnused,
  layerSessionsUnused,
  layerSettingsUnused,
  layerTabsUnused,
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
