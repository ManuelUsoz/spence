import { Effect } from 'effect';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { Worktrees } from '../worktrees/worktrees';

export const layerWorktreesHandlers = WorktreesRpcs.toLayer({
  'Worktrees.inventory': Effect.fn('Worktrees.inventory')(function* ({ path, projectId }) {
    const worktrees = yield* Worktrees;
    return yield* worktrees.inventory(path, projectId);
  }),
  'Worktrees.refresh': Effect.fn('Worktrees.refresh')(function* ({ path, projectId }) {
    const worktrees = yield* Worktrees;
    return yield* worktrees.refresh(path, projectId);
  }),
  'Worktrees.locate': Effect.fn('Worktrees.locate')(function* ({
    expectedBinding,
    targetPath,
    projectId,
    allowRebind,
  }) {
    const worktrees = yield* Worktrees;
    return yield* worktrees.locate({
      expectedBinding,
      targetPath,
      ...(projectId === undefined ? {} : { projectId }),
      ...(allowRebind === undefined ? {} : { allowRebind }),
    });
  }),
});
