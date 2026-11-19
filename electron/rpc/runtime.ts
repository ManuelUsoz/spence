import { Layer, ManagedRuntime } from 'effect';
import { RpcServer } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerDeviceIdentityLive } from '../devices/identity';
import { layerDevices } from '../devices/layer';
import { layerSecretStorageLive } from '../devices/secret-storage-electron';
import { layerLanConfigLive } from '../lan/config';
import { layerMdnsLive } from '../lan/mdns-bonjour';
import { layerPowerEventsLive } from '../lan/power';
import { layerRemoteNotifier } from '../lan/remote-notifier';
import { layerStoreUserData } from '../store/store';
import { layerAutoArchiveLive } from '../sessions/auto-archive';
import { layerNotifierLive, layerOsNotificationChannel } from '../sessions/os-notifier';
import { layerSettingsMain } from '../settings/window';
import { layerDesktopHandlers, layerRemoteHandlers } from './index';
import { layerIpcServer } from './ipc-server';

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
  // Periodic idle auto-archive sharing the same memoized Settings, SessionStore, and Sessions.
  Layer.provideMerge(layerAutoArchiveLive),
);

/** OS notifications for connected Remote devices' Sessions, over the same (memoized) connections the router uses. */
const layerRemoteNotifierLive = layerRemoteNotifier.pipe(
  Layer.provide(Layer.mergeAll(layerHostingLive, layerOsNotificationChannel)),
);

/** App-lifetime runtime running the RPC server and main's own services. Disposed on `before-quit`. */
export const MainRuntime = ManagedRuntime.make(
  Layer.mergeAll(layerRpcServer, layerNotifierLive, layerRemoteNotifierLive),
);
