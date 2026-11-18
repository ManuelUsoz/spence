import { Effect, Layer } from 'effect';
import { DevicesRpcs } from '../../src/shared/devices/devices.rpc';
import { DeviceIdentity, layerDeviceIdentityLive } from '../devices/identity';
import { Hosting } from '../lan/hosting';

/** Local-only: never part of `RemoteRpcs`. `Hosting` is provided by the runtime, next to the RPC servers. */
export const layerDevicesHandlers = DevicesRpcs.toLayer({
  'Devices.local': () => Hosting.use((hosting) => hosting.local),
  'Devices.rename': Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
    yield* DeviceIdentity.use((identity) => identity.rename(name));
    return yield* Hosting.use((hosting) => hosting.local);
  }),
  'Devices.setHosting': ({ on }) => Hosting.use((hosting) => hosting.set(on)),
}).pipe(Layer.provide(layerDeviceIdentityLive));
