import { Context, type Effect } from 'effect';
import type { FileOperationsError } from '../../src/shared/files/file-operations.rpc';

/** Effect boundary around OS trash removal (`shell.trashItem` in Electron main). */
export interface TrashShape {
  readonly moveToTrash: (absolutePath: string) => Effect.Effect<void, FileOperationsError>;
}

/** OS trash service; swapped in tests without touching the real recycle bin. */
export class Trash extends Context.Service<Trash, TrashShape>()('files/Trash') {}
