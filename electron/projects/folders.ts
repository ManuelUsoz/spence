import { BrowserWindow, dialog } from 'electron';
import { Context, Effect, Layer, Option } from 'effect';
import { realpath, stat } from 'node:fs/promises';

/** The disk as Projects see it. Swapped in tests; the live layer reads the OS. */
export class Folders extends Context.Service<
  Folders,
  {
    /** Decides whether folder paths compare case-insensitively (`win32`). */
    readonly platform: NodeJS.Platform;
    /** The folder's real path (links resolved, casing as on disk); none when it does not exist. */
    readonly realPath: (folder: string) => Effect.Effect<Option.Option<string>>;
    /** Whether a folder is there now: one `stat`. */
    readonly exists: (folder: string) => Effect.Effect<boolean>;
  }
>()('projects/Folders') {}

/** The OS folder picker. */
export class FolderPicker extends Context.Service<
  FolderPicker,
  {
    /** Asks the user for one folder; none when they cancel. */
    readonly pick: Effect.Effect<Option.Option<string>>;
  }
>()('projects/FolderPicker') {}

const missing = (error: unknown): boolean => {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

export const layerFolders = Layer.succeed(Folders, {
  platform: process.platform,
  realPath: (folder) =>
    Effect.tryPromise({ try: () => realpath(folder), catch: (error) => error }).pipe(
      Effect.map(Option.some),
      Effect.catch((error) => (missing(error) ? Effect.succeed(Option.none()) : Effect.die(error))),
    ),
  exists: (folder) =>
    Effect.tryPromise({ try: () => stat(folder), catch: (error) => error }).pipe(
      Effect.map((stats) => stats.isDirectory()),
      // A folder Spence cannot reach counts as missing, whatever the reason.
      Effect.orElseSucceed(() => false),
    ),
});

/** The e2e harness answers the picker with `SPENCE_E2E_PICK_FOLDER` instead of opening a native dialog. */
const e2ePick =
  process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_E2E_PICK_FOLDER'] : undefined;

export const layerFolderPicker = Layer.succeed(FolderPicker, {
  pick:
    e2ePick === undefined
      ? Effect.tryPromise({
          try: () => {
            const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
            const parent = BrowserWindow.getFocusedWindow();
            return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
          },
          catch: (error) => error,
        }).pipe(
          Effect.map((result) =>
            result.canceled ? Option.none() : Option.fromUndefinedOr(result.filePaths[0]),
          ),
          Effect.orDie,
        )
      : Effect.succeed(Option.some(e2ePick)),
});
