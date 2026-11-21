import {
  type BrowserWindow,
  type Debugger,
  type Event,
  session,
  shell,
  type WebContents,
  WebContentsView,
} from 'electron';
import { Effect, Layer, Option, PubSub, Queue, Schema, Stream } from 'effect';
import {
  type BrowserConsoleError,
  BrowserError,
  type BrowserScreenshotResult,
  type PageId,
  PickedElement,
} from '../../src/shared/browser/browser.rpc';
import {
  isAllowedExternalBrowserUrl,
  isAllowedPopupUrl,
} from '../../src/shared/browser/url-policy';
import { BrowserHost, type BrowserHostEvent, type BrowserHostPresentation } from './browser-host';

export const BROWSER_PARTITION = 'persist:spence-browser';

const PICKER_PICKED_BINDING = '__spenceElementPicked';
const PICKER_CANCELLED_BINDING = '__spencePickerCancelled';

const RuntimeBindingCall = Schema.Struct({
  name: Schema.String,
  payload: Schema.String,
});
const decodeBindingCall = Schema.decodeUnknownOption(RuntimeBindingCall);
const decodePickedElement = Schema.decodeUnknownOption(PickedElement);

const PICKER_INSTALL_SCRIPT = `(() => {
  if (typeof window.__spenceCleanupPicker === 'function') {
    window.__spenceCleanupPicker();
  }
  const root = document.documentElement;
  if (!root) return;

  const prevCursor = root.style.cursor;
  root.style.cursor = 'crosshair';

  const overlay = document.createElement('div');
  overlay.setAttribute('data-spence-picker-overlay', 'true');
  overlay.style.position = 'fixed';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '2147483647';
  overlay.style.border = '2px solid #2563eb';
  overlay.style.background = 'rgba(37, 99, 235, 0.14)';
  overlay.style.borderRadius = '3px';
  overlay.style.boxSizing = 'border-box';
  overlay.style.display = 'none';

  const badge = document.createElement('div');
  badge.style.position = 'absolute';
  badge.style.left = '0';
  badge.style.top = '-20px';
  badge.style.maxWidth = '280px';
  badge.style.overflow = 'hidden';
  badge.style.textOverflow = 'ellipsis';
  badge.style.whiteSpace = 'nowrap';
  badge.style.background = '#2563eb';
  badge.style.color = '#ffffff';
  badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
  badge.style.fontSize = '11px';
  badge.style.lineHeight = '16px';
  badge.style.padding = '1px 6px';
  badge.style.borderRadius = '3px';
  overlay.appendChild(badge);
  root.appendChild(overlay);

  const buildSelector = (el) => {
    if (!(el instanceof Element)) return '';
    if (el.id) {
      const idSel = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(idSel).length === 1) return idSel;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id) {
        const curIdSel = tag + '#' + CSS.escape(cur.id);
        parts.unshift(curIdSel);
        if (document.querySelectorAll(curIdSel).length === 1) break;
      } else {
        let part = tag;
        if (cur.classList && cur.classList.length > 0) {
          const classes = Array.prototype.slice
            .call(cur.classList, 0, 2)
            .filter(Boolean)
            .map((c) => '.' + CSS.escape(c))
            .join('');
          if (classes) part += classes;
        }
        const parent = cur.parentElement;
        if (parent) {
          const sameTag = Array.prototype.filter.call(
            parent.children,
            (c) => c.tagName === cur.tagName,
          );
          if (sameTag.length > 1) {
            part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
          }
        }
        parts.unshift(part);
        if (tag === 'body' || tag === 'html') break;
      }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  const targetOf = (e) => {
    const raw = e.target instanceof Element ? e.target : document.elementFromPoint(e.clientX, e.clientY);
    if (!raw || raw.closest('[data-spence-picker-overlay]')) {
      return document.elementFromPoint(e.clientX, e.clientY);
    }
    return raw;
  };

  const onMove = (e) => {
    const el = targetOf(e);
    if (!(el instanceof Element)) {
      overlay.style.display = 'none';
      return;
    }
    const rect = el.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    badge.style.top = rect.top < 22 ? '2px' : '-20px';
    badge.textContent = buildSelector(el) || el.tagName.toLowerCase();
  };

  const blockEvent = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const cleanup = () => {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('pointerdown', blockEvent, true);
    document.removeEventListener('mousedown', blockEvent, true);
    document.removeEventListener('pointerup', blockEvent, true);
    document.removeEventListener('mouseup', blockEvent, true);
    document.removeEventListener('auxclick', blockEvent, true);
    document.removeEventListener('submit', blockEvent, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    root.style.cursor = prevCursor;
    delete window.__spenceCleanupPicker;
  };

  const onClick = (e) => {
    blockEvent(e);
    const el = targetOf(e) || document.body || root;
    cleanup();
    const selector = buildSelector(el) || el.tagName.toLowerCase();
    const tagName = el.tagName.toLowerCase();
    const rawText = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    const text = rawText.length > 240 ? rawText.slice(0, 237) + '...' : rawText;
    const rawHtml = (el.outerHTML || '').replace(/\\s+/g, ' ').trim();
    const htmlExcerpt = rawHtml.length > 400 ? rawHtml.slice(0, 397) + '...' : rawHtml;
    const notify = window['${PICKER_PICKED_BINDING}'];
    if (typeof notify === 'function') {
      notify(JSON.stringify({ selector, tagName, text, htmlExcerpt }));
    }
  };

  const onKeydown = (e) => {
    if (e.key !== 'Escape') return;
    blockEvent(e);
    cleanup();
    const cancel = window['${PICKER_CANCELLED_BINDING}'];
    if (typeof cancel === 'function') {
      cancel('');
    }
  };

  window.__spenceCleanupPicker = cleanup;
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('pointerdown', blockEvent, true);
  document.addEventListener('mousedown', blockEvent, true);
  document.addEventListener('pointerup', blockEvent, true);
  document.addEventListener('mouseup', blockEvent, true);
  document.addEventListener('auxclick', blockEvent, true);
  document.addEventListener('submit', blockEvent, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
})()`;

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
    const webContentsIds = new Map<number, PageId>();
    const pageWebContentsIds = new Map<PageId, number>();
    const recentNetworkFailures = new Map<PageId, { readonly url: string; readonly at: number }>();
    const activePickers = new Map<
      PageId,
      {
        readonly webContents: WebContents;
        readonly debugger: Debugger;
        readonly attachedByPicker: boolean;
        readonly onMessage: (event: Event, method: string, params: unknown) => void;
        readonly onDetach: () => void;
      }
    >();
    const intentionallyClosing = new Set<PageId>();
    let lastPresentation: BrowserHostPresentation | null = null;
    let disposed = false;

    const offerEvent = (event: BrowserHostEvent): void => {
      if (!disposed) Queue.offerUnsafe(eventInbox, event);
    };

    const teardownPicker = (pageId: PageId, runPageCleanup: boolean): void => {
      const picker = activePickers.get(pageId);
      if (picker === undefined) return;
      activePickers.delete(pageId);
      picker.debugger.off('message', picker.onMessage);
      picker.debugger.off('detach', picker.onDetach);
      if (!picker.webContents.isDestroyed() && picker.debugger.isAttached()) {
        if (runPageCleanup) {
          void picker.debugger
            .sendCommand('Runtime.evaluate', { expression: 'window.__spenceCleanupPicker?.()' })
            .catch(() => undefined);
        }
        void picker.debugger
          .sendCommand('Runtime.removeBinding', { name: PICKER_PICKED_BINDING })
          .catch(() => undefined);
        void picker.debugger
          .sendCommand('Runtime.removeBinding', { name: PICKER_CANCELLED_BINDING })
          .catch(() => undefined);
        if (picker.attachedByPicker) {
          try {
            picker.debugger.detach();
          } catch {
            // Debugger may already be detaching during view destruction.
          }
        }
      }
    };

    const emitConsoleError = (pageId: PageId, error: BrowserConsoleError): void => {
      offerEvent({ _tag: 'ConsoleError', pageId, error });
    };

    browserSession.webRequest.onCompleted((details) => {
      if (details.webContentsId === undefined || details.statusCode < 400) return;
      const pageId = webContentsIds.get(details.webContentsId);
      if (pageId === undefined) return;
      const statusDetail = details.statusLine === '' ? '' : ` (${details.statusLine})`;
      emitConsoleError(pageId, {
        kind: 'network',
        message: `${details.method} ${details.statusCode}${statusDetail}`,
        url: details.url,
        status: details.statusCode,
        at: Date.now(),
      });
    });

    browserSession.webRequest.onErrorOccurred((details) => {
      if (details.webContentsId === undefined || details.error === 'net::ERR_ABORTED') return;
      const pageId = webContentsIds.get(details.webContentsId);
      if (pageId === undefined) return;
      const at = Date.now();
      recentNetworkFailures.set(pageId, { url: details.url, at });
      emitConsoleError(pageId, {
        kind: 'network',
        message: `${details.method} ${details.error}`,
        url: details.url,
        at,
      });
    });

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
        browserSession.webRequest.onCompleted(null);
        browserSession.webRequest.onErrorOccurred(null);
        for (const [pageId, view] of views) {
          teardownPicker(pageId, false);
          intentionallyClosing.add(pageId);
          detachFromWindow(activeWindow, view);
          if (!view.webContents.isDestroyed()) {
            view.webContents.close({ waitForBeforeUnload: false });
          }
        }
        views.clear();
        webContentsIds.clear();
        pageWebContentsIds.clear();
        recentNetworkFailures.clear();
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
        const wcId = wc.id;
        webContentsIds.set(wcId, pageId);
        pageWebContentsIds.set(pageId, wcId);

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
        wc.on('did-fail-load', (_event, errorCode, desc, validatedUrl, isMainFrame) => {
          if (isMainFrame && errorCode !== -3) {
            emitSnapshot(pageId, view, { loading: false });
            const now = Date.now();
            const recent = recentNetworkFailures.get(pageId);
            if (recent === undefined || recent.url !== validatedUrl || now - recent.at > 500) {
              emitConsoleError(pageId, {
                kind: 'network',
                message: desc === '' ? `Failed to load (${errorCode})` : desc,
                ...(validatedUrl === '' ? {} : { url: validatedUrl }),
                at: now,
              });
            }
          }
        });
        wc.on('console-message', (details) => {
          if (details.level !== 'error') return;
          const url =
            details.sourceId === ''
              ? undefined
              : details.lineNumber > 0
                ? `${details.sourceId}:${details.lineNumber}`
                : details.sourceId;
          emitConsoleError(pageId, {
            kind: 'console',
            message: details.message === '' ? 'Console error' : details.message,
            ...(url === undefined ? {} : { url }),
            at: Date.now(),
          });
        });
        wc.on('did-start-navigation', (details) => {
          if (!details.isSameDocument && details.isMainFrame && activePickers.has(pageId)) {
            teardownPicker(pageId, true);
            offerEvent({ _tag: 'ElementPickerCancelled', pageId });
          }
        });
        wc.on('did-navigate', () => emitSnapshot(pageId, view));
        wc.on('did-navigate-in-page', () => emitSnapshot(pageId, view));
        wc.on('page-title-updated', () => emitSnapshot(pageId, view));
        wc.on('destroyed', () => {
          teardownPicker(pageId, false);
          views.delete(pageId);
          webContentsIds.delete(wcId);
          pageWebContentsIds.delete(pageId);
          recentNetworkFailures.delete(pageId);
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
        teardownPicker(pageId, false);
        intentionallyClosing.add(pageId);
        views.delete(pageId);
        const wcId = pageWebContentsIds.get(pageId);
        if (wcId !== undefined) webContentsIds.delete(wcId);
        pageWebContentsIds.delete(pageId);
        recentNetworkFailures.delete(pageId);
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

    const captureScreenshot = (
      pageId: PageId,
    ): Effect.Effect<BrowserScreenshotResult, BrowserError> =>
      Effect.suspend(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) {
          return Effect.fail(
            new BrowserError({ reason: 'PageNotFound', detail: `Unknown Page ${pageId}` }),
          );
        }
        return Effect.tryPromise({
          try: () => view.webContents.capturePage(),
          catch: (cause) =>
            new BrowserError({
              reason: 'CaptureFailed',
              detail: `Could not capture Page screenshot: ${String(cause)}`,
            }),
        }).pipe(
          Effect.flatMap((image) => {
            const png = image.toPNG();
            if (png.length === 0) {
              return Effect.fail(
                new BrowserError({
                  reason: 'CaptureFailed',
                  detail: 'Captured screenshot image was empty.',
                }),
              );
            }
            return Effect.succeed({
              name: 'browser-screenshot.png',
              mimeType: 'image/png' as const,
              data: png.toString('base64'),
            });
          }),
        );
      });

    const startElementPicker = (pageId: PageId): Effect.Effect<void, BrowserError> =>
      Effect.suspend(() => {
        const view = views.get(pageId);
        if (view === undefined || view.webContents.isDestroyed()) {
          return Effect.fail(
            new BrowserError({ reason: 'PageNotFound', detail: `Unknown Page ${pageId}` }),
          );
        }
        const wc = view.webContents;
        const dbg = wc.debugger;
        return Effect.tryPromise({
          try: async () => {
            teardownPicker(pageId, true);
            let attachedByPicker = false;
            if (!dbg.isAttached()) {
              dbg.attach('1.3');
              attachedByPicker = true;
            }
            const onMessage = (_event: Event, method: string, params: unknown) => {
              if (method !== 'Runtime.bindingCalled') return;
              const call = decodeBindingCall(params);
              if (Option.isNone(call)) return;
              if (call.value.name === PICKER_PICKED_BINDING) {
                teardownPicker(pageId, false);
                try {
                  const parsed: unknown = JSON.parse(call.value.payload);
                  const element = decodePickedElement(parsed);
                  if (Option.isSome(element)) {
                    offerEvent({ _tag: 'ElementPicked', pageId, element: element.value });
                    return;
                  }
                } catch {
                  // Fall through to cancellation if payload could not be parsed.
                }
                offerEvent({ _tag: 'ElementPickerCancelled', pageId });
              } else if (call.value.name === PICKER_CANCELLED_BINDING) {
                teardownPicker(pageId, false);
                offerEvent({ _tag: 'ElementPickerCancelled', pageId });
              }
            };
            const onDetach = () => {
              if (!activePickers.has(pageId)) return;
              teardownPicker(pageId, false);
              offerEvent({ _tag: 'ElementPickerCancelled', pageId });
            };
            activePickers.set(pageId, {
              webContents: wc,
              debugger: dbg,
              attachedByPicker,
              onMessage,
              onDetach,
            });
            dbg.on('message', onMessage);
            dbg.on('detach', onDetach);
            await dbg.sendCommand('Runtime.enable');
            await dbg.sendCommand('Runtime.addBinding', { name: PICKER_PICKED_BINDING });
            await dbg.sendCommand('Runtime.addBinding', { name: PICKER_CANCELLED_BINDING });
            await dbg.sendCommand('Runtime.evaluate', {
              expression: PICKER_INSTALL_SCRIPT,
              returnByValue: true,
            });
          },
          catch: (cause) =>
            new BrowserError({
              reason: 'Unavailable',
              detail: `Could not start element picker: ${String(cause)}`,
            }),
        }).pipe(Effect.tapError(() => Effect.sync(() => teardownPicker(pageId, false))));
      });

    const cancelElementPicker = (pageId: PageId): Effect.Effect<void> =>
      Effect.sync(() => {
        teardownPicker(pageId, true);
      });

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
      openDevTools,
      openExternal,
      captureScreenshot,
      startElementPicker,
      cancelElementPicker,
      events,
    });
  }),
);
