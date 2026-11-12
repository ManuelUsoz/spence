import { Layer, ManagedRuntime } from 'effect';
import { RpcServer } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerSettingsMain } from '../settings/window';
import { layerDesktopHandlers } from './index';
import { layerIpcServer } from './ipc-server';

/** The RPC server for the app's lifetime; windows attach through `RpcPortHandoff`. */
const layerRpcServer = RpcServer.layer(DesktopRpcs).pipe(
  Layer.provideMerge(layerIpcServer),
  Layer.provide(layerDesktopHandlers),
  // The same (memoized) Settings the handlers use, so main reads them directly.
  Layer.provideMerge(layerSettingsMain),
  // The (memoized) AgentLifetime the Sessions handlers use, so quitting can stop the Agents.
  Layer.provideMerge(layerAgentLifetimeMain),
);

/** App-lifetime runtime running the RPC server and main's own services. Disposed on `before-quit`. */
export const MainRuntime = ManagedRuntime.make(layerRpcServer);
