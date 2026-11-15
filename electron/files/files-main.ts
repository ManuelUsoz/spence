import { shell } from 'electron';
import { Effect, Layer } from 'effect';
import { FilesError } from '../../src/shared/files/files.rpc';
import { layerProjectsLive } from '../projects/projects';
import { layerWorktreesMain } from '../worktrees/worktrees-main';
import { ExternalOpener, layerFiles } from './files';

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

/** App-lifetime `Files` layer sharing singleton `Projects`, `Worktrees`, and `GitWorker` services. */
export const layerFilesMain = layerFiles.pipe(
  Layer.provide(Layer.mergeAll(layerProjectsLive, layerWorktreesMain, layerExternalOpenerMain)),
);
