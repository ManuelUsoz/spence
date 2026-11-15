import { Layer, ManagedRuntime } from 'effect';
import { RpcServer } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerAutoArchiveLive } from '../sessions/auto-archive';
import { layerNotifierLive } from '../sessions/os-notifier';
import { layerSettingsMain } from '../settings/window';
import { layerSourceControlMain } from '../source-control/source-control-main';
import { layerWorktreesMain } from '../worktrees/worktrees-main';
import { layerFilesMain } from '../files/files-main';
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
  // Periodic idle auto-archive sharing the same memoized Settings, SessionStore, and Sessions.
  Layer.provideMerge(layerAutoArchiveLive),
  // App-lifetime Worktrees inventory service (and single shared source-control utility worker).
  Layer.provideMerge(layerWorktreesMain),
  // App-lifetime SourceControl inspection service sharing Worktrees, SessionStore, and GitWorker.
  Layer.provideMerge(layerSourceControlMain),
  // App-lifetime Files service sharing singleton Projects, Worktrees, and GitWorker.
  Layer.provideMerge(layerFilesMain),
);

/** App-lifetime runtime running the RPC server and main's own services. Disposed on `before-quit`. */
export const MainRuntime = ManagedRuntime.make(Layer.merge(layerRpcServer, layerNotifierLive));
