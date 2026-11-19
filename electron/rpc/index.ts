import { Layer } from 'effect';
import { DeviceScopedRpcs } from '../../src/shared/rpc/remote-rpcs';
import { relayRemoteAssets } from '../lan/asset-relay';
import { routeToDevices } from '../lan/router';
import { layerAgentsHandlers } from './agents';
import { layerAppInfoHandlers } from './app-info';
import { layerAssetsHandlers } from './assets';
import { layerDevicesHandlers } from './devices';
import { layerFilesHandlers } from './files';
import { layerFoldersHandlers } from './folders';
import { layerLinksHandlers } from './links';
import { layerInboxHandlers, layerMessagingHandlers } from './messaging';
import { layerProjectPickerHandlers, layerProjectsHandlers } from './projects';
import { layerRemoteInfoHandlers } from './remote';
import { layerSessionsHandlers } from './sessions';
import { layerExecutionSettingsHandlers, layerSettingsHandlers } from './settings';
import { layerSourceControlHandlers } from './source-control';
import { layerTabsHandlers } from './tabs';
import { layerWorktreesHandlers } from './worktrees';

/** The Local device's handlers for `DeviceScopedRpcs`: what the window and Paired devices both reach. */
const layerDeviceScopedHandlers = Layer.mergeAll(
  layerProjectsHandlers,
  layerSessionsHandlers,
  layerFilesHandlers,
  layerWorktreesHandlers,
  layerSourceControlHandlers,
  layerAgentsHandlers,
  layerFoldersHandlers,
  layerExecutionSettingsHandlers,
  layerAssetsHandlers,
);

/**
 * Handlers for every domain in `DesktopRpcs`. Merge new domain handler layers here. The Device-scoped ones are
 * routed: a call naming a Remote device goes to it, any other runs here.
 */
export const layerDesktopHandlers = Layer.mergeAll(
  layerAppInfoHandlers,
  layerSettingsHandlers,
  layerTabsHandlers,
  layerLinksHandlers,
  layerDevicesHandlers,
  layerRemoteInfoHandlers,
  layerMessagingHandlers,
  layerProjectPickerHandlers,
  relayRemoteAssets(routeToDevices(DeviceScopedRpcs)(layerDeviceScopedHandlers)),
);

/**
 * Handlers for `RemoteRpcs`, the allow-list served to Paired devices. The very same layers as above, unrouted, so
 * both servers share one memoized instance of each and a Remote device never reaches a third.
 */
export const layerRemoteHandlers = Layer.mergeAll(
  layerRemoteInfoHandlers,
  layerDeviceScopedHandlers,
  layerInboxHandlers,
);
