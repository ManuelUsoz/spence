import { app, autoUpdater } from 'electron';
import { Effect } from 'effect';
import { UpdateRpcs } from '../../src/shared/app-info/update.rpc';
import { findUpdate } from '../updates/github';
import { downloadDeb } from '../updates/linux';

type Result = {
  readonly status: 'available' | 'current' | 'unsupported' | 'failed';
  readonly detail: string;
};
let pending: Promise<Result> | undefined;
let downloadedVersion: string | undefined;
let debFile: string | undefined;
export const downloadedDeb = (): string | undefined => debFile;
let install: () => Promise<boolean> = async () => false;

export const setUpdateInstaller = (run: () => Promise<boolean>): void => {
  install = run;
};

const downloadWindows = (tag: string): Promise<Result> =>
  new Promise((resolve) => {
    const finish = (result: Result): void => {
      autoUpdater.removeListener('error', onError);
      autoUpdater.removeListener('update-not-available', onCurrent);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      resolve(result);
    };
    const onError = (error: unknown): void =>
      finish({ status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    const onCurrent = (): void =>
      finish({ status: 'failed', detail: 'Squirrel did not recognize the newer release' });
    const onDownloaded = (): void => {
      downloadedVersion = tag.slice(1);
      finish({ status: 'available', detail: downloadedVersion });
    };
    autoUpdater.once('error', onError);
    autoUpdater.once('update-not-available', onCurrent);
    autoUpdater.once('update-downloaded', onDownloaded);
    try {
      autoUpdater.setFeedURL({
        url: `https://github.com/ManuelUsoz/spence/releases/download/${tag}`,
      });
      autoUpdater.checkForUpdates();
    } catch (error) {
      onError(error);
    }
  });

const check = (): Promise<Result> => {
  if (downloadedVersion) return Promise.resolve({ status: 'available', detail: downloadedVersion });
  if (
    !app.isPackaged ||
    !['win32', 'linux'].includes(process.platform) ||
    process.arch !== 'x64' ||
    (process.platform === 'linux' && process.execPath !== '/usr/lib/spence/spence')
  )
    return Promise.resolve({ status: 'unsupported', detail: '' });
  if (pending) return pending;
  const platform = process.platform === 'win32' ? 'win32' : 'linux';
  pending = findUpdate(app.getVersion(), platform)
    .then((release): Promise<Result> =>
      release
        ? platform === 'win32'
          ? downloadWindows(release.tag_name)
          : downloadDeb(release).then((file): Result => {
              debFile = file;
              downloadedVersion = release.tag_name.slice(1);
              return { status: 'available', detail: downloadedVersion };
            })
        : Promise.resolve({ status: 'current', detail: '' }),
    )
    .catch((error: unknown): Result => ({
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      pending = undefined;
    });
  return pending;
};

export const layerUpdateHandlers = UpdateRpcs.toLayer({
  'Update.check': () => Effect.promise(check),
  'Update.install': () =>
    Effect.promise(() => (downloadedVersion ? install() : Promise.resolve(false))),
});
