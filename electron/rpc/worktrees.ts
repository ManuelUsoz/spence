import { Layer } from 'effect';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { layerSessionsLive } from './sessions';

/** Unbound: needs `Worktrees`, so a test Device can serve it over its own Sessions. */
export const layerWorktreesHandlersWith = WorktreesRpcs.toLayer({
  'Worktrees.list': ({ sessionId }) => Worktrees.use((worktrees) => worktrees.list(sessionId)),
  'Worktrees.prepareDraft': ({ sessionId, branch, base }) =>
    Worktrees.use((worktrees) => worktrees.prepareDraft(sessionId, branch, base)),
});

export const layerWorktreesHandlers = layerWorktreesHandlersWith.pipe(
  Layer.provide(layerWorktrees.pipe(Layer.provide(layerSessionsLive))),
);
