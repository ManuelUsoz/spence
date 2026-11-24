import { Layer, ManagedRuntime } from 'effect';
import { RpcServer } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerBrowserMain } from '../browser/browser-main';
import { layerDeviceIdentityLive } from '../devices/identity';
import { layerDevices } from '../devices/layer';
import { layerSecretStorageLive } from '../devices/secret-storage-electron';
import { layerKeepAwake, layerPowerBlockerLive } from '../hosting/keep-awake';
import { layerLanConfigLive } from '../lan/config';
import { attachAgentTools } from '../messaging/agent-tools';
import { layerMdnsLive } from '../lan/mdns-bonjour';
import { layerPowerEventsLive } from '../lan/power';
import { layerRemoteNotifier } from '../lan/remote-notifier';
import { layerStoreUserData } from '../store/store';
import { layerAutoArchiveLive } from '../sessions/auto-archive';
import { layerInAppNotificationChannelLive } from '../sessions/in-app-notifications';
import { layerNotificationDispatcherLive } from '../sessions/notifier';
import { layerNotifierLive } from '../sessions/os-notifier';
import { layerWindowFocus } from '../sessions/window-focus';
import { layerSettingsMain } from '../settings/window';
import { layerDesktopHandlers, layerRemoteHandlers } from './index';
import { layerIpcServer } from './ipc-server';
import { layerSessionsLive } from './sessions';

/**
 * Hosting serves `RemoteRpcs` with the same (memoized) handler layers as the local server, so a Remote device and the
 * window drive one instance of every service. Its services (pairing, Paired devices, LAN config, secret storage) stay
 * in context for the Devices handlers.
 */
const layerHostingLive = layerDevices.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDeviceIdentityLive,
      layerSecretStorageLive,
      layerLanConfigLive,
      layerMdnsLive,
      layerPowerEventsLive,
      layerStoreUserData,
    ),
  ),
  Layer.provide(layerRemoteHandlers),
);

/**
 * The RPC server for the app's lifetime; windows attach through `RpcPortHandoff`. A call that dies fails alone:
 * by default one defect ends every call of the window (its streams included), so a Remote device dropping in the
 * middle of a call would silence the window's other streams for good.
 */
const layerRpcServer = RpcServer.layer(DesktopRpcs, { disableFatalDefects: true }).pipe(
  Layer.provideMerge(layerIpcServer),
  Layer.provide(layerDesktopHandlers),
  Layer.provide(layerHostingLive),
  // The same (memoized) Settings the handlers use, so main reads them directly.
  Layer.provideMerge(layerSettingsMain),
  // The (memoized) AgentLifetime the Sessions handlers use, so quitting can stop the Agents.
  Layer.provideMerge(layerAgentLifetimeMain),
  // The (memoized) BrowserService the RPC handlers and Sessions share, disposed on quit.
  Layer.provideMerge(layerBrowserMain),
  // Periodic idle auto-archive sharing the same memoized Settings, SessionStore, and Sessions.
  Layer.provideMerge(layerAutoArchiveLive),
);

/** OS notifications for connected Remote devices' Sessions, over the same (memoized) connections the router uses. */
const layerRemoteNotifierLive = layerRemoteNotifier.pipe(
  Layer.provide(Layer.mergeAll(layerHostingLive, layerNotificationDispatcherLive)),
);

/**
 * Hosting as main's lifecycle sees it (resident mode, tray, quit confirm), over the same (memoized) instances the
 * servers use, plus the power blocker held while a hosting Device runs a Turn.
 */
const layerHostingLifecycle = layerKeepAwake.pipe(
  Layer.provideMerge(layerHostingLive),
  Layer.provide(Layer.merge(layerAgentLifetimeMain, layerPowerBlockerLive)),
);

/**
 * The cross-device tools for this Device's Agents, over the same (memoized) Sessions and connections the handlers
 * use. Attached after both exist: Sessions cannot depend on the Devices, which are built over Sessions' handlers.
 */
const layerAgentToolsLive = Layer.effectDiscard(attachAgentTools).pipe(
  Layer.provide(Layer.mergeAll(layerHostingLive, layerSessionsLive)),
);

/** App-lifetime runtime running the RPC server and main's own services. Disposed on `before-quit`. */
export const MainRuntime = ManagedRuntime.make(
  Layer.mergeAll(
    layerRpcServer,
    layerNotificationDispatcherLive,
    layerInAppNotificationChannelLive,
    layerWindowFocus,
    layerNotifierLive,
    layerRemoteNotifierLive,
    layerHostingLifecycle,
    layerAgentToolsLive,
  ),
);
