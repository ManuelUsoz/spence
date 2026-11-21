import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream } from 'effect';
import {
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_WIDTH,
  type BrowserBounds,
  PageId,
} from '../../src/shared/browser/browser.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { makeFakeBrowserHost } from './browser-host-fake';
import { BrowserService, layerBrowserService } from './browser-service';

const s1 = SessionId.make('session-1');
const s2 = SessionId.make('session-2');
const bounds: BrowserBounds = { x: 520, y: 48, width: 480, height: 752 };

const withBrowser = <A, E, R>(
  body: (fake: ReturnType<typeof makeFakeBrowserHost>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = makeFakeBrowserHost();
    const layer = layerBrowserService.pipe(Layer.provide(fake.layer));
    return yield* body(fake).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

describe('BrowserService', () => {
  it.effect('returns idle closed defaults before a Session opens the Browser', () =>
    withBrowser(() =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const state = yield* service.getState(s1);
        expect(state).toEqual({
          sessionId: s1,
          open: false,
          width: BROWSER_DEFAULT_WIDTH,
          pages: [],
          activePageId: null,
          control: { _tag: 'idle' },
          pickerActive: false,
          occluded: false,
        });
      }),
    ),
  );

  it.effect('creates a single initial about:blank Page on first open and emits state events', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const eventsFiber = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        const opened = yield* service.setOpen(s1, true);
        expect(opened.open).toBe(true);
        expect(opened.pages).toHaveLength(1);
        const page = opened.pages[0];
        expect(page?.url).toBe('about:blank');
        expect(opened.activePageId).toBe(page?.id);
        expect(fake.createdPages.map((p) => p.pageId)).toEqual([page?.id]);

        const collected = yield* Fiber.join(eventsFiber);
        const first = collected[0];
        expect(first).toEqual({ _tag: 'State', state: opened });

        // Re-opening does not create a second page.
        yield* service.setOpen(s1, false);
        const reopened = yield* service.setOpen(s1, true);
        expect(reopened.pages).toHaveLength(1);
        expect(reopened.activePageId).toBe(page?.id);
      }),
    ),
  );

  it.effect('clamps pane width to 320..960 px', () =>
    withBrowser(() =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        expect((yield* service.setWidth(s1, 100)).width).toBe(BROWSER_MIN_WIDTH);
        expect((yield* service.setWidth(s1, 1400)).width).toBe(BROWSER_MAX_WIDTH);
        expect((yield* service.setWidth(s1, 612.4)).width).toBe(612);
      }),
    ),
  );

  it.effect(
    'attaches presentation only for the active open local Session with non-zero bounds',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const state1 = yield* service.setOpen(s1, true);
          const page1 = state1.activePageId;
          expect(fake.currentPresentation).toBeNull();

          yield* service.setBounds(s1, bounds);
          yield* service.setActiveSession(s1);
          expect(fake.currentPresentation).toEqual({
            pageId: page1,
            bounds,
            visible: true,
          });

          // Switching to a closed session or null hides the native view while preserving open state.
          yield* service.setActiveSession(s2);
          expect(fake.currentPresentation).toBeNull();
          expect((yield* service.getState(s1)).open).toBe(true);

          yield* service.setActiveSession(null);
          expect(fake.currentPresentation).toBeNull();

          yield* service.setActiveSession(s1);
          expect(fake.currentPresentation).toEqual({
            pageId: page1,
            bounds,
            visible: true,
          });

          yield* service.setOpen(s1, false);
          expect(fake.currentPresentation).toBeNull();
        }),
      ),
  );

  it.effect(
    'normalizes navigation URLs, rejects blocked/invalid URLs, and tracks host page updates',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const opened = yield* service.setOpen(s1, true);
          const pageId = opened.activePageId;
          if (pageId === null) return yield* Effect.die('expected activePageId');

          const nav = yield* service.navigate(s1, 'localhost:4200/dashboard');
          expect(nav.pages[0]?.url).toBe('http://localhost:4200/dashboard');
          expect(fake.loadedUrls).toEqual([{ pageId, url: 'http://localhost:4200/dashboard' }]);

          const blocked = yield* service.navigate(s1, 'javascript:alert(1)').pipe(Effect.flip);
          expect(blocked).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });

          const invalid = yield* service.navigate(s1, 'not a url').pipe(Effect.flip);
          expect(invalid).toMatchObject({ _tag: 'BrowserError', reason: 'InvalidUrl' });

          const updatedFiber = yield* service.events.pipe(
            Stream.filter(
              (event) =>
                event._tag === 'State' &&
                event.state.sessionId === s1 &&
                event.state.pages[0]?.title === 'Dashboard',
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          fake.emitHostEvent({
            _tag: 'PageUpdated',
            pageId,
            url: 'http://localhost:4200/dashboard',
            title: 'Dashboard',
            loading: false,
            canGoBack: true,
            canGoForward: false,
          });
          yield* Fiber.join(updatedFiber);

          const updated = yield* service.getState(s1);
          expect(updated.pages[0]).toMatchObject({
            id: pageId,
            url: 'http://localhost:4200/dashboard',
            title: 'Dashboard',
            loading: false,
            canGoBack: true,
            canGoForward: false,
          });

          yield* service.goBack(s1);
          yield* service.goForward(s1);
          yield* service.reload(s1);
          expect(fake.commands).toEqual([
            { kind: 'goBack', pageId },
            { kind: 'goForward', pageId },
            { kind: 'reload', pageId },
          ]);
        }),
      ),
  );

  it.effect('opens DevTools and validates URL before opening in external browser', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const noPageErr = yield* service.openDevTools(s1).pipe(Effect.flip);
        expect(noPageErr).toMatchObject({ _tag: 'BrowserError', reason: 'NoActivePage' });

        yield* service.setOpen(s1, true);
        const blankExternal = yield* service.openExternal(s1).pipe(Effect.flip);
        expect(blankExternal).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });

        yield* service.navigate(s1, 'https://example.com/docs');
        yield* service.openExternal(s1);
        yield* service.openDevTools(s1);

        expect(fake.externalUrls).toEqual(['https://example.com/docs']);
        expect(fake.devToolsOpenedFor).toEqual([(yield* service.getState(s1)).activePageId]);
      }),
    ),
  );

  it.effect('closes host views and drops Session state on onSessionDeleted', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const state = yield* service.setOpen(s1, true);
        const pageId = state.activePageId;
        if (pageId === null) return yield* Effect.die('expected activePageId');
        yield* service.setBounds(s1, bounds);
        yield* service.setActiveSession(s1);
        expect(fake.currentPresentation?.pageId).toBe(pageId);

        yield* service.onSessionDeleted(s1);

        expect(fake.closedPages).toEqual([pageId]);
        expect(fake.currentPresentation).toBeNull();
        expect((yield* service.getState(s1)).pages).toEqual([]);
      }),
    ),
  );

  it.effect(
    'creates ordered Pages with createPage, validates optional URLs, and switches presentation',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setBounds(s1, bounds);
          yield* service.setActiveSession(s1);
          const first = yield* service.setOpen(s1, true);
          const p1 = first.pages[0]?.id;
          if (p1 === undefined) return yield* Effect.die('expected initial page');

          const second = yield* service.createPage(s1);
          expect(second.pages).toHaveLength(2);
          const p2 = second.pages[1]?.id;
          if (p2 === undefined) return yield* Effect.die('expected second page');
          expect(second.pages.map((p) => p.id)).toEqual([p1, p2]);
          expect(second.pages[1]?.url).toBe('about:blank');
          expect(second.activePageId).toBe(p2);
          expect(fake.currentPresentation?.pageId).toBe(p2);

          const third = yield* service.createPage(s1, 'localhost:3000/login');
          expect(third.pages).toHaveLength(3);
          const p3 = third.pages[2]?.id;
          if (p3 === undefined) return yield* Effect.die('expected third page');
          expect(third.pages[2]?.url).toBe('http://localhost:3000/login');
          expect(third.activePageId).toBe(p3);
          expect(fake.createdPages).toContainEqual({
            pageId: p3,
            initialUrl: 'http://localhost:3000/login',
          });

          const blocked = yield* service.createPage(s1, 'javascript:alert(1)').pipe(Effect.flip);
          expect(blocked).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          expect((yield* service.getState(s1)).pages).toHaveLength(3);
        }),
      ),
  );

  it.effect('switches active Page with selectPage and rejects unknown or foreign PageIds', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        yield* service.setBounds(s1, bounds);
        yield* service.setActiveSession(s1);
        const s1Initial = yield* service.setOpen(s1, true);
        const p1 = s1Initial.pages[0]?.id;
        const s1Second = yield* service.createPage(s1, 'https://example.com/two');
        const p2 = s1Second.pages[1]?.id;
        if (p1 === undefined || p2 === undefined) return yield* Effect.die('expected pages');

        const s2Other = yield* service.setOpen(s2, true);
        const foreignPage = s2Other.pages[0]?.id;
        if (foreignPage === undefined) return yield* Effect.die('expected foreign page');

        expect(fake.currentPresentation?.pageId).toBe(p2);

        const selected = yield* service.selectPage(s1, p1);
        expect(selected.activePageId).toBe(p1);
        expect(fake.currentPresentation).toEqual({ pageId: p1, bounds, visible: true });

        yield* service.navigate(s1, 'https://example.com/one');
        expect(fake.loadedUrls.at(-1)).toEqual({ pageId: p1, url: 'https://example.com/one' });

        const missingErr = yield* service
          .selectPage(s1, PageId.make('missing-page'))
          .pipe(Effect.flip);
        expect(missingErr).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });

        const foreignErr = yield* service.selectPage(s1, foreignPage).pipe(Effect.flip);
        expect(foreignErr).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });
      }),
    ),
  );

  it.effect(
    'closes Pages, selects an adjacent remaining Page, and leaves open empty state when the last Page closes',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setBounds(s1, bounds);
          yield* service.setActiveSession(s1);
          const s1One = yield* service.setOpen(s1, true);
          const s1Two = yield* service.createPage(s1, 'https://example.com/2');
          const s1Three = yield* service.createPage(s1, 'https://example.com/3');
          const s1Four = yield* service.createPage(s1, 'https://example.com/4');
          const p1 = s1One.pages[0]?.id;
          const p2 = s1Two.pages[1]?.id;
          const p3 = s1Three.pages[2]?.id;
          const p4 = s1Four.pages[3]?.id;
          if (!p1 || !p2 || !p3 || !p4) return yield* Effect.die('expected 4 pages');

          // Select p2 and close inactive p4 -> stays on p2.
          yield* service.selectPage(s1, p2);
          const afterInactiveClose = yield* service.closePage(s1, p4);
          expect(afterInactiveClose.pages.map((p) => p.id)).toEqual([p1, p2, p3]);
          expect(afterInactiveClose.activePageId).toBe(p2);
          expect(fake.closedPages).toEqual([p4]);
          expect(fake.currentPresentation?.pageId).toBe(p2);

          // Close active middle p2 -> advances to right neighbor p3.
          const afterMiddleClose = yield* service.closePage(s1, p2);
          expect(afterMiddleClose.pages.map((p) => p.id)).toEqual([p1, p3]);
          expect(afterMiddleClose.activePageId).toBe(p3);
          expect(fake.currentPresentation?.pageId).toBe(p3);

          // Close active rightmost p3 -> falls back to left neighbor p1.
          const afterRightClose = yield* service.closePage(s1, p3);
          expect(afterRightClose.pages.map((p) => p.id)).toEqual([p1]);
          expect(afterRightClose.activePageId).toBe(p1);
          expect(fake.currentPresentation?.pageId).toBe(p1);

          // Close last remaining Page p1 -> open stays true with 0 Pages and detached presentation.
          const afterLastClose = yield* service.closePage(s1, p1);
          expect(afterLastClose.open).toBe(true);
          expect(afterLastClose.pages).toEqual([]);
          expect(afterLastClose.activePageId).toBeNull();
          expect(fake.currentPresentation).toBeNull();
          expect(fake.closedPages).toEqual([p4, p2, p3, p1]);

          const missingErr = yield* service.closePage(s1, p1).pipe(Effect.flip);
          expect(missingErr).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });
        }),
      ),
  );

  it.live(
    'routes allowed PopupRequested events to a new Page in the opener Session and rejects disallowed schemes',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setBounds(s1, bounds);
          yield* service.setBounds(s2, bounds);
          const s1State = yield* service.setOpen(s1, true);
          const s2State = yield* service.setOpen(s2, true);
          const p1 = s1State.pages[0]?.id;
          const p2 = s2State.pages[0]?.id;
          if (!p1 || !p2) return yield* Effect.die('expected initial pages');
          yield* service.setActiveSession(s1);

          const popupFiber = yield* service.events.pipe(
            Stream.filter(
              (event): event is Extract<typeof event, { readonly _tag: 'State' }> =>
                event._tag === 'State' &&
                event.state.sessionId === s1 &&
                event.state.pages.length === 2,
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout('1 second'),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          // Disallowed schemes must be ignored.
          fake.emitHostEvent({
            _tag: 'PopupRequested',
            openerPageId: p1,
            url: 'javascript:alert(1)',
          });
          fake.emitHostEvent({
            _tag: 'PopupRequested',
            openerPageId: p1,
            url: 'file:///etc/passwd',
          });
          fake.emitHostEvent({
            _tag: 'PopupRequested',
            openerPageId: p1,
            url: 'about:blank',
          });
          fake.emitHostEvent({
            _tag: 'PopupRequested',
            openerPageId: p1,
            url: 'https://accounts.example.com/oauth',
          });

          const collected = yield* Fiber.join(popupFiber);
          const afterPopup = collected[0]?.state;
          expect(afterPopup?.pages).toHaveLength(2);
          const popupPage = afterPopup?.pages[1];
          expect(popupPage?.url).toBe('https://accounts.example.com/oauth');
          expect(afterPopup?.activePageId).toBe(popupPage?.id);
          expect(fake.currentPresentation?.pageId).toBe(popupPage?.id);

          // Background Session popup updates s2 without stealing s1's presentation.
          const bgFiber = yield* service.events.pipe(
            Stream.filter(
              (event): event is Extract<typeof event, { readonly _tag: 'State' }> =>
                event._tag === 'State' &&
                event.state.sessionId === s2 &&
                event.state.pages.length === 2,
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout('1 second'),
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          fake.emitHostEvent({
            _tag: 'PopupRequested',
            openerPageId: p2,
            url: 'http://127.0.0.1:4100/popup',
          });

          const bgCollected = yield* Fiber.join(bgFiber);
          const s2After = bgCollected[0]?.state;
          expect(s2After?.pages[1]?.url).toBe('http://127.0.0.1:4100/popup');
          expect(s2After?.activePageId).toBe(s2After?.pages[1]?.id);
          expect(fake.currentPresentation?.pageId).toBe(popupPage?.id);
        }),
      ),
  );

  it.effect('isolates Pages, active selection, width, and open state across Sessions', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const bounds2: BrowserBounds = { x: 420, y: 48, width: 600, height: 752 };
        yield* service.setBounds(s1, bounds);
        yield* service.setBounds(s2, bounds2);

        const s1Init = yield* service.setOpen(s1, true);
        yield* service.navigate(s1, 'https://session-one.example/a');
        const s1Two = yield* service.createPage(s1, 'https://session-one.example/b');
        const s1P1 = s1Init.pages[0]?.id;
        const s1P2 = s1Two.pages[1]?.id;
        if (!s1P1 || !s1P2) return yield* Effect.die('expected s1 pages');
        yield* service.setWidth(s1, 520);

        const s2Init = yield* service.setOpen(s2, true);
        yield* service.navigate(s2, 'https://session-two.example/x');
        const s2Two = yield* service.createPage(s2, 'https://session-two.example/y');
        const s2P1 = s2Init.pages[0]?.id;
        const s2P2 = s2Two.pages[1]?.id;
        if (!s2P1 || !s2P2) return yield* Effect.die('expected s2 pages');
        yield* service.selectPage(s2, s2P1);
        yield* service.setWidth(s2, 640);

        yield* service.setActiveSession(s1);
        expect(fake.currentPresentation).toEqual({ pageId: s1P2, bounds, visible: true });

        yield* service.setActiveSession(s2);
        expect(fake.currentPresentation).toEqual({
          pageId: s2P1,
          bounds: bounds2,
          visible: true,
        });

        yield* service.closePage(s2, s2P1);
        expect(fake.currentPresentation).toEqual({
          pageId: s2P2,
          bounds: bounds2,
          visible: true,
        });

        // s1 remains completely untouched while s2 changed.
        const s1Check = yield* service.getState(s1);
        expect(s1Check.open).toBe(true);
        expect(s1Check.width).toBe(520);
        expect(s1Check.pages.map((p) => p.url)).toEqual([
          'https://session-one.example/a',
          'https://session-one.example/b',
        ]);
        expect(s1Check.activePageId).toBe(s1P2);

        yield* service.setActiveSession(s1);
        expect(fake.currentPresentation).toEqual({ pageId: s1P2, bounds, visible: true });
      }),
    ),
  );

  it.effect(
    'captures a PNG screenshot of the active Page and fails with NoActivePage otherwise',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const missing = yield* service.captureScreenshot(s1).pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: 'BrowserError', reason: 'NoActivePage' });

          const opened = yield* service.setOpen(s1, true);
          const pageId = opened.activePageId;
          if (pageId === null) return yield* Effect.die('expected activePageId');
          fake.setScreenshot(pageId, {
            name: 'browser-screenshot.png',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
          });

          const shot = yield* service.captureScreenshot(s1);
          expect(shot).toEqual({
            name: 'browser-screenshot.png',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
          });
        }),
      ),
  );

  it.effect(
    'collects bounded per-Page console and failed network errors isolated across Sessions',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const missing = yield* service.getConsoleErrors(s1).pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: 'BrowserError', reason: 'NoActivePage' });

          const s1State = yield* service.setOpen(s1, true);
          const s2State = yield* service.setOpen(s2, true);
          const p1 = s1State.activePageId;
          const p2 = s2State.activePageId;
          if (p1 === null || p2 === null) return yield* Effect.die('expected activePageIds');

          expect(yield* service.getConsoleErrors(s1)).toEqual({ errors: [] });

          for (let i = 1; i <= 55; i++) {
            fake.emitHostEvent({
              _tag: 'ConsoleError',
              pageId: p1,
              error: {
                kind: 'console',
                message: `err-${i}`,
                url: 'http://localhost:3000/app.js:10',
                at: i,
              },
            });
          }
          fake.emitHostEvent({
            _tag: 'ConsoleError',
            pageId: p1,
            error: {
              kind: 'network',
              message: 'GET 500',
              url: 'http://localhost:3000/api/fail',
              status: 500,
              at: 56,
            },
          });
          fake.emitHostEvent({
            _tag: 'ConsoleError',
            pageId: p2,
            error: {
              kind: 'console',
              message: 'other-session-error',
              at: 100,
            },
          });

          const waitForErrors = (sessionId: typeof s1, expectedCount: number) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 50; attempt++) {
                const res = yield* service.getConsoleErrors(sessionId);
                if (res.errors.length >= expectedCount) return res;
                yield* Effect.yieldNow;
              }
              return yield* service.getConsoleErrors(sessionId);
            });

          const s1Errors = yield* waitForErrors(s1, 50);
          expect(s1Errors.errors).toHaveLength(50);
          expect(s1Errors.errors[0]?.message).toBe('err-7');
          expect(s1Errors.errors.at(-1)).toMatchObject({
            kind: 'network',
            message: 'GET 500',
            status: 500,
          });

          const s2Errors = yield* waitForErrors(s2, 1);
          expect(s2Errors.errors).toEqual([
            { kind: 'console', message: 'other-session-error', at: 100 },
          ]);

          yield* service.onSessionDeleted(s1);
          fake.emitHostEvent({ _tag: 'PageClosed', pageId: p2 });
          yield* Effect.yieldNow;
          const reopened = yield* service.setOpen(s1, true);
          expect(reopened.activePageId).not.toBe(p1);
          expect(yield* service.getConsoleErrors(s1)).toEqual({ errors: [] });
        }),
      ),
  );

  it.effect(
    'starts, completes, and cancels interactive Element picker with clean state transitions',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const missing = yield* service.startElementPicker(s1).pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: 'BrowserError', reason: 'NoActivePage' });

          const opened = yield* service.setOpen(s1, true);
          const pageId = opened.activePageId;
          if (pageId === null) return yield* Effect.die('expected activePageId');

          const pickedFiber = yield* service.events.pipe(
            Stream.filter((event) => event._tag === 'ElementPicked'),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          const started = yield* service.startElementPicker(s1);
          expect(started.pickerActive).toBe(true);
          expect(fake.pickerActions).toEqual([{ kind: 'start', pageId }]);

          fake.emitHostEvent({
            _tag: 'ElementPicked',
            pageId,
            element: {
              selector: 'button#save',
              tagName: 'button',
              text: 'Save',
              htmlExcerpt: '<button id="save">Save</button>',
            },
          });

          const pickedEvents = yield* Fiber.join(pickedFiber);
          expect(pickedEvents[0]).toEqual({
            _tag: 'ElementPicked',
            sessionId: s1,
            element: {
              selector: 'button#save',
              tagName: 'button',
              text: 'Save',
              htmlExcerpt: '<button id="save">Save</button>',
            },
          });
          expect((yield* service.getState(s1)).pickerActive).toBe(false);

          yield* service.startElementPicker(s1);
          const cancelled = yield* service.cancelElementPicker(s1);
          expect(cancelled.pickerActive).toBe(false);
          expect(fake.pickerActions).toEqual([
            { kind: 'start', pageId },
            { kind: 'start', pageId },
            { kind: 'cancel', pageId },
          ]);

          // Host cancellation (Escape in WebContentsView) and closing pane also reset pickerActive.
          yield* service.startElementPicker(s1);
          fake.emitHostEvent({ _tag: 'ElementPickerCancelled', pageId });
          for (let attempt = 0; attempt < 20; attempt++) {
            if (!(yield* service.getState(s1)).pickerActive) break;
            yield* Effect.yieldNow;
          }
          expect((yield* service.getState(s1)).pickerActive).toBe(false);

          yield* service.startElementPicker(s1);
          const closed = yield* service.setOpen(s1, false);
          expect(closed.pickerActive).toBe(false);
          expect(fake.pickerActions.at(-1)).toEqual({ kind: 'cancel', pageId });
        }),
      ),
  );

  it.effect(
    'captures lastFrameDataUrl, detaches presentation on setOccluded(true), preserves hidden state across Session switches, and restores on setOccluded(false)',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const state1 = yield* service.setOpen(s1, true);
          const page1 = state1.activePageId;
          if (page1 === null) return yield* Effect.die('expected activePageId');
          yield* service.setBounds(s1, bounds);
          yield* service.setActiveSession(s1);

          const state2 = yield* service.setOpen(s2, true);
          const page2 = state2.activePageId;
          if (page2 === null) return yield* Effect.die('expected activePageId');
          yield* service.setBounds(s2, bounds);

          fake.setFrameDataUrl(page1, 'data:image/png;base64,frame1');
          fake.setFrameDataUrl(page2, 'data:image/png;base64,frame2');

          const eventsFiber = yield* service.events.pipe(
            Stream.filter(
              (event): event is Extract<typeof event, { readonly _tag: 'State' }> =>
                event._tag === 'State' && event.state.sessionId === s1,
            ),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          // Occluding captures the live frame and hides the native view.
          yield* service.setOccluded(true);
          expect(fake.currentPresentation).toBeNull();
          expect(fake.capturedPageIds).toEqual([page1]);
          expect(yield* service.getState(s1)).toMatchObject({
            occluded: true,
            lastFrameDataUrl: 'data:image/png;base64,frame1',
          });

          // Switching active Sessions while occluded keeps the native view hidden.
          yield* service.setActiveSession(s2);
          expect(fake.currentPresentation).toBeNull();
          expect((yield* service.getState(s2)).occluded).toBe(true);

          // Restoring clears lastFrameDataUrl and immediately attaches the now-active Session's view.
          yield* service.setOccluded(false);
          expect(fake.currentPresentation).toEqual({
            pageId: page2,
            bounds,
            visible: true,
          });
          expect(yield* service.getState(s1)).toMatchObject({ occluded: false });
          expect((yield* service.getState(s1)).lastFrameDataUrl).toBeUndefined();
          expect(yield* service.getState(s2)).toMatchObject({ occluded: false });

          const events = [...(yield* Fiber.join(eventsFiber))];
          expect(events[0]?.state).toMatchObject({
            occluded: true,
            lastFrameDataUrl: 'data:image/png;base64,frame1',
          });
          expect(events[1]?.state.occluded).toBe(false);
          expect(events[1]?.state.lastFrameDataUrl).toBeUndefined();
        }),
      ),
  );

  it.effect('skips frame capture when captureFrame is false or no view is presented', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        const state1 = yield* service.setOpen(s1, true);
        const page1 = state1.activePageId;
        if (page1 === null) return yield* Effect.die('expected activePageId');
        fake.setFrameDataUrl(page1, 'data:image/png;base64,frame1');
        yield* service.setBounds(s1, bounds);
        yield* service.setActiveSession(s1);

        yield* service.setOccluded(true, false);
        expect(fake.capturedPageIds).toEqual([]);
        expect(fake.currentPresentation).toBeNull();
        expect(yield* service.getState(s1)).toMatchObject({ occluded: true });
        expect((yield* service.getState(s1)).lastFrameDataUrl).toBeUndefined();

        yield* service.setOccluded(false);
        expect(fake.currentPresentation).toEqual({ pageId: page1, bounds, visible: true });
      }),
    ),
  );

  describe('Agent MCP capabilities', () => {
    it.effect('rejects Agent actions on Remote Sessions with RemoteUnsupported', () =>
      withBrowser(() =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setSessionDevice(s1, 'peer-device-1');

          const navErr = yield* service
            .agentNavigate(s1, 'http://localhost:3000/')
            .pipe(Effect.flip);
          expect(navErr).toMatchObject({ _tag: 'BrowserError', reason: 'RemoteUnsupported' });

          const listErr = yield* service.agentListPages(s1).pipe(Effect.flip);
          expect(listErr).toMatchObject({ _tag: 'BrowserError', reason: 'RemoteUnsupported' });

          const snapErr = yield* service.agentSnapshot(s1).pipe(Effect.flip);
          expect(snapErr).toMatchObject({ _tag: 'BrowserError', reason: 'RemoteUnsupported' });
        }),
      ),
    );

    it.effect('isolates Pages across Sessions and blocks dangerous Agent URLs', () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const nav1 = yield* service.agentNavigate(s1, 'http://127.0.0.1:4100/app');
          expect(nav1.url).toBe('http://127.0.0.1:4100/app');
          expect(fake.loadedUrls).toEqual([
            { pageId: nav1.pageId, url: 'http://127.0.0.1:4100/app' },
          ]);

          // Session 2 cannot target Session 1's Page.
          const foreignSnap = yield* service.agentSnapshot(s2, nav1.pageId).pipe(Effect.flip);
          expect(foreignSnap).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });

          const foreignClose = yield* service.agentClosePage(s2, nav1.pageId).pipe(Effect.flip);
          expect(foreignClose).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });

          // Blocked schemes and embedded credentials are rejected.
          const fileErr = yield* service.agentNavigate(s1, 'file:///etc/passwd').pipe(Effect.flip);
          expect(fileErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });

          const credErr = yield* service
            .agentNavigate(s1, 'https://user:pass@example.com/')
            .pipe(Effect.flip);
          expect(credErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
        }),
      ),
    );

    it.effect('captures all console levels and redacts network logs per Page', () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const page = yield* service.agentCreatePage(s1, 'http://localhost:3000/');
          const other = yield* service.agentCreatePage(s2, 'http://localhost:3000/other');

          fake.emitHostEvent({
            _tag: 'ConsoleEntry',
            pageId: page.id,
            entry: { level: 'info', message: 'booted', at: 1 },
          });
          fake.emitHostEvent({
            _tag: 'ConsoleEntry',
            pageId: page.id,
            entry: { level: 'warning', message: 'deprecated api', at: 2 },
          });
          fake.emitHostEvent({
            _tag: 'ConsoleEntry',
            pageId: other.id,
            entry: { level: 'error', message: 'other-session', at: 3 },
          });
          fake.emitHostEvent({
            _tag: 'NetworkEntry',
            pageId: page.id,
            entry: {
              id: 10,
              method: 'GET',
              url: 'https://alice:secret@api.example.com/items?token=tok123&page=1',
              resourceType: 'xhr',
              status: 200,
              requestHeaders: {
                Authorization: 'Bearer raw-jwt',
                Accept: 'application/json',
              },
              responseHeaders: {
                'Set-Cookie': ['sid=secret-cookie'],
                'Content-Type': ['application/json'],
              },
              at: 10,
            },
          });

          for (let i = 0; i < 20; i++) {
            const c = yield* service.agentConsole(s1, { pageId: page.id });
            const n = yield* service.agentNetwork(s1, { pageId: page.id });
            if (c.entries.length === 2 && n.entries.length === 1) break;
            yield* Effect.yieldNow;
          }

          const allConsole = yield* service.agentConsole(s1, { pageId: page.id });
          expect(allConsole.entries).toHaveLength(2);
          expect(allConsole.entries.map((e) => e.message)).toEqual(['booted', 'deprecated api']);

          const warnOnly = yield* service.agentConsole(s1, {
            pageId: page.id,
            level: 'warning',
          });
          expect(warnOnly.entries.map((e) => e.message)).toEqual(['deprecated api']);

          const network = yield* service.agentNetwork(s1, { pageId: page.id });
          expect(network.entries).toHaveLength(1);
          const req = network.entries[0];
          expect(req?.url).not.toContain('alice');
          expect(req?.url).not.toContain('secret');
          expect(req?.url).not.toContain('tok123');
          expect(req?.url).toContain('page=1');
          expect(req?.requestHeaders).toEqual({
            Authorization: '[REDACTED]',
            Accept: 'application/json',
          });
          expect(req?.responseHeaders).toEqual({
            'Set-Cookie': '[REDACTED]',
            'Content-Type': 'application/json',
          });
        }),
      ),
    );

    it.effect(
      'delegates snapshot, interactions, waitFor, eval, and screenshot to BrowserHost',
      () =>
        withBrowser((fake) =>
          Effect.gen(function* () {
            const service = yield* BrowserService;
            const page = yield* service.agentCreatePage(s1, 'http://localhost:3000/');
            fake.setSnapshot(page.id, {
              pageId: page.id,
              url: 'http://localhost:3000/',
              title: 'App',
              snapshot: '- RootWebArea "App"\n  - button "Go" [ref=e1]',
              refCount: 1,
            });
            fake.setEvalResult(page.id, { value: { count: 2 }, type: 'object' });

            const snap = yield* service.agentSnapshot(s1);
            expect(snap.snapshot).toContain('[ref=e1]');

            yield* service.agentClick(s1, { ref: 'e1' });
            yield* service.agentFill(s1, { selector: '#name' }, 'Alice');
            yield* service.agentType(s1, 'Hello', { ref: 'e1' });
            yield* service.agentPress(s1, 'Enter', { ref: 'e1' });
            yield* service.agentSelect(s1, { selector: '#role' }, ['admin']);
            yield* service.agentHover(s1, { ref: 'e1' });
            yield* service.agentScroll(s1, { direction: 'down', amount: 300 });
            yield* service.agentWaitFor(s1, { text: 'Done', timeoutMs: 2000 });
            const evaluated = yield* service.agentEval(s1, 'window.__state');
            const shot = yield* service.agentScreenshot(s1);

            expect(evaluated).toEqual({ value: { count: 2 }, type: 'object' });
            expect(shot.mimeType).toBe('image/png');
            expect(fake.interactions.map((i) => i.kind)).toEqual([
              'click',
              'fill',
              'type',
              'press',
              'select',
              'hover',
              'scroll',
            ]);
            expect(fake.waits).toEqual([
              { pageId: page.id, condition: { text: 'Done', timeoutMs: 2000 } },
            ]);
            expect(fake.evals).toEqual([{ pageId: page.id, expression: 'window.__state' }]);
          }),
        ),
    );
  });
});
