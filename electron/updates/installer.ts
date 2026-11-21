import { Context, Effect, Layer } from 'effect';
import { spawn } from 'node:child_process';
import { access, chmod, constants, copyFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { UpdatesError } from '../../src/shared/updates/updates.rpc';

/** What an installer needs before it can run once the user restarts. */
export interface PreparedInstall {
  readonly source: string;
  readonly target: string;
}

export interface UpdateInstallerShape {
  /**
   * Checks that the downloaded artifact can be installed on this machine now. Failing here (a read-only
   * AppImage, a missing packaging) leaves the running app untouched and the update pending.
   */
  readonly prepare: (source: string) => Effect.Effect<void, UpdatesError>;
  /** Installs after the last window closed. `true` when the new version must be relaunched by Spence. */
  readonly apply: Effect.Effect<boolean, UpdatesError>;
}

export class UpdateInstaller extends Context.Service<UpdateInstaller, UpdateInstallerShape>()(
  'updates/UpdateInstaller',
) {}

export interface InstallerHost {
  readonly platform: NodeJS.Platform;
  /** The AppImage Spence runs from; `undefined` when it was not launched as one. */
  readonly appImagePath: () => string | undefined;
  /** Starts a Windows installer detached, so it outlives Spence. */
  readonly startDetached: (file: string, args: ReadonlyArray<string>) => Promise<void>;
}

/**
 * The Linux guidance when the AppImage's folder is read-only: moving the AppImage somewhere the user owns (or
 * updating by hand from the release page) is the only safe path. This message is shown verbatim in Settings.
 */
export const appImageNotWritable = (appImage: string): UpdatesError =>
  new UpdatesError({
    reason: 'NotWritable',
    detail: `Spence cannot replace ${appImage}. Move the AppImage to a folder you can write to (for example your home folder), then check again, or download the new AppImage from the release page.`,
  });

const canWriteDirectory = (file: string) =>
  Effect.promise(() =>
    access(path.dirname(file), constants.W_OK).then(
      () => true,
      () => false,
    ),
  );

/**
 * Installs the artifact the way each platform expects: NSIS runs its silent installer after Spence quits,
 * an AppImage is replaced in place (a rename, so the running file keeps executing from memory) and relaunched.
 */
export const makeInstaller = (host: InstallerHost): UpdateInstallerShape => {
  let pending: PreparedInstall | null = null;

  const prepare = Effect.fnUntraced(function* (source: string) {
    if (host.platform === 'win32') {
      pending = { source, target: source };
      return;
    }
    if (host.platform === 'linux') {
      const target = host.appImagePath();
      if (target === undefined) {
        return yield* new UpdatesError({
          reason: 'NotPackaged',
          detail:
            'This Spence was not started as an AppImage, so it cannot update itself. Download the new AppImage from the release page.',
        });
      }
      if (!(yield* canWriteDirectory(target))) {
        return yield* appImageNotWritable(target);
      }
      pending = { source, target };
      return;
    }
    return yield* new UpdatesError({
      reason: 'NotPackaged',
      detail: `Spence does not ship updates for ${host.platform}.`,
    });
  });

  const apply = Effect.gen(function* () {
    if (pending === null) return false;
    const { source, target } = pending;
    if (host.platform === 'win32') {
      yield* Effect.tryPromise({
        try: () => host.startDetached(source, ['/S']),
        catch: (cause) =>
          new UpdatesError({
            reason: 'NotReady',
            detail: `Could not start the installer: ${String(cause)}`,
          }),
      });
      pending = null;
      // NSIS starts the new version itself once Spence has quit.
      return false;
    }
    if (host.platform === 'linux') {
      const beside = `${target}.updating-${process.pid}`;
      yield* Effect.tryPromise({
        try: async () => {
          await copyFile(source, beside);
          await chmod(beside, 0o755);
          await rename(beside, target);
        },
        catch: (cause) =>
          new UpdatesError({
            reason: 'NotReady',
            detail: `Could not replace ${target}: ${String(cause)}`,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.promise(() => rm(beside, { force: true })).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
      pending = null;
      return true;
    }
    return false;
  });

  return { prepare, apply };
};

/** The production host: the platform Spence runs on and the AppImage Electron was launched from. */
export const layerUpdateInstaller: Layer.Layer<UpdateInstaller> = Layer.sync(UpdateInstaller, () =>
  makeInstaller({
    platform: process.platform,
    appImagePath: () => process.env['APPIMAGE'],
    startDetached: (file, args) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(file, [...args], { detached: true, stdio: 'ignore' });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      }),
  }),
);
