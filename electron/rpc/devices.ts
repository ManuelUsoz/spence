import { Effect, Layer } from 'effect';
import { type DeviceId, DevicesRpcs } from '../../src/shared/devices/devices.rpc';
import { DeviceIdentity, layerDeviceIdentityLive } from '../devices/identity';
import { checkPaired, devicesState, pairWith, unpair } from '../devices/pairing';
import { PairingHost } from '../devices/pairing-host';
import { Hosting } from '../lan/hosting';

/** Local-only: never part of `RemoteRpcs`. The Devices services are provided by the runtime, next to the servers. */
export const layerDevicesHandlers = DevicesRpcs.toLayer({
  'Devices.local': () => Hosting.use((hosting) => hosting.local),
  'Devices.rename': Effect.fnUntraced(function* ({ name }: { readonly name: string }) {
    yield* DeviceIdentity.use((identity) => identity.rename(name));
    return yield* Hosting.use((hosting) => hosting.local);
  }),
  'Devices.setHosting': ({ on }) => Hosting.use((hosting) => hosting.set(on)),
  'Devices.watch': () => devicesState,
  'Devices.startPairing': () => Hosting.use((hosting) => hosting.startPairing),
  'Devices.cancelPairing': () => PairingHost.use((host) => host.close),
  'Devices.pair': (input) => pairWith(input),
  'Devices.check': ({ id }: { readonly id: DeviceId }) => checkPaired(id),
  'Devices.unpair': ({ id }: { readonly id: DeviceId }) => unpair(id),
}).pipe(Layer.provide(layerDeviceIdentityLive));
