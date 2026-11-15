import { Layer } from 'effect';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStoreUserData } from '../store/store';
import { makeLayerGitWorkerUtility } from './git-client';
import { layerWorktrees } from './worktrees';

const layerWorktreesPath = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));

/** App-lifetime Worktrees service over `<userData>/spence/` and one packaged source-control utility worker. */
export const layerWorktreesMain = layerWorktrees.pipe(
  Layer.provide(makeLayerGitWorkerUtility()),
  Layer.provide(Layer.mergeAll(layerWorktreesPath, layerStoreUserData)),
);
