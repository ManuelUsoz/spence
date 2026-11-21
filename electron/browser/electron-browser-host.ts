import { type BrowserWindow, session, shell, WebContentsView } from 'electron';
import { Effect, Layer, Option, PubSub, Queue, Stream } from 'effect';
import { BrowserError, type PageId } from '../../src/shared/browser/browser.rpc';
import {
  isAllowedExternalBrowserUrl,
  isAllowedPopupUrl,
} from '../../src/shared/browser/url-policy';
import { BrowserHost, type BrowserHostEvent, type BrowserHostPresentation } from './browser-host';

export const BROWSER_PARTITION = 'persist:spence-browser';

let activeWindow: BrowserWindow | null = null;
let windowSyncNotify: (() => void) | undefined;

const isAllowedNavigationUrl = (url: string): boolean =>
  url === 'about:blank' || isAllowedPopupUrl(url);

const detachFromWindow = (win: BrowserWindow | null, view: WebContentsView): void => {
  if (win === null || win.isDestroyed()) return;
  if (win.contentView.children.includes(view)) {
    win.contentView.removeChildView(view);
  }
};

/**
 * Registers or clears the active `BrowserWindow` so `ElectronBrowserHost` can attach child `WebContentsView`s
 * cleanly without holding stale destroyed window references.
 */
export const setBrowserWindow = (win: BrowserWindow | null): void => {
  const previous = activeWindow;
  activeWindow = win;
  if (previous !== null && previous !== win && !previous.isDestroyed()) {
    for (const child of [...previous.contentView.children]) {
      if (child instanceof WebContentsView) {
        child.setVisible(false);
        previous.contentView.removeChildView(child);
      }
    }
  }
  windowSyncNotify?.();
};

/** Production `BrowserHost` backed by Electron 45 `WebContentsView` and `persist:spence-browser`. */
export const layerElectronBrowserHost = Layer.effect(
  BrowserHost,
  Effect.gen(function* () {
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);

    const eventInbox = yield* Queue.unbounded<BrowserHostEvent>();
    const syncInbox = yield* Queue.unbounded<void>();
    const eventsHub = yield* PubSub.unbounded<BrowserHostEvent>();
    const views = new Map<PageId, WebContentsView>();
    const intentionallyClosing = new Set<PageId>();
    let lastPresentation: BrowserHostPresentation | null = null;
    let disposed = false;

    const offerEvent = (event: BrowserHostEvent): void => {
      if (!disposed) Queue.offerUnsafe(eventInbox, event);
    };

    const applyPresentation = (presentation: BrowserHostPresentation | null): void => {
      lastPresentation = presentation;
      const win = activeWindow;
      if (win === null || win.isDestroyed()) return;

      for (const [id, view] of views) {
        if (presentation === null || !presentation.visible || presentation.pageId !== id) {
          view.setVisible(false);
          detachFromWindow(win, view);
        }
      }

      if (presentation === null || !presentation.visible) return;
      const target = views.get(presentation.pageId);
      if (target === undefined || target.webContents.isDestroyed()) return;

      const x = Math.round(presentation.bounds.x);
      const y = Math.round(presentation.bounds.y);
      const width = Math.max(0, Math.round(presentation.bounds.width));
      const height = Math.max(0, Math.round(presentation.bounds.height));
      if (width <= 0 || height <= 0) {
        target.setVisible(false);
        detachFromWindow(win, target);
        return;
      }

      if (!win.contentView.children.includes(target)) {
        win.contentView.addChildView(target);
      }
      target.setBounds({ x, y, width, height });
      target.setVisible(true);
    };

    windowSyncNotify = () => {
      if (!disposed) Queue.offerUnsafe(syncInbox, undefined);
    };

    yield* Queue.take(eventInbox).pipe(
      Effect.flatMap((event) => PubSub.publish(eventsHub, event)),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* Queue.take(syncInbox).pipe(
      Effect.flatMap(() => Effect.sync(() => applyPresentation(lastPresentation))),
      Effect.forever,
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        disposed = true;
        windowSyncNotify = undefined;
        for (const [pageId, view] of views) {
          intentionallyClosing.add(pageId);
          detachFromWindow(activeWindow, view);
          if (!view.webContents.isDestroyed()) {
            view.webContents.close({ waitForBeforeUnload: false });
          }
        }
        views.clear();
        lastPresentation = null;
      }),
    );

    const emitSnapshot = (
      pageId: PageId,
      view: WebContentsView,
      overrides?: Partial<{ readonly loading: boolean }>,
    ): void => {
      const wc = view.webContents;
      if (wc.isDestroyed()) return;
      const url = wc.getURL();
      offerEvent({
        _tag: 'PageUpdated',
        pageId,
        url: url === '' ? 'about:blank' : url,
        title: wc.getTitle(),
        loading: overrides?.loading ?? wc.isLoading(),
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
      });
    };

    const createPage = (pageId: PageId, initialUrl: string): Effect.Effect<void> =>
      Effect.sync(() => {
        const view = new WebContentsView({
          webPreferences: {
            partition: BROWSER_PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        const wc = view.webContents;

        wc.setWindowOpenHandler(({ url }) => {
          if (isAllowedPopupUrl(url)) {
            offerEvent({ _tag: 'PopupRequested', openerPageId: pageId, url });
          }
          return { action: 'deny' };
        });

        wc.on('will-navigate', (event, url) => {
          if (!isAllowedNavigationUrl(url)) {
            event.preventDefault();
          }
        });

        wc.on('did-start-loading', () => emitSnapshot(pageId, view, { loading: true }));
        wc.on('did-stop-loading', () => emitSnapshot(pageId, view, { loading: false }));
        wc.on('did-finish-load', () => emitSnapshot(pageId, view));
        wc.on('did-fail-load', (_event, errorCode, _desc, _url, isMainFrame) => {
          if (isMainFrame && errorCode !== -3) {
            emitSnapshot(pageId, view, { loading: false });
          }
        });
        wc.on('did-navigate', () => emitSnapshot(pageId, view));
        wc.on('did-navigate-in-page', () => emitSnapshot(pageId, view));
        wc.on('page-title-updated', () => emitSnapshot(pageId, view));
        wc.on('destroyed', () => {
          views.delete(pageId);
          if (!intentionallyClosing.delete(pageId)) {
            offerEvent({ _tag: 'PageClosed', pageId });
          }
        });

        views.set(pageId, view);
        void wc.loadURL(initialUrl).catch(() => undefined);
      });

    const closePage = (pageId: PageId): Effect.Effect<void> =>
      Effect.sync(() => {
        const view = views.get(pageId);
        if (view === undefined) return;
        intentionallyClosing.add(pageId);
        views.delete(pageId);
        detachFromWindow(activeWindow, view);
        if (!view.webContents.isDestroyed()) {
          view.webContents.close({ waitForBeforeUnload: false });
        }
        if (lastPresentation?.pageId === pageId) {
          lastPresentation = null;
        }
      });

    const loadUrl = (pageId: PageId, url: string): Effect.Effect<void, BrowserError> =>
      Effect.suspend(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) {
          return Effect.fail(
            new BrowserError({ reason: 'PageNotFound', detail: `Unknown Page ${pageId}` }),
          );
        }
        return Effect.sync(() => {
          void view.webContents.loadURL(url).catch(() => undefined);
        });
      });

    const goBack = (pageId: PageId): Effect.Effect<void> =>
      Effect.sync(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) return;
        if (view.webContents.navigationHistory.canGoBack()) {
          view.webContents.navigationHistory.goBack();
        }
      });

    const goForward = (pageId: PageId): Effect.Effect<void> =>
      Effect.sync(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) return;
        if (view.webContents.navigationHistory.canGoForward()) {
          view.webContents.navigationHistory.goForward();
        }
      });

    const reload = (pageId: PageId): Effect.Effect<void> =>
      Effect.sync(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) return;
        view.webContents.reload();
      });

    const setPresentation = (presentation: BrowserHostPresentation | null): Effect.Effect<void> =>
      Effect.sync(() => {
        applyPresentation(presentation);
      });

    const capturePageDataUrl = (pageId: PageId): Effect.Effect<string | undefined> =>
      Effect.suspend(() => {
        const view = views.get(pageId);
        const win = activeWindow;
        if (
          view === undefined ||
          view.webContents.isDestroyed() ||
          win === null ||
          win.isDestroyed() ||
          !win.contentView.children.includes(view) ||
          !view.getVisible()
        ) {
          return Effect.succeed(undefined);
        }
        return Effect.tryPromise({
          try: () => view.webContents.capturePage(),
          catch: () => undefined,
        }).pipe(
          Effect.map((image) => (image.isEmpty() ? undefined : image.toDataURL())),
          Effect.timeoutOption('300 millis'),
          Effect.map(Option.getOrUndefined),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      });

    const openDevTools = (pageId: PageId): Effect.Effect<void, BrowserError> =>
      Effect.suspend(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) {
          return Effect.fail(
            new BrowserError({ reason: 'PageNotFound', detail: `Unknown Page ${pageId}` }),
          );
        }
        return Effect.try({
          try: () => {
            view.webContents.openDevTools({ mode: 'detach' });
          },
          catch: (cause) =>
            new BrowserError({
              reason: 'Unavailable',
              detail: `Could not open DevTools: ${String(cause)}`,
            }),
        });
      });

    const openExternal = (url: string): Effect.Effect<void, BrowserError> =>
      isAllowedExternalBrowserUrl(url)
        ? Effect.tryPromise({
            try: () => shell.openExternal(url),
            catch: (cause) =>
              new BrowserError({
                reason: 'Unavailable',
                detail: `Could not open external browser: ${String(cause)}`,
              }),
          })
        : Effect.fail(
            new BrowserError({
              reason: 'SchemeBlocked',
              detail: 'Only http:// and https:// pages can open in the default browser.',
            }),
          );

    const events = Stream.unwrap(
      PubSub.subscribe(eventsHub).pipe(Effect.map((sub) => Stream.fromSubscription(sub))),
    );

    return BrowserHost.of({
      createPage,
      closePage,
      loadUrl,
      goBack,
      goForward,
      reload,
      setPresentation,
      capturePageDataUrl,
      openDevTools,
      openExternal,
      events,
    });
  }),
);
