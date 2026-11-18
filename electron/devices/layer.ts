import { Layer } from 'effect';
import { layerDeviceConnections } from '../lan/connections';
import { layerHosting } from '../lan/hosting';
import { layerDeviceTrust, layerPairedDevices } from './paired-devices';
import { layerPairingHost } from './pairing-host';

/**
 * Everything a Device needs to host, pair and connect: hosting with its listener, the pairing code, the Paired
 * devices, the trust built on them and the connections to them. Left open: the store, secret storage, LAN config, identity and the Remote handlers, so
 * main and the test Device share one composition.
 */
export const layerDevices = Layer.merge(layerHosting, layerDeviceConnections).pipe(
  Layer.provideMerge(layerPairingHost),
  Layer.provideMerge(layerDeviceTrust),
  Layer.provideMerge(layerPairedDevices),
);
