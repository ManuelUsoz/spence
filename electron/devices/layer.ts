import { Layer } from 'effect';
import { layerDeviceConnections } from '../lan/connections';
import { layerDiscovery } from '../lan/discovery';
import { layerHosting } from '../lan/hosting';
import { layerViewers } from '../lan/viewers';
import { layerDeviceTrust, layerPairedDevices } from './paired-devices';
import { layerPairingHost } from './pairing-host';
import { layerDevicePresence } from './presence';

/**
 * Everything a Device needs to host, be found, pair and connect: hosting with its listener and the viewers connected to it, discovery, the pairing
 * code, the Paired devices (found again through discovery), the trust built on them and the connections to them.
 * Left open: the store, secret storage, LAN config, identity, mDNS and the Remote handlers, so main and the test
 * Device share one composition.
 */
export const layerDevices = Layer.mergeAll(layerHosting, layerDeviceConnections).pipe(
  Layer.provideMerge(layerPairingHost),
  Layer.provideMerge(layerViewers),
  Layer.provideMerge(layerDeviceTrust),
  Layer.provideMerge(layerDevicePresence),
  Layer.provideMerge(layerPairedDevices),
  Layer.provideMerge(layerDiscovery),
);
