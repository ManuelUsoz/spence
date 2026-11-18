import { Layer } from 'effect';
import { layerHosting } from '../lan/hosting';
import { layerDeviceTrust, layerPairedDevices } from './paired-devices';
import { layerPairingHost } from './pairing-host';

/**
 * Everything a Device needs to host and pair: hosting with its listener, the pairing code, the Paired devices and
 * the trust built on them. Left open: the store, secret storage, LAN config, identity and the Remote handlers, so
 * main and the test Device share one composition.
 */
export const layerDevices = layerHosting.pipe(
  Layer.provideMerge(layerPairingHost),
  Layer.provideMerge(layerDeviceTrust),
  Layer.provideMerge(layerPairedDevices),
);
