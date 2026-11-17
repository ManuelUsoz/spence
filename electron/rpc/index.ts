import { Layer } from 'effect';
import { layerAgentsHandlers } from './agents';
import { layerAppInfoHandlers } from './app-info';
import { layerLinksHandlers } from './links';
import { layerProjectsHandlers } from './projects';
import { layerSessionsHandlers } from './sessions';
import { layerSettingsHandlers } from './settings';
import { layerTabsHandlers } from './tabs';

/** Handlers for every domain in `DesktopRpcs`. Merge new domain handler layers here. */
export const layerDesktopHandlers = Layer.mergeAll(
  layerAppInfoHandlers,
  layerAgentsHandlers,
  layerProjectsHandlers,
  layerSessionsHandlers,
  layerSettingsHandlers,
  layerTabsHandlers,
  layerLinksHandlers,
);
