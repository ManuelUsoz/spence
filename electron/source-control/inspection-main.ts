import { Layer } from 'effect';
import { layerSessionStoreLive } from '../sessions/session-store';
import { layerWorktreesMain } from '../worktrees/worktrees-main';
import { layerSourceControl } from './source-control';

/** Inspection shares the Session store, Worktrees and utility worker. */
export const layerInspectionMain = layerSourceControl.pipe(
  Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerWorktreesMain)),
);
