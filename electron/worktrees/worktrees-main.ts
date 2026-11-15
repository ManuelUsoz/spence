import { Layer } from 'effect';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStoreUserData } from '../store/store';
import { GitWorker, makeLayerGitWorkerUtility } from './git-client';
import { layerWorktrees, Worktrees } from './worktrees';

const layerWorktreesPath = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));

/** Single app-lifetime source-control utility worker shared by Worktrees and SourceControl. */
export const layerGitWorkerMain: Layer.Layer<GitWorker> = makeLayerGitWorkerUtility().pipe(
  Layer.provide(layerWorktreesPath),
);

/** App-lifetime Worktrees service over `<userData>/spence/` and one packaged source-control utility worker. */
export const layerWorktreesMain: Layer.Layer<Worktrees | GitWorker> = layerWorktrees.pipe(
  Layer.provideMerge(layerGitWorkerMain),
  Layer.provide(Layer.mergeAll(layerWorktreesPath, layerStoreUserData)),
);
