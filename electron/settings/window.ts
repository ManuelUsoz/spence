import { BrowserWindow, nativeTheme } from 'electron';
import { Effect, Layer } from 'effect';
import type { Theme } from '../../src/shared/settings/settings.rpc';
import { localeOf, switchLocale } from '../i18n/renderer';
import { layerStoreUserData } from '../store/store';
import { layerRemembered } from './remembered';
import { layerSettings, WindowSettings } from './settings';

/** The window background before the renderer paints, matching `--background` in src/styles.css. */
const BACKGROUND = { light: '#ffffff', dark: '#0b0d12' } as const;

/** The background for the theme in effect now. */
export const windowBackground = (): string =>
  nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light;

/**
 * Sets the native theme: the renderer follows it through `prefers-color-scheme`, and `system` tracks the OS live.
 * Call before the first window is created so the first paint already has the right colors.
 */
export const setTheme = (theme: Theme): void => {
  nativeTheme.themeSource = theme;
  const background = windowBackground();
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(background);
};

/** Production: the native theme, and a reload of every window into the chosen locale. */
export const layerWindowSettings = Layer.succeed(WindowSettings, {
  applyTheme: (theme) => Effect.sync(() => setTheme(theme)),
  // Not awaited: the reload replaces the page that asked, and the reply must leave before it does.
  applyLanguage: (language) => Effect.sync(() => void switchLocale(localeOf(language))),
});

/** Settings over the store in `<userData>/spence/`, acting on the real windows. */
export const layerSettingsMain = layerSettings.pipe(
  Layer.provide(layerWindowSettings),
  Layer.provideMerge(layerRemembered),
  Layer.provide(layerStoreUserData),
);
