import { Context, Effect, Option } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';

/**
 * The Paired device a LAN call came from, verified once when its connection was opened (bearer token and device id
 * at the WebSocket upgrade). The LAN server provides it to every call of that connection; the window's local server
 * provides none, so a handler reads it as an option: none means the call came from this Device's own window.
 */
export class RemotePeer extends Context.Service<RemotePeer, { readonly deviceId: DeviceId }>()(
  'lan/RemotePeer',
) {}

/** The Paired device the current call came from; none for this Device's own window. */
export const currentPeer: Effect.Effect<Option.Option<DeviceId>> = Effect.map(
  Effect.serviceOption(RemotePeer),
  Option.map((peer) => peer.deviceId),
);
