import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import type { Locale } from './i18n/locale';
import { DEV_SERVER_URL, loadRenderer, startupLocale } from './i18n/renderer';
import { registerIpc } from './ipc';
import { MainRuntime } from './rpc/runtime';
import { installE2EHook } from './settings/e2e-hook';
import { Settings } from './settings/settings';
import { setTheme, windowBackground } from './settings/window';

/** The e2e harness gives each run its own data directory so it never touches the user's data. */
const e2eUserData = process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_USER_DATA'] : undefined;
if (e2eUserData) app.setPath('userData', e2eUserData);

let mainWindow: BrowserWindow | null = null;

const readSettings = () => MainRuntime.runPromise(Settings.use((settings) => settings.get));

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

  // Windows and Linux have no menu bar (spec §9). Without this, Electron's default menu appeared or not depending
  // on whether the window beat it, which changed the content height.
  if (process.platform !== 'darwin') mainWindow.removeMenu();

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // External links open in the user's default browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) {
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

  app.on('before-quit', () => {
    void MainRuntime.dispose();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
