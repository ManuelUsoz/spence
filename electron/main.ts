import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { MainRuntime } from './rpc/runtime';

/**
 * In development the Angular dev server is used so we get HMR and source maps.
 * In production the app loads the static build from `dist/renderer`.
 */
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

/** Keeps the first paint close to the app background (see src/styles.css). */
const BACKGROUND = '#0b0d12';

/** The e2e harness gives each run its own data directory so it never touches the user's data. */
const e2eUserData = process.env['SPENCE_E2E'] === '1' ? process.env['SPENCE_USER_DATA'] : undefined;
if (e2eUserData) app.setPath('userData', e2eUserData);

let mainWindow: BrowserWindow | null = null;

const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false, // avoid the white flash, show once the renderer is ready
    title: 'Spence',
    backgroundColor: BACKGROUND,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // Security defaults: renderer has no Node access and runs in its own context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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

  if (DEV_SERVER_URL) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/renderer/index.html'));
  }
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

  void app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.spence.app');
    }

    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
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
