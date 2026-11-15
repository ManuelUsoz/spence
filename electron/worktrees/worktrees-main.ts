import { Layer } from 'effect';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStoreUserData } from '../store/store';
import { makeLayerGitWorkerUtility } from './git-client';
import { layerWorktrees } from './worktrees';

const layerWorktreesPath = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));

/** Shared app-lifetime source-control utility worker reused across Worktrees and Files. */
export const layerGitWorkerMain = makeLayerGitWorkerUtility().pipe(
  Layer.provide(layerWorktreesPath),
);

/** App-lifetime Worktrees service over `<userData>/spence/` and one packaged source-control utility worker. */
export const layerWorktreesMain = layerWorktrees.pipe(
  Layer.provideMerge(layerGitWorkerMain),
  Layer.provide(Layer.mergeAll(layerWorktreesPath, layerStoreUserData)),
);
