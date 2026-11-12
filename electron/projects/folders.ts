import { BrowserWindow, dialog } from 'electron';
import { Context, Effect, Layer, Option } from 'effect';
import { realpath, stat } from 'node:fs/promises';
import { tryFs } from '../store/fs';

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

export const layerFolders = Layer.succeed(Folders, {
  platform: process.platform,
  realPath: (folder) =>
    tryFs(folder, () => realpath(folder)).pipe(
      Effect.map(Option.some),
      Effect.catchTag('FsError', () => Effect.succeed(Option.none())),
    ),
  exists: (folder) =>
    // A folder Spence cannot reach counts as missing, whatever the reason.
    Effect.promise(() =>
      stat(folder).then(
        (stats) => stats.isDirectory(),
        () => false,
      ),
    ),
});

/**
 * The e2e harness answers the picker with `SPENCE_E2E_PICK_FOLDER` instead of opening a native dialog. It is read at
 * each pick, so a spec can point the next pick at another folder.
 */
const e2ePick = process.env['SPENCE_E2E'] === '1';

export const layerFolderPicker = Layer.succeed(FolderPicker, {
  pick: !e2ePick
    ? Effect.promise(() => {
        const options: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
        const parent = BrowserWindow.getFocusedWindow();
        return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options);
      }).pipe(
        Effect.map((result) =>
          result.canceled ? Option.none() : Option.fromUndefinedOr(result.filePaths[0]),
        ),
      )
    : Effect.sync(() => Option.fromUndefinedOr(process.env['SPENCE_E2E_PICK_FOLDER'])),
});
