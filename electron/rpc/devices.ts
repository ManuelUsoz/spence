import { Effect, Layer, Stream } from 'effect';
import { type DeviceId, DevicesRpcs } from '../../src/shared/devices/devices.rpc';
import { layerDeviceIdentityLive } from '../devices/identity';
import { checkPaired, devicesState, pairWith, unpair } from '../devices/pairing';
import { PairedDevices } from '../devices/paired-devices';
import { PairingHost } from '../devices/pairing-host';
import { DeviceConnections } from '../lan/connections';
import { Discovery } from '../lan/discovery';
import { Hosting } from '../lan/hosting';
import { Viewers, viewersState } from '../lan/viewers';

/** Local-only: never part of `RemoteRpcs`. The Devices services are provided by the runtime, next to the servers. */
export const layerDevicesHandlers = DevicesRpcs.toLayer({
  'Devices.local': () => Hosting.use((hosting) => hosting.local),
  'Devices.rename': ({ name }) => Hosting.use((hosting) => hosting.rename(name)),
  'Devices.setHosting': ({ on }) => Hosting.use((hosting) => hosting.set(on)),
  'Devices.watch': () => devicesState,
  'Devices.nearby': () =>
    Stream.unwrap(Discovery.use((discovery) => Effect.succeed(discovery.nearby))),
  'Devices.startPairing': () => Hosting.use((hosting) => hosting.startPairing),
  'Devices.cancelPairing': () => PairingHost.use((host) => host.close),
  'Devices.pair': (input) => pairWith(input),
  'Devices.check': ({ id }: { readonly id: DeviceId }) => checkPaired(id),
  'Devices.connections': () =>
    Stream.unwrap(DeviceConnections.use((connections) => Effect.succeed(connections.changes))),
  'Devices.connect': ({ id }: { readonly id: DeviceId }) =>
    DeviceConnections.use((connections) => connections.connect(id)),
  'Devices.viewers': () => viewersState,
  'Devices.disconnect': ({ id }: { readonly id: DeviceId }) =>
    Viewers.use((viewers) => viewers.disconnect(id)),
  'Devices.unpair': ({ id }: { readonly id: DeviceId }) => unpair(id),
  'Devices.setAllowAgents': ({ id, allow }) =>
    PairedDevices.use((paired) => paired.setAllowAgents(id, allow)),
}).pipe(Layer.provide(layerDeviceIdentityLive));
