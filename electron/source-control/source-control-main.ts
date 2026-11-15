import { Layer } from 'effect';
import { layerSessionStoreLive } from '../sessions/session-store';
import { layerWorktreesMain } from '../worktrees/worktrees-main';
import { layerSourceControl } from './source-control';

/** App-lifetime SourceControl service sharing the single source-control utility worker and SessionStore. */
export const layerSourceControlMain = layerSourceControl.pipe(
  Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerWorktreesMain)),
);
