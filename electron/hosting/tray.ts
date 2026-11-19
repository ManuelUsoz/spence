import { Effect, Stream } from 'effect';
import { Menu, nativeImage, Tray } from 'electron';
import type { Locale } from '../i18n/locale';
import { trayCopy } from '../i18n/tray';
import { Viewers } from '../lan/viewers';

/** A ring with a dot, black for the macOS menu bar (a template image the OS tints). */
const TEMPLATE_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABKUlEQVR4nO2XwQ3CMAxFn9R7F8gYnYFTF6gYoSMgdQMOdJnee2QAtmCA3kBIrmRZJE0LyAjxJV8iO7aTb8eBP9ajBHZAC3QirayVn3TcAANwW5BBdN+GR2bnDMdWzmL7Ejqz6RXogRoIQCESZK0XHW3TbXV+MhsdxNkSCtHVtqe1znXmF6DakEAltqtPYmechw3OZwQTRBYnNOG2ZG5RGWIm0Zg7fxc0J5IlOii2pwi3B0ZgEhllLYZCVccQUypVlH1is2Oi9o8Ju17pPe2Ymnx1ZJN9RgOKnUS9RMZWKcSYP2YEMEZsg9Jpnyno2o/d/5QRwBSxLZZ6gnsA7lfgTkL3MsS7EfENrRjvx4hveI7xHkhmuI5kM1yH0hmuY7mG28fEwu1r9pu4AwQ1DrRpE/F/AAAAAElFTkSuQmCC';

/** The same mark in a mid grey, readable on light and dark Windows and Linux taskbars. */
const COLOR_ICON =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABQklEQVR4nM2XwQ2DMAxFI/XOAozBDD2xAOoIjFAJ6Q/gQ1mGO0cG6BYdgBtVJUey0sTQUOoe/iWy45fkOwQHkLOUafFcgAKgM0AtQB2r5bHiSIAGoAGgZUUDx34N4LWyaUPhUBPn7gLogkkfAPUA1QCVAJ1YJY/1HCNzulyAWzDRlYutQZ84VubePgWQK78DVGWYteJcdSdSZy6LlxnFvcoA4s0TsSRpuJyVx3ZCGlMFaIIz31vcS3qi0QAG4XbNcBeARoBm1shjmjF9dwwpgEJQ9spkpPQ+KXm9iCtiANJ8tbLytQsotRN1zIwyoBUBKeePGwBGpSN8TBsDkL2fOv95A8Cs+ODtTvgrAPMjMDeheRs664vI/cNV7Kw/RqEZTT7HzvpB4mX6JIvtxPLrR6n0hNmzXMrsxySU2a/ZITIHeALYzT8Oh9SkmAAAAABJRU5ErkJggg==';

const icon = () => {
  const darwin = process.platform === 'darwin';
  const image = nativeImage
    .createFromBuffer(Buffer.from(darwin ? TEMPLATE_ICON : COLOR_ICON, 'base64'))
    .resize({ width: darwin ? 16 : 32, height: darwin ? 16 : 32 });
  if (darwin) image.setTemplateImage(true);
  return image;
};

export interface TrayActions {
  /** Open Spence: a window again. */
  readonly open: () => void;
  /** Quit: the explicit quit, which may ask first. */
  readonly quit: () => void;
}

/**
 * The tray (menu-bar on macOS) item of a resident Device, for the life of the scope: Open Spence, a one-line
 * "Serving N Remote devices" kept up to date, and Quit. Nothing else: no notifications, no badge.
 */
export const showTray = Effect.fnUntraced(function* (locale: Locale, actions: TrayActions) {
  const viewers = yield* Viewers;
  const tray = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const created = new Tray(icon());
      created.setToolTip('Spence');
      created.on('click', actions.open);
      return created;
    }),
    (created) => Effect.sync(() => created.destroy()),
  );
  yield* viewers.changes.pipe(
    Stream.map((connected) => connected.length),
    Stream.changes,
    Stream.runForEach((serving) =>
      Effect.sync(() => {
        const copy = trayCopy(locale, serving);
        tray.setContextMenu(
          Menu.buildFromTemplate([
            { label: copy.open, click: actions.open },
            { label: copy.status, enabled: false },
            { type: 'separator' },
            { label: copy.quit, click: actions.quit },
          ]),
        );
      }),
    ),
    Effect.forkScoped,
  );
});
