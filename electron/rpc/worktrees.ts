import { Effect, Option } from 'effect';
import { WorktreesRpcs } from '../../src/shared/worktrees/worktrees.rpc';
import { FolderPicker } from '../projects/folders';
import { WorktreeCreate } from '../worktrees/worktree-create';
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
  'Worktrees.prepareCreate': Effect.fn('Worktrees.prepareCreate')(function* ({ path, projectId }) {
    const worktreeCreate = yield* WorktreeCreate;
    return yield* worktreeCreate.prepareCreate({
      path,
      ...(projectId === undefined ? {} : { projectId }),
    });
  }),
  'Worktrees.revalidateCreate': Effect.fn('Worktrees.revalidateCreate')(function* (payload) {
    const worktreeCreate = yield* WorktreeCreate;
    return yield* worktreeCreate.revalidateCreate(payload);
  }),
  'Worktrees.executeCreate': Effect.fn('Worktrees.executeCreate')(function* (payload) {
    const worktreeCreate = yield* WorktreeCreate;
    return yield* worktreeCreate.executeCreate(payload);
  }),
  'Worktrees.pickDestination': Effect.fn('Worktrees.pickDestination')(function* () {
    const picker = yield* FolderPicker;
    const picked = yield* picker.pick;
    return Option.isSome(picked) ? picked.value : null;
  }),
});
