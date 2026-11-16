import { app, BrowserWindow, dialog, Menu, shell } from 'electron';
import path from 'node:path';
import { isAllowedExternalUrl } from '../src/shared/links/link-policy';
import { AgentLifetime } from './acp/acpLifetime';
import { setSystemLanguages, type Locale } from './i18n/locale';
import { quitConfirm } from './i18n/quit-confirm';
import { DEV_SERVER_URL, loadRenderer, startupLocale } from './i18n/renderer';
import { registerIpc } from './ipc';
import { buildMacMenuTemplate, isBlockedProdKey, isProductionKeysDisabled } from './menu';
import { MainRuntime } from './rpc/runtime';
import { installE2EHook } from './settings/e2e-hook';
import { Settings } from './settings/settings';
import { setTheme, windowBackground } from './settings/window';

/** The e2e harness gives each run its own data directory so it never touches the user's data. */
const e2eUserData = process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_USER_DATA'] : undefined;
if (e2eUserData) app.setPath('userData', e2eUserData);

let mainWindow: BrowserWindow | null = null;

const readSettings = () => MainRuntime.runPromise(Settings.use((settings) => settings.get));

/** Where quitting stands: `asking` while the confirm is up or the Agents stop, `ready` once they are gone. */
let quit: 'idle' | 'asking' | 'ready' = 'idle';

/**
 * Before quitting: if Sessions are still working, asks whether to quit anyway (`false` when the user says no); then
 * cancels their Turns and stops every Agent.
 */
const stopAgents = async (): Promise<boolean> => {
  const working = await MainRuntime.runPromise(AgentLifetime.use((lifetime) => lifetime.working));
  if (working > 0) {
    const { language } = await readSettings();
    const { message, buttons } = quitConfirm(startupLocale(language), working);
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

const createWindow = (locale: Locale): void => {
  mainWindow = new BrowserWindow({
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
  // Windows and Linux: closing the window quits, so it waits for the quit confirm (and stays if the user cancels).
  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' || quit === 'ready') return;
    event.preventDefault();
    app.quit();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

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
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

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
      .then((stopped) => {
        quit = stopped === false ? 'idle' : 'ready';
        if (quit === 'ready') app.quit();
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
