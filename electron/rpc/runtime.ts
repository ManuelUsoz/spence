import { Layer, ManagedRuntime } from 'effect';
import { RpcServer } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerDeviceIdentityLive } from '../devices/identity';
import { layerDeviceTrustNone } from '../devices/trust';
import { layerHosting } from '../lan/hosting';
import { layerLanConfigLive } from '../lan/server';
import { layerAutoArchiveLive } from '../sessions/auto-archive';
import { layerNotifierLive } from '../sessions/os-notifier';
import { layerSettingsMain } from '../settings/window';
import { layerDesktopHandlers, layerRemoteHandlers } from './index';
import { layerIpcServer } from './ipc-server';

/**
 * Hosting serves `RemoteRpcs` with the same (memoized) handler layers as the local server, so a Remote device and the
 * window drive one instance of every service.
 */
const layerHostingLive = layerHosting.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRemoteHandlers,
      layerDeviceIdentityLive,
      layerDeviceTrustNone,
      layerLanConfigLive,
    ),
  ),
);

/** The RPC server for the app's lifetime; windows attach through `RpcPortHandoff`. */
const layerRpcServer = RpcServer.layer(DesktopRpcs).pipe(
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

/** App-lifetime runtime running the RPC server and main's own services. Disposed on `before-quit`. */
export const MainRuntime = ManagedRuntime.make(Layer.merge(layerRpcServer, layerNotifierLive));
