import { shell } from 'electron';
import { Effect, Layer } from 'effect';
import { FilesError } from '../../src/shared/files/files.rpc';
import { FileOperationsError } from '../../src/shared/files/file-operations.rpc';
import { layerProjectsLive } from '../projects/projects';
import { layerWorktreesMain } from '../worktrees/worktrees-main';
import { ExternalOpener, layerFiles } from './files';
import { layerFileOperations } from './file-operations';
import { Trash } from './trash';
import {
  layerOperationsMain,
  layerReservationCoordinatorMain,
  layerReviewRegistryMain,
} from '../source-control/source-control-main';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';

/** Electron main `shell.openPath` implementation of `ExternalOpener`. */
export const layerExternalOpenerMain = Layer.succeed(ExternalOpener, {
  openPath: (targetPath) =>
    Effect.tryPromise({
      try: () => shell.openPath(targetPath),
      catch: (cause) =>
        new FilesError({
          reason: 'IoFailed',
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((failure) =>
        failure === ''
          ? Effect.void
          : Effect.fail(new FilesError({ reason: 'IoFailed', detail: failure })),
      ),
    ),
});

/** Electron main `shell.trashItem` implementation of `Trash`. */
export const layerTrashMain = Layer.succeed(Trash, {
  moveToTrash: (absolutePath) =>
    Effect.tryPromise({
      try: () => shell.trashItem(absolutePath),
      catch: (cause) => {
        const detail = cause instanceof Error ? cause.message : String(cause);
        if (
          typeof detail === 'string' &&
          (detail.toLowerCase().includes('trash') || detail.toLowerCase().includes('recycle'))
        ) {
          return new FileOperationsError({
            reason: 'TrashUnavailable',
            detail: 'Trash is unavailable. Confirm permanent deletion to proceed.',
          });
        }
        return new FileOperationsError({ reason: 'IoFailed', detail });
      },
    }),
});

/** App-lifetime `Files` layer sharing singleton `Projects`, `Worktrees`, and `GitWorker` services. */
export const layerFilesMain = layerFiles.pipe(
  Layer.provide(Layer.mergeAll(layerProjectsLive, layerWorktreesMain, layerExternalOpenerMain)),
);

/** App-lifetime FileOperations layer sharing coordinators, Store, and the source-control worker. */
export const layerFileOperationsMain = layerFileOperations.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectsLive,
      layerWorktreesMain,
      layerMergedPath.pipe(Layer.provideMerge(layerPathSources)),
      layerReviewRegistryMain,
      layerReservationCoordinatorMain,
      layerOperationsMain,
      layerTrashMain,
    ),
  ),
);
