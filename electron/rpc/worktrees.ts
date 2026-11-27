import { Effect, Layer, Stream } from 'effect';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { layerProjectsLive } from '../projects/projects';
import { layerStoreUserData } from '../store/store';
import { layerBranchOrigins } from '../worktrees/branch-origins';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { layerSessionsLive } from './sessions';

/** Unbound: needs `Worktrees`, so a test Device can serve it over its own Sessions. */
export const layerWorktreesHandlersWith = WorktreesRpcs.toLayer({
  'Worktrees.list': ({ sessionId }) => Worktrees.use((worktrees) => worktrees.list(sessionId)),
  'Worktrees.prepareDraft': ({ sessionId, branch, base }) =>
    Worktrees.use((worktrees) => worktrees.prepareDraft(sessionId, branch, base)),
  'Worktrees.prepareDraftStream': ({ sessionId, branch, base, setupCommand }) =>
    Stream.unwrap(
      Worktrees.use((worktrees) =>
        Effect.succeed(worktrees.prepareDraftStream(sessionId, branch, base, setupCommand)),
      ),
    ),
});

export const layerWorktreesHandlers = layerWorktreesHandlersWith.pipe(
  Layer.provide(
    layerWorktrees.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSessionsLive,
          layerProjectsLive,
          layerBranchOrigins.pipe(Layer.provide(layerStoreUserData)),
        ),
      ),
    ),
  ),
);
