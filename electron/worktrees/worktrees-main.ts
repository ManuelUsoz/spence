import { Layer } from 'effect';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import {
  layerOperationsMain,
  layerReservationCoordinatorMain,
  layerReviewRegistryMain,
} from '../source-control/source-control-main';
import { layerStoreUserData } from '../store/store';
import { makeLayerGitWorkerUtility } from './git-client';
import { layerWorktreeCreate } from './worktree-create';
import { layerWorktrees } from './worktrees';

const layerWorktreesPath = layerMergedPath.pipe(Layer.provideMerge(layerPathSources));

/** One shared packaged source-control utility process across all Git operations. */
export const layerGitWorkerMain = makeLayerGitWorkerUtility().pipe(
  Layer.provide(layerWorktreesPath),
);

/** App-lifetime Worktrees service over `<userData>/spence/` and one packaged source-control utility worker. */
export const layerWorktreesMain = layerWorktrees.pipe(
  Layer.provide(layerGitWorkerMain),
  Layer.provide(Layer.mergeAll(layerWorktreesPath, layerStoreUserData)),
);

/** App-lifetime Worktree creation service sharing the app's single utility worker and coordinators. */
export const layerWorktreeCreateMain = layerWorktreeCreate.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerWorktreesMain,
      layerGitWorkerMain,
      layerWorktreesPath,
      layerReviewRegistryMain,
      layerReservationCoordinatorMain,
      layerOperationsMain,
    ),
  ),
);
