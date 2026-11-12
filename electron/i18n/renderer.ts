import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import type { Language } from '../../src/shared/settings/settings.rpc';
import { e2eLocale, type Locale, pickLocale } from './locale';

/**
 * In development the Angular dev server is used so we get HMR and source maps; it serves one locale only (English
 * unless started with `dev:es`). In production the app loads the static build of one locale from
 * `dist/renderer/<locale>`.
 */
export const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

/** The locale the Language Setting resolves to on this machine. Call after `app` is ready. */
export const localeOf = (language: Language): Locale =>
  pickLocale({
    override: language === 'system' ? undefined : language,
    systemLanguages: app.getPreferredSystemLanguages(),
  });

/** The locale to open the app in: the one an e2e run pins, else the Language Setting's. */
export const startupLocale = (language: Language): Locale =>
  e2eLocale(process.env) ?? localeOf(language);

/** Loads the renderer build of `locale` (`dist/renderer/<locale>/index.html`), or the dev server. */
export const loadRenderer = (window: BrowserWindow, locale: Locale): Promise<void> =>
  DEV_SERVER_URL
    ? window.loadURL(DEV_SERVER_URL)
    : window.loadFile(path.join(__dirname, '../dist/renderer', locale, 'index.html'));

/**
 * Reloads every window into the build of `locale`. The handshake hands the new page a fresh port,
 * so the RPC connection survives the reload; renderer state does not.
 */
export const switchLocale = async (locale: Locale): Promise<void> => {
  await Promise.all(BrowserWindow.getAllWindows().map((window) => loadRenderer(window, locale)));
};
