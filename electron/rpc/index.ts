import { Layer } from 'effect';
import { layerAgentsHandlers } from './agents';
import { layerAppInfoHandlers } from './app-info';
import { layerFileOperationHandlers } from './file-operations';
import { layerFilesHandlers } from './files';
import { layerHistoryHandlers } from './history';
import { layerProjectsHandlers } from './projects';
import { layerSessionsHandlers } from './sessions';
import { layerSettingsHandlers } from './settings';
import { layerSourceControlHandlers } from './source-control';
import { layerTabsHandlers } from './tabs';
import { layerWorktreesHandlers } from './worktrees';

/** Handlers for every domain in `DesktopRpcs`. Merge new domain handler layers here. */
export const layerDesktopHandlers = Layer.mergeAll(
  layerAppInfoHandlers,
  layerAgentsHandlers,
  layerFileOperationHandlers,
  layerFilesHandlers,
  layerHistoryHandlers,
  layerProjectsHandlers,
  layerSessionsHandlers,
  layerSettingsHandlers,
  layerSourceControlHandlers,
  layerTabsHandlers,
  layerWorktreesHandlers,
);
