import { Effect, Layer } from 'effect';
import { RemoteInfoRpcs, PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { DeviceIdentity, layerDeviceIdentityLive } from '../devices/identity';

/** Unbound: needs `DeviceIdentity`, so a test Device can serve it over its own data directory. */
export const layerRemoteInfoHandlersWith = RemoteInfoRpcs.toLayer({
  'Remote.hello': () =>
    Effect.map(
      DeviceIdentity.use((identity) => identity.get),
      (device) => ({
        deviceId: device.id,
        name: device.name,
        protocolVersion: PROTOCOL_VERSION,
      }),
    ),
});

export const layerRemoteInfoHandlers = layerRemoteInfoHandlersWith.pipe(
  Layer.provide(layerDeviceIdentityLive),
);
