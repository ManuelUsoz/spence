import { app, BrowserWindow, Notification } from 'electron';
import { Layer } from 'effect';
import { layerSessionsLive } from '../rpc/sessions';
import { layerSettingsMain } from '../settings/window';
import { layerNotificationDispatcher, layerNotifier, makeOsNotificationChannel } from './notifier';
import { layerSessionVisibility } from './session-visibility';
import { layerTabActivations } from './tab-activations';
import { layerWindowFocus } from './window-focus';

const activeNotifications = new Set<Notification>();

const mainWindow = (): BrowserWindow | null =>
  BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;

export const layerOsNotificationChannel = makeOsNotificationChannel({
  platform: process.platform,
  systemLanguages: () => app.getPreferredSystemLanguages(),
  isFocused: () => mainWindow()?.isFocused() ?? false,
  focusWindow: () => {
    const win = mainWindow();
    if (win === null) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  },
  flashFrame: () => {
    mainWindow()?.flashFrame(true);
  },
  setDockBadge: (badge) => {
    app.dock?.setBadge(badge);
  },
  showNotification: ({ title, body, onClick }) => {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body, silent: true });
    activeNotifications.add(notification);
    notification.on('click', () => {
      activeNotifications.delete(notification);
      onClick();
    });
    notification.on('close', () => {
      activeNotifications.delete(notification);
    });
    notification.show();
  },
}).pipe(Layer.provide(Layer.mergeAll(layerSettingsMain, layerTabActivations)));

/** Shared Worker-backed notification dispatcher wired to OS notifications, visibility, focus, and Settings. */
export const layerNotificationDispatcherLive = layerNotificationDispatcher.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerSettingsMain,
      layerSessionVisibility,
      layerWindowFocus,
      layerOsNotificationChannel,
    ),
  ),
);

/** App-lifetime OS notification watcher wired into `MainRuntime`. */
export const layerNotifierLive = layerNotifier.pipe(
  Layer.provide(Layer.mergeAll(layerSessionsLive, layerNotificationDispatcherLive)),
);
