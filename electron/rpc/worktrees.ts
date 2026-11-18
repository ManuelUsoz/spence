import { Layer } from 'effect';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { layerWorktrees, Worktrees } from '../worktrees/worktrees';
import { layerSessionsLive } from './sessions';

export const layerWorktreesHandlers = WorktreesRpcs.toLayer({
  'Worktrees.list': ({ sessionId }) => Worktrees.use((worktrees) => worktrees.list(sessionId)),
  'Worktrees.create': ({ sessionId, branch }) =>
    Worktrees.use((worktrees) => worktrees.create(sessionId, branch)),
  'Worktrees.select': ({ sessionId, path }) =>
    Worktrees.use((worktrees) => worktrees.select(sessionId, path)),
}).pipe(Layer.provide(layerWorktrees.pipe(Layer.provide(layerSessionsLive))));
