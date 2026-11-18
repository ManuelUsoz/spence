import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { DeviceId } from '../devices/devices.rpc';

/** The one integer two Devices must agree on. Bump it on any breaking change to `RemoteRpcs`; no negotiation. */
export const PROTOCOL_VERSION = 1;

/** Who a Device is, as another Device sees it. */
export const RemoteHello = Schema.Struct({
  deviceId: DeviceId,
  name: Schema.String,
  protocolVersion: Schema.Int,
}).annotate({ identifier: 'RemoteHello' });
export type RemoteHello = typeof RemoteHello.Type;

/** What a Device says about itself to whoever calls it, Local or Remote. */
export const RemoteInfoRpcs = RpcGroup.make(Rpc.make('Remote.hello', { success: RemoteHello }));
