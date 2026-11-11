import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { e2eLocale, type Locale, pickLocale } from './locale';

/** The Angular dev server serves one locale only (English unless started with `dev:es`). */
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL'];

/** The stored Language Setting. Not stored yet: the Settings issue wires the real value. */
const readStoredLocale = (): Locale | undefined => undefined;

/** The locale to open the app in. Call after `app` is ready. */
export const startupLocale = (): Locale =>
  pickLocale({
    override: e2eLocale(process.env) ?? readStoredLocale(),
    systemLanguages: app.getPreferredSystemLanguages(),
  });

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
