import { Effect, Fiber, Stream } from 'effect';
import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import { isAllowedExternalUrl } from '../src/shared/links/link-policy';
import { AgentLifetime } from './acp/acpLifetime';
import { afterLastWindow, onWindowClose, showsTray } from './hosting/resident';
import { showTray } from './hosting/tray';
import { setSystemLanguages, type Locale } from './i18n/locale';
import { quitConfirm } from './i18n/quit-confirm';
import { DEV_SERVER_URL, loadRenderer, startupLocale } from './i18n/renderer';
import { registerIpc } from './ipc';
import { Hosting } from './lan/hosting';
import { Viewers } from './lan/viewers';
import { buildMacMenuTemplate, isBlockedProdKey, isProductionKeysDisabled } from './menu';
import { MainRuntime } from './rpc/runtime';
import { installE2EHook } from './settings/e2e-hook';
import { Settings } from './settings/settings';
import { setTheme, windowBackground } from './settings/window';
import { Updates } from './updates/updater';

/** The e2e harness gives each run its own data directory so it never touches the user's data. */
const e2eUserData = process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_USER_DATA'] : undefined;
if (e2eUserData) app.setPath('userData', e2eUserData);

let mainWindow: BrowserWindow | null = null;

const readSettings = () => MainRuntime.runPromise(Settings.use((settings) => settings.get));

/** Where quitting stands: `asking` while the confirm is up or the Agents stop, `ready` once they are gone. */
let quit: 'idle' | 'asking' | 'ready' = 'idle';

/** Whether this Device serves other Devices now (resident mode), as Hosting last said. */
let hosting = false;
/** The tray item while it is shown. */
let tray: Fiber.Fiber<never> | null = null;

const resident = () => ({ platform: process.platform, hosting });

/**
 * Before quitting: if Turns run on this Device (Remote-started ones too) or Remote devices are connected to it, asks
 * whether to quit anyway (`false` when the user says no); then cancels the Turns and stops every Agent.
 */
const stopAgents = async (): Promise<boolean> => {
  const stakes = await MainRuntime.runPromise(
    Effect.all({
      working: AgentLifetime.use((lifetime) => lifetime.working),
      viewers: Viewers.use((viewers) => viewers.count),
    }),
  );
  const { language } = await readSettings();
  const confirm = quitConfirm(startupLocale(language), stakes);
  if (confirm !== null) {
    const { message, buttons } = confirm;
    const options = {
      type: 'question' as const,
      message,
      buttons: [...buttons],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = await (mainWindow
      ? dialog.showMessageBox(mainWindow, options)
      : dialog.showMessageBox(options));
    if (response !== 0) return false;
  }
  await MainRuntime.runPromise(AgentLifetime.use((lifetime) => lifetime.quit));
  return true;
};

const triggerSettings = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  // Dispatch Cmd+, directly into the renderer so no shortcut crosses DesktopRpcs (spec §9).
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: ',', modifiers: ['meta'] });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: ',', modifiers: ['meta'] });
};

/** Shows the window again: focuses it, or opens one when the Device was resident with none. */
const openWindow = (): void => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    return;
  }
  void readSettings().then((settings) => createWindow(startupLocale(settings.language)));
};

/** Shows the tray item while hosting with no window open, and only then. */
const syncTray = (): void => {
  const wanted = showsTray({ hosting, windows: mainWindow === null ? 0 : 1 });
  if (wanted && tray === null) {
    const shown = readSettings().then((settings) =>
      MainRuntime.runFork(
        Effect.scoped(
          Effect.andThen(
            showTray(startupLocale(settings.language), {
              open: openWindow,
              quit: () => app.quit(),
            }),
            Effect.never,
          ),
        ),
      ),
    );
    void shown.then((fiber) => {
      tray = fiber;
      // The window may have come back (or hosting gone) while Settings were read.
      if (!showsTray({ hosting, windows: mainWindow === null ? 0 : 1 })) syncTray();
    });
  } else if (!wanted && tray !== null) {
    const shown = tray;
    tray = null;
    void MainRuntime.runPromise(Fiber.interrupt(shown));
  }
};

/** Follows whether this Device hosts: resident mode and the tray depend on it. */
const followHosting = (): void => {
  MainRuntime.runFork(
    Hosting.use((service) =>
      Stream.runForEach(service.serving, (on) =>
        Effect.sync(() => {
          hosting = on;
          syncTray();
          // Hosting stopped while resident with no window: nothing is left to keep the app running.
          if (mainWindow === null && afterLastWindow(resident()) === 'quit') app.quit();
        }),
      ),
    ),
  );
};

const createWindow = (locale: Locale): void => {
  mainWindow = new BrowserWindow({
    icon: path.join(app.getAppPath(), 'build', 'icon.png'),
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false, // avoid the white flash, show once the renderer is ready
    title: 'Spence',
    // Keeps the first paint close to the background of the theme in effect (see src/styles.css).
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security defaults: renderer has no Node access and runs in its own context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const prodKeysDisabled = isProductionKeysDisabled(app.isPackaged, process.env);
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMacMenuTemplate({
          appName: app.name,
          locale,
          includeDevItems: !prodKeysDisabled,
          onSettings: triggerSettings,
        }),
      ),
    );
  } else {
    Menu.setApplicationMenu(null);
    // Windows and Linux have no menu bar (spec §9). Without this, Electron's default menu appeared or not depending
    // on whether the window beat it, which changed the content height.
    mainWindow.removeMenu();
  }

  if (prodKeysDisabled) {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (isBlockedProdKey(input, process.platform)) event.preventDefault();
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false);
    if (process.platform === 'darwin') app.dock?.setBadge('');
  });
  // Windows and Linux without hosting: closing the window quits, so it waits for the quit confirm (and stays if the
  // user cancels). A hosting Device just closes it and stays resident: closing a window never asks.
  mainWindow.on('close', (event) => {
    if (quit === 'ready' || onWindowClose(resident()) === 'close') return;
    event.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    syncTray();
  });
  syncTray();

  // External links open in the user's default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Block navigation away from the renderer we control.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = DEV_SERVER_URL ?? 'file://';
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault();
    }
  });

  void loadRenderer(mainWindow, locale);
  if (DEV_SERVER_URL) mainWindow.webContents.openDevTools({ mode: 'detach' });
};

// Only a single instance of the app may run; focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openWindow);

  void app.whenReady().then(async () => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.spence.app');
    }
    setSystemLanguages(app.getPreferredSystemLanguages());

    registerIpc();
    installE2EHook();
    // Theme and Language are applied before the first window exists, so its first paint is already right.
    const { theme, language } = await readSettings();
    setTheme(theme);
    createWindow(startupLocale(language));
    followHosting();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void readSettings().then((settings) => createWindow(startupLocale(settings.language)));
      }
    });
  });

  app.on('before-quit', (event) => {
    if (quit === 'ready') {
      void MainRuntime.dispose();
      return;
    }
    // Agents must stop first; quitting resumes once they are gone, or not at all if the user cancels.
    event.preventDefault();
    if (quit === 'asking') return;
    quit = 'asking';
    void stopAgents()
      .catch((error: unknown) => console.error('Stopping the Agents failed', error))
      .then(async (stopped) => {
        if (stopped !== true) {
          await MainRuntime.runPromise(Updates.use((updates) => updates.cancelRestart));
          quit = 'idle';
          return;
        }
        // A verified update is installed only here, after the Agents stopped and the user chose to restart.
        // An ordinary quit leaves it pending because nothing was prepared.
        const relaunch = await MainRuntime.runPromise(
          Updates.use((updates) => updates.applyPending),
        ).catch((error: unknown) => {
          console.error('Applying the update failed', error);
          return null;
        });
        if (relaunch === null) {
          quit = 'idle';
          return;
        }
        quit = 'ready';
        if (relaunch) app.relaunch();
        app.quit();
      });
  });

  // A hosting Device stays resident (tray) after its last window closes; otherwise only macOS stays.
  app.on('window-all-closed', () => {
    if (afterLastWindow(resident()) === 'quit') app.quit();
  });
}
