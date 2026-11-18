import { Layer } from 'effect';
import { layerAgentsHandlers } from './agents';
import { layerAppInfoHandlers } from './app-info';
import { layerDevicesHandlers } from './devices';
import { layerFilesHandlers } from './files';
import { layerLinksHandlers } from './links';
import { layerProjectsHandlers } from './projects';
import { layerRemoteInfoHandlers } from './remote';
import { layerSessionsHandlers } from './sessions';
import { layerSettingsHandlers } from './settings';
import { layerSourceControlHandlers } from './source-control';
import { layerTabsHandlers } from './tabs';
import { layerWorktreesHandlers } from './worktrees';

/** Handlers for every domain in `DesktopRpcs`. Merge new domain handler layers here. */
export const layerDesktopHandlers = Layer.mergeAll(
  layerAppInfoHandlers,
  layerAgentsHandlers,
  layerProjectsHandlers,
  layerSessionsHandlers,
  layerSettingsHandlers,
  layerTabsHandlers,
  layerLinksHandlers,
  layerSourceControlHandlers,
  layerWorktreesHandlers,
  layerFilesHandlers,
  layerDevicesHandlers,
  layerRemoteInfoHandlers,
);

/**
 * Handlers for `RemoteRpcs`, the allow-list served to Paired devices. The very same layers as above, so both servers
 * share one memoized instance of each.
 */
export const layerRemoteHandlers = Layer.mergeAll(
  layerRemoteInfoHandlers,
  layerProjectsHandlers,
  layerSessionsHandlers,
  layerFilesHandlers,
  layerWorktreesHandlers,
  layerSourceControlHandlers,
  layerAgentsHandlers,
);
