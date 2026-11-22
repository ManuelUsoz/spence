import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_WIDTH,
  type BrowserBounds,
  type BrowserError,
  PageId,
} from '../../src/shared/browser/browser.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { AgentLifetime } from '../acp/acpLifetime';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, Settings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { makeFakeBrowserHost } from './browser-host-fake';
import { type BrowserOriginDecision, BrowserService, layerBrowserService } from './browser-service';
import { BrowserStore, layerBrowserStore } from './browser-store';

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
    it.effect(
      'rejects ALL RPC-facing BrowserService methods on Remote Sessions with RemoteUnsupported',
      () =>
        withBrowser(() =>
          Effect.gen(function* () {
            const service = yield* BrowserService;
            const initial = yield* service.setOpen(s1, true);
            const pageId = initial.activePageId!;
            yield* service.setSessionDevice(s1, 'peer-device-1');

            const rpcCalls: ReadonlyArray<Effect.Effect<unknown, BrowserError>> = [
              service.getState(s1),
              service.setOpen(s1, false),
              service.setWidth(s1, 600),
              service.navigate(s1, 'http://localhost:3000/'),
              service.goBack(s1),
              service.goForward(s1),
              service.reload(s1),
              service.openExternal(s1),
              service.openDevTools(s1),
              service.createPage(s1, 'http://localhost:3000/'),
              service.selectPage(s1, pageId),
              service.closePage(s1, pageId),
              service.captureScreenshot(s1),
              service.startElementPicker(s1),
              service.cancelElementPicker(s1),
              service.getConsoleErrors(s1),
              service.takeOver(s1),
              service.continueAgent(s1),
            ];
            for (const call of rpcCalls) {
              const err = yield* call.pipe(Effect.flip);
              expect(err).toMatchObject({ _tag: 'BrowserError', reason: 'RemoteUnsupported' });
            }
          }),
        ),
    );

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

const withRoot = <A, E>(body: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-browser-svc-'))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  ).pipe(Effect.flatMap(body), Effect.scoped);

const makeWorkingLifetimeLayer = (working: ReadonlySet<SessionId>) =>
  Layer.succeed(
    AgentLifetime,
    AgentLifetime.of({
      tabOpened: () => Effect.void,
      tabActivated: () => Effect.die('unused'),
      tabClosed: () => Effect.void,
      setWorkflowHold: () => Effect.void,
      turnStarted: () => Effect.die('unused'),
      turnEnded: () => Effect.void,
      replace: () => Effect.die('unused'),
      otherWorking: () => Effect.succeed([]),
      killAgent: () => Effect.die('unused'),
      markCancelPending: () => Effect.void,
      markCancelSettled: () => Effect.void,
      exitGateState: () => Effect.succeed({ clear: true }),
      subscribeExitConfirmed: Effect.die('unused'),
      working: Effect.sync(() => working.size),
      workingSessions: Effect.sync(() => new Set(working)),
      workingChanges: Stream.succeed(working.size),
      quit: Effect.void,
    }),
  );

const withPersistedBrowser = <A, E, R>(
  root: string,
  working: ReadonlySet<SessionId>,
  body: (fake: ReturnType<typeof makeFakeBrowserHost>) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = makeFakeBrowserHost();
    const storeLayer = layerBrowserStore.pipe(Layer.provide(layerStore(root)));
    const lifetimeLayer = makeWorkingLifetimeLayer(working);
    const serviceLayer = layerBrowserService.pipe(
      Layer.provide(fake.layer),
      Layer.provideMerge(storeLayer),
      Layer.provide(lifetimeLayer),
    );
    return yield* body(fake).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.scoped);

describe('BrowserService persistence, LRU cap & clearData', () => {
  it.effect(
    'persists state per Session, restores lazily as suspended, and wakes Pages transparently on view or select',
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          let p1!: PageId;
          let p2!: PageId;

          // First run: open s1 with two pages and s2 with one page, then simulate restart.
          yield* withPersistedBrowser(root, new Set(), (fake) =>
            Effect.gen(function* () {
              const service = yield* BrowserService;
              const opened = yield* service.setOpen(s1, true);
              p1 = opened.activePageId!;
              yield* service.setWidth(s1, 640);
              yield* service.navigate(s1, 'http://localhost:3000/one');
              fake.emitHostEvent({ _tag: 'PageUpdated', pageId: p1, title: 'One' });

              const created = yield* service.createPage(s1, 'http://localhost:3000/two');
              p2 = created.activePageId!;
              fake.emitHostEvent({ _tag: 'PageUpdated', pageId: p2, title: 'Two' });
              yield* Effect.yieldNow;

              yield* service.selectPage(s1, p1);
              yield* service.setOpen(s2, true);
              yield* service.navigate(s2, 'https://example.com');
            }),
          );

          // Second run: nothing is loaded or created until accessed.
          yield* withPersistedBrowser(root, new Set(), (fake) =>
            Effect.gen(function* () {
              const service = yield* BrowserService;
              const store = yield* BrowserStore;
              expect(fake.createdPages).toEqual([]);

              // getState restores lazily from Store with all Pages suspended and zero views created.
              const restored = yield* service.getState(s1);
              expect(restored.open).toBe(true);
              expect(restored.width).toBe(640);
              expect(restored.activePageId).toBe(p1);
              expect(restored.pages).toMatchObject([
                { id: p1, url: 'http://localhost:3000/one', title: 'One', suspended: true },
                { id: p2, url: 'http://localhost:3000/two', title: 'Two', suspended: true },
              ]);
              expect(fake.createdPages).toEqual([]);

              // Viewing s1 wakes only the active Page (p1); p2 stays suspended until selected.
              yield* service.setBounds(s1, bounds);
              yield* service.setActiveSession(s1);
              expect(fake.createdPages).toEqual([
                { pageId: p1, initialUrl: 'http://localhost:3000/one' },
              ]);
              expect(fake.currentPresentation).toEqual({ pageId: p1, bounds, visible: true });

              const afterView = yield* service.getState(s1);
              expect(afterView.pages[0]?.suspended).toBe(false);
              expect(afterView.pages[1]?.suspended).toBe(true);

              // Selecting p2 wakes p2 transparently at its saved URL.
              const selected = yield* service.selectPage(s1, p2);
              expect(selected.pages[1]?.suspended).toBe(false);
              expect(fake.createdPages).toEqual([
                { pageId: p1, initialUrl: 'http://localhost:3000/one' },
                { pageId: p2, initialUrl: 'http://localhost:3000/two' },
              ]);
              expect(fake.currentPresentation).toEqual({ pageId: p2, bounds, visible: true });

              // Deleting s2 removes its persisted browser.json as well.
              yield* service.onSessionDeleted(s2);
              expect(yield* store.read(s2)).toBeUndefined();
            }),
          );
        }),
      ),
  );

  it.effect(
    'enforces an LRU cap of 5 live background Pages while never evicting active or Working Sessions',
    () =>
      withRoot((root) =>
        Effect.gen(function* () {
          const working = new Set<SessionId>();
          const sWorking = SessionId.make('session-working');
          const bgSessions = Array.from({ length: 7 }, (_, i) => SessionId.make(`bg-${i + 1}`));
          const active = SessionId.make('session-active');

          yield* withPersistedBrowser(root, working, (fake) =>
            Effect.gen(function* () {
              const service = yield* BrowserService;

              // Working Session opens a Page and stays protected even as the oldest Session.
              working.add(sWorking);
              const wState = yield* service.setOpen(sWorking, true);
              const wPage = wState.activePageId!;
              yield* service.navigate(sWorking, 'http://localhost:3000/working');
              fake.emitHostEvent({ _tag: 'PageUpdated', pageId: wPage, title: 'Working App' });
              yield* Effect.yieldNow;

              // Create 6 background Sessions (bg-1..bg-6) with 1 live Page each.
              const bgPages: Array<PageId> = [];
              for (let i = 0; i < 6; i++) {
                const sid = bgSessions[i]!;
                yield* service.setActiveSession(sid);
                const st = yield* service.setOpen(sid, true);
                const pid = st.activePageId!;
                bgPages.push(pid);
                yield* service.navigate(sid, `http://localhost:300${i}/page`);
                fake.emitHostEvent({ _tag: 'PageUpdated', pageId: pid, title: `BG ${i + 1}` });
                yield* Effect.yieldNow;
              }

              // Switch active Session to `active`: now bg-1..bg-6 are ALL background (6 > 5), plus sWorking (protected).
              // Oldest idle background Page (bg-1) MUST be evicted, while sWorking and bg-2..bg-6 stay live.
              yield* service.setActiveSession(active);
              yield* service.setOpen(active, true);
              yield* service.setBounds(active, bounds);

              expect((yield* service.getState(sWorking)).pages[0]?.suspended).toBe(false);
              expect((yield* service.getState(bgSessions[0]!)).pages[0]).toMatchObject({
                id: bgPages[0],
                url: 'http://localhost:3000/page',
                title: 'BG 1',
                suspended: true,
              });
              expect(fake.closedPages).toEqual([bgPages[0]]);
              for (let i = 1; i < 6; i++) {
                expect((yield* service.getState(bgSessions[i]!)).pages[0]?.suspended).toBe(false);
              }
              expect((yield* service.getState(active)).pages[0]?.suspended).toBe(false);

              // Touching bg-2 makes bg-3 the oldest idle background Page; opening bg-7 evicts bg-3, not bg-2.
              yield* service.setActiveSession(bgSessions[1]!);
              yield* service.setActiveSession(bgSessions[6]!);
              const bg7State = yield* service.setOpen(bgSessions[6]!, true);
              expect(bg7State.pages[0]?.suspended).toBe(false);

              yield* service.setActiveSession(active);
              expect((yield* service.getState(bgSessions[1]!)).pages[0]?.suspended).toBe(false);
              expect((yield* service.getState(bgSessions[2]!)).pages[0]?.suspended).toBe(true);
              expect((yield* service.getState(sWorking)).pages[0]?.suspended).toBe(false);
              expect((yield* service.getState(active)).pages[0]?.suspended).toBe(false);

              // Switching back to evicted bg-1 reloads it transparently at its retained URL.
              const prevCreatedCount = fake.createdPages.length;
              yield* service.setActiveSession(bgSessions[0]!);
              expect((yield* service.getState(bgSessions[0]!)).pages[0]?.suspended).toBe(false);
              expect(fake.createdPages.slice(prevCreatedCount)).toEqual([
                { pageId: bgPages[0], initialUrl: 'http://localhost:3000/page' },
              ]);
            }),
          );
        }),
      ),
  );

  it.effect('re-runs LRU eviction in onTurnEnded when a Working Session finishes its Turn', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        const working = new Set<SessionId>();
        const sWorking = SessionId.make('session-working-evict');
        const bgSessions = Array.from({ length: 4 }, (_, i) => SessionId.make(`bg-evict-${i + 1}`));
        const active = SessionId.make('session-active-evict');

        yield* withPersistedBrowser(root, working, (fake) =>
          Effect.gen(function* () {
            const service = yield* BrowserService;

            // Working Session opens 3 Pages while protected by Working status.
            working.add(sWorking);
            const w1 = (yield* service.createPage(sWorking, 'http://localhost:3001/1'))
              .activePageId!;
            const w2 = (yield* service.createPage(sWorking, 'http://localhost:3001/2'))
              .activePageId!;
            yield* service.createPage(sWorking, 'http://localhost:3001/3');

            // 4 idle background Sessions open 1 Page each -> 4 non-working bg Pages (<= 5 cap).
            for (let i = 0; i < bgSessions.length; i++) {
              yield* service.createPage(bgSessions[i]!, `http://localhost:300${i + 2}/bg`);
            }
            yield* service.setActiveSession(active);
            yield* service.setOpen(active, true);
            expect(fake.closedPages).toEqual([]);

            // When the Working Session finishes its Turn, 7 background Pages > 5 -> oldest 2 (w1, w2) are evicted.
            working.delete(sWorking);
            yield* service.onTurnEnded(sWorking);
            expect(fake.closedPages).toEqual([w1, w2]);
            const after = yield* service.getState(sWorking);
            expect(after.pages.map((p) => p.suspended)).toEqual([true, true, false]);
          }),
        );
      }),
    ),
  );

  it.effect('clearData delegates to BrowserHost.clearBrowsingData', () =>
    withBrowser((fake) =>
      Effect.gen(function* () {
        const service = yield* BrowserService;
        expect(fake.clearDataCount).toBe(0);
        yield* service.clearData();
        expect(fake.clearDataCount).toBe(1);
      }),
    ),
  );

  it.effect('materializes a suspended persisted Page transparently on Agent snapshot', () =>
    withRoot((root) =>
      Effect.gen(function* () {
        let p1!: PageId;
        yield* withPersistedBrowser(root, new Set(), () =>
          Effect.gen(function* () {
            const service = yield* BrowserService;
            const nav = yield* service.agentNavigate(s1, 'http://localhost:3000/persisted');
            p1 = nav.pageId;
          }),
        );

        yield* withPersistedBrowser(root, new Set(), (fake) =>
          Effect.gen(function* () {
            const service = yield* BrowserService;
            expect((yield* service.getState(s1)).pages[0]?.suspended).toBe(true);
            expect(fake.createdPages).toEqual([]);

            yield* service.agentSnapshot(s1, p1);
            expect(fake.createdPages).toEqual([
              { pageId: p1, initialUrl: 'http://localhost:3000/persisted' },
            ]);
            expect((yield* service.getState(s1)).pages[0]?.suspended).toBe(false);
          }),
        );
      }),
    ),
  );
});

const withBrowserAndSettings = <A, E>(
  body: (ctx: {
    readonly fake: ReturnType<typeof makeFakeBrowserHost>;
    readonly service: typeof BrowserService.Service;
    readonly settings: typeof Settings.Service;
  }) => Effect.Effect<A, E>,
) =>
  withRoot((root) =>
    Effect.gen(function* () {
      const fake = makeFakeBrowserHost();
      const storeLayer = layerStore(root);
      const settingsLayer = layerSettings.pipe(
        Layer.provide(layerRemembered.pipe(Layer.provide(storeLayer))),
        Layer.provide(
          Layer.succeed(WindowSettings, {
            applyTheme: () => Effect.void,
            applyLanguage: () => Effect.void,
          }),
        ),
        Layer.provide(storeLayer),
      );
      const serviceLayer = layerBrowserService.pipe(
        Layer.provide(fake.layer),
        Layer.provide(settingsLayer),
      );
      return yield* Effect.gen(function* () {
        const service = yield* BrowserService;
        const settings = yield* Settings;
        return yield* body({ fake, service, settings });
      }).pipe(Effect.provide(Layer.mergeAll(serviceLayer, settingsLayer)));
    }),
  );

describe('BrowserService URL safety guardrails & origin permissions', () => {
  it.effect(
    'permanently blocks non-HTTP(S) schemes regardless of permission mode on targets and current Page URLs',
    () =>
      withBrowserAndSettings(({ fake, service }) =>
        Effect.gen(function* () {
          const prompted: Array<string> = [];
          yield* service.setOriginPermissionHandler({
            requestPermission: ({ origin }) =>
              Effect.sync(() => {
                prompted.push(origin);
                return 'allow-always' satisfies BrowserOriginDecision;
              }),
          });

          for (const mode of ['auto', 'ask'] as const) {
            yield* service.setSessionPermissionMode(s1, mode);
            for (const bad of [
              'file:///etc/passwd',
              'chrome://settings',
              'javascript:alert(1)',
              'data:text/html,<h1>hi</h1>',
              'about:blank',
            ]) {
              const navErr = yield* service.agentNavigate(s1, bad).pipe(Effect.flip);
              expect(navErr, `${mode} navigate ${bad}`).toMatchObject({
                _tag: 'BrowserError',
                reason: 'SchemeBlocked',
              });
              const createErr = yield* service.agentCreatePage(s1, bad).pipe(Effect.flip);
              expect(createErr, `${mode} create ${bad}`).toMatchObject({
                _tag: 'BrowserError',
                reason: 'SchemeBlocked',
              });
            }
          }

          // A Page whose current URL is a non-HTTP(S) non-blank scheme cannot be observed or evaluated either.
          const opened = yield* service.setOpen(s1, true);
          const pageId = opened.activePageId!;
          fake.emitHostEvent({ _tag: 'PageUpdated', pageId, url: 'file:///etc/passwd' });
          yield* service.events.pipe(
            Stream.filter(
              (event) =>
                event._tag === 'State' &&
                event.state.sessionId === s1 &&
                event.state.pages[0]?.url === 'file:///etc/passwd',
            ),
            Stream.take(1),
            Stream.runCollect,
          );
          const snapErr = yield* service.agentSnapshot(s1).pipe(Effect.flip);
          expect(snapErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          const evalErr = yield* service.agentEval(s1, '1+1').pipe(Effect.flip);
          expect(evalErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          const consoleErr = yield* service.agentConsole(s1).pipe(Effect.flip);
          expect(consoleErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          const networkErr = yield* service.agentNetwork(s1).pipe(Effect.flip);
          expect(networkErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          const backErr = yield* service.agentBack(s1).pipe(Effect.flip);
          expect(backErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
          expect(fake.evals).toEqual([]);
          expect(prompted).toEqual([]);
        }),
      ),
  );

  it.effect('auto-allows loopback in Auto mode and prompts in Ask mode', () =>
    withBrowserAndSettings(({ service }) =>
      Effect.gen(function* () {
        const prompts: Array<{ readonly origin: string; readonly kind: string }> = [];
        let decision: BrowserOriginDecision = 'deny';
        yield* service.setOriginPermissionHandler({
          requestPermission: ({ origin, kind }) =>
            Effect.sync(() => {
              prompts.push({ origin, kind });
              return decision;
            }),
        });

        // Auto mode allows localhost, 127.0.0.1, and [::1] without prompting.
        yield* service.setSessionPermissionMode(s1, 'auto');
        yield* service.agentNavigate(s1, 'http://localhost:3000/one');
        yield* service.agentNavigate(s1, 'http://127.0.0.1:4200/two');
        yield* service.agentNavigate(s1, 'http://[::1]:5173/three');
        expect(prompts).toEqual([]);

        // Switching to Ask mode requires permission for loopback origins.
        yield* service.setSessionPermissionMode(s1, 'ask');
        const denied = yield* service
          .agentNavigate(s1, 'http://localhost:3000/secret')
          .pipe(Effect.flip);
        expect(denied).toMatchObject({ _tag: 'BrowserError', reason: 'PermissionDenied' });
        expect(prompts).toEqual([{ origin: 'http://localhost:3000', kind: 'loopback' }]);

        decision = 'allow-session';
        yield* service.agentNavigate(s1, 'http://localhost:3000/allowed');
        // Approved for this Session, so subsequent calls on the same origin do not re-prompt.
        yield* service.agentSnapshot(s1);
        expect(prompts).toHaveLength(2);
      }),
    ),
  );

  it.effect(
    'prompts for external http/https origins, scopes allow-session, persists allow-always, and revokes on removal',
    () =>
      withBrowserAndSettings(({ fake, service, settings }) =>
        Effect.gen(function* () {
          const prompts: Array<{ readonly sessionId: SessionId; readonly origin: string }> = [];
          let nextDecision: BrowserOriginDecision = 'deny';
          yield* service.setOriginPermissionHandler({
            requestPermission: ({ sessionId, origin }) =>
              Effect.sync(() => {
                prompts.push({ sessionId, origin });
                return nextDecision;
              }),
          });

          // Even in Auto mode, external origins prompt and deny before loading anything.
          const denied = yield* service
            .agentNavigate(s1, 'https://example.com/private')
            .pipe(Effect.flip);
          expect(denied).toMatchObject({ _tag: 'BrowserError', reason: 'PermissionDenied' });
          expect(fake.loadedUrls).toEqual([]);
          expect(prompts).toEqual([{ sessionId: s1, origin: 'https://example.com' }]);

          // allow-session approves only for s1, not persisted to Settings, and s2 still asks.
          nextDecision = 'allow-session';
          yield* service.agentNavigate(s1, 'https://example.com/docs');
          yield* service.agentNavigate(s1, 'https://example.com/other');
          expect((yield* settings.get).browserAllowedOrigins).toEqual([]);
          expect(prompts).toHaveLength(2);

          nextDecision = 'deny';
          const s2Denied = yield* service
            .agentNavigate(s2, 'https://example.com/docs')
            .pipe(Effect.flip);
          expect(s2Denied).toMatchObject({ _tag: 'BrowserError', reason: 'PermissionDenied' });
          expect(prompts).toHaveLength(3);

          // allow-always persists external http/https origin in settings.browserAllowedOrigins across Sessions.
          nextDecision = 'allow-always';
          yield* service.agentNavigate(s1, 'http://docs.example.org/guide');
          expect((yield* settings.get).browserAllowedOrigins).toEqual(['http://docs.example.org']);

          yield* service.agentNavigate(s2, 'http://docs.example.org/api');
          expect(prompts).toHaveLength(4);

          // Removing from Settings revokes immediately.
          yield* settings.update({ browserAllowedOrigins: [] });
          nextDecision = 'deny';
          const revoked = yield* service
            .agentNavigate(s2, 'http://docs.example.org/api')
            .pipe(Effect.flip);
          expect(revoked).toMatchObject({ _tag: 'BrowserError', reason: 'PermissionDenied' });
          expect(prompts).toHaveLength(5);
        }),
      ),
  );

  it.effect(
    'checks current Page URL before observation, history, interaction, waitFor, or eval executes',
    () =>
      withBrowserAndSettings(({ fake, service }) =>
        Effect.gen(function* () {
          let decision: BrowserOriginDecision = 'deny';
          const prompts: Array<string> = [];
          yield* service.setOriginPermissionHandler({
            requestPermission: ({ origin }) =>
              Effect.sync(() => {
                prompts.push(origin);
                return decision;
              }),
          });

          // User manually navigates s1 to an external Page.
          const nav = yield* service.navigate(s1, 'https://bank.example/account');
          const pageId = nav.activePageId!;
          fake.setSnapshot(pageId, {
            pageId,
            url: 'https://bank.example/account',
            title: 'Bank',
            snapshot: '- RootWebArea "Bank"',
            refCount: 0,
          });
          fake.setEvalResult(pageId, { value: 'secret-cookie', type: 'string' });

          // Every Agent Step touching that Page fails with PermissionDenied BEFORE calling BrowserHost.
          const gatedCalls: ReadonlyArray<Effect.Effect<unknown, BrowserError>> = [
            service.agentBack(s1),
            service.agentForward(s1),
            service.agentReload(s1),
            service.agentSnapshot(s1),
            service.agentScreenshot(s1),
            service.agentConsole(s1),
            service.agentNetwork(s1),
            service.agentClick(s1, { selector: 'button' }),
            service.agentFill(s1, { selector: 'input' }, 'x'),
            service.agentType(s1, 'x'),
            service.agentPress(s1, 'Enter'),
            service.agentSelect(s1, { selector: 'select' }, ['a']),
            service.agentHover(s1, { selector: 'a' }),
            service.agentScroll(s1, { direction: 'down' }),
            service.agentWaitFor(s1, { text: 'Balance' }),
            service.agentEval(s1, 'document.cookie'),
          ];
          for (const effect of gatedCalls) {
            const err = yield* effect.pipe(Effect.flip);
            expect(err).toMatchObject({ _tag: 'BrowserError', reason: 'PermissionDenied' });
          }
          expect(fake.interactions).toEqual([]);
          expect(fake.waits).toEqual([]);
          expect(fake.evals).toEqual([]);
          expect(prompts).toHaveLength(16);

          // Once allowed for the Session, observations and eval succeed.
          decision = 'allow-session';
          expect((yield* service.agentSnapshot(s1)).title).toBe('Bank');
          expect((yield* service.agentEval(s1, 'document.cookie')).value).toBe('secret-cookie');
        }),
      ),
  );

  it.effect(
    'coalesces concurrent origin requests without deadlocking BrowserService for other Sessions',
    () =>
      withBrowserAndSettings(({ service }) =>
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const release = yield* Deferred.make<BrowserOriginDecision>();
          let promptCount = 0;

          yield* service.setOriginPermissionHandler({
            requestPermission: () =>
              Effect.gen(function* () {
                promptCount++;
                yield* Deferred.succeed(started, undefined);
                return yield* Deferred.await(release);
              }),
          });

          const f1 = yield* Effect.forkChild(service.agentNavigate(s1, 'https://example.com/a'));
          const f2 = yield* Effect.forkChild(service.agentNavigate(s1, 'https://example.com/b'));
          yield* Deferred.await(started);

          // While s1 is waiting for user approval, s2's Browser operations do NOT deadlock.
          const s2State = yield* service.setOpen(s2, true);
          expect(s2State.open).toBe(true);

          yield* Deferred.succeed(release, 'allow-session');
          const r1 = yield* Fiber.join(f1);
          const r2 = yield* Fiber.join(f2);
          expect(r1.url).toBe('https://example.com/a');
          expect(r2.url).toBe('https://example.com/b');
          expect(promptCount).toBe(1);
        }),
      ),
  );

  it.effect(
    'blocks server-side redirects to disallowed schemes or unapproved external origins during Agent navigation and prompts Permission before retrying',
    () =>
      withBrowserAndSettings(({ fake, service, settings }) =>
        Effect.gen(function* () {
          let decision: BrowserOriginDecision = 'deny';
          let promptDeferred: Deferred.Deferred<void> | undefined;
          const prompts: Array<string> = [];
          yield* service.setOriginPermissionHandler({
            requestPermission: ({ origin }) =>
              Effect.sync(() => {
                prompts.push(origin);
                return decision;
              }).pipe(
                Effect.tap(() =>
                  promptDeferred === undefined
                    ? Effect.void
                    : Deferred.succeed(promptDeferred, undefined),
                ),
              ),
          });

          // Approved external origin via Settings passes redirect guard seamlessly.
          yield* settings.update({ browserAllowedOrigins: ['https://trusted.example'] });

          const nav = yield* service.agentNavigate(s1, 'http://127.0.0.1:4100/start');
          const pageId = nav.pageId;

          // Loopback & already-approved external redirects pass synchronously.
          expect(fake.simulateRedirect(pageId, 'http://localhost:4100/next')).toBe(true);
          expect(fake.simulateRedirect(pageId, 'https://trusted.example/landing')).toBe(true);
          expect(prompts).toEqual([]);

          // Disallowed schemes are ALWAYS blocked synchronously without prompting Permission.
          expect(fake.simulateRedirect(pageId, 'file:///etc/passwd')).toBe(false);
          expect(fake.simulateRedirect(pageId, 'chrome://settings')).toBe(false);
          yield* Effect.yieldNow;
          expect(prompts).toEqual([]);
          expect(fake.loadedUrls.some((u) => u.url.startsWith('file:'))).toBe(false);

          // Unapproved external redirect is blocked in will-redirect and prompts Permission.
          promptDeferred = yield* Deferred.make<void>();
          expect(fake.simulateRedirect(pageId, 'https://unapproved.example/steal')).toBe(false);
          yield* Deferred.await(promptDeferred);
          expect(prompts).toEqual(['https://unapproved.example']);
          expect(fake.loadedUrls.some((u) => u.url === 'https://unapproved.example/steal')).toBe(
            false,
          );

          // When approved, BrowserService retries loadUrl for the authorized redirect target.
          decision = 'allow-session';
          promptDeferred = yield* Deferred.make<void>();
          const retried = yield* service.events.pipe(
            Stream.filter(
              (event) =>
                event._tag === 'State' &&
                event.state.sessionId === s1 &&
                event.state.pages[0]?.url === 'https://approved-redirect.example/ok',
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;
          expect(fake.simulateRedirect(pageId, 'https://approved-redirect.example/ok')).toBe(false);
          yield* Deferred.await(promptDeferred);
          yield* Fiber.join(retried);
          expect(
            fake.loadedUrls.some((u) => u.url === 'https://approved-redirect.example/ok'),
          ).toBe(true);

          // Once approved for the Session, subsequent redirects to that origin pass seamlessly.
          expect(fake.simulateRedirect(pageId, 'https://approved-redirect.example/second')).toBe(
            true,
          );

          // When Session is idle (user-driven browsing), external HTTP(S) redirects are not blocked.
          yield* service.onTurnEnded(s1);
          expect(fake.simulateRedirect(pageId, 'https://human-redirect.example/home')).toBe(true);
          expect(fake.simulateRedirect(pageId, 'file:///etc/passwd')).toBe(false);
        }),
      ),
  );

  it.effect(
    'allows observation, eval, history, and interaction on about:blank Pages while blocking explicit about:blank navigation/creation',
    () =>
      withBrowserAndSettings(({ fake, service }) =>
        Effect.gen(function* () {
          let prompted = false;
          yield* service.setOriginPermissionHandler({
            requestPermission: () =>
              Effect.sync(() => {
                prompted = true;
                return 'deny' as const;
              }),
          });
          yield* service.setSessionPermissionMode(s1, 'ask');

          // A freshly opened blank Page can be observed, evaluated, navigated in history, and interacted with.
          const blankPage = yield* service.agentCreatePage(s1);
          expect(blankPage.url).toBe('about:blank');
          fake.setEvalResult(blankPage.id, { value: 'about:blank', type: 'string' });

          expect((yield* service.agentSnapshot(s1, blankPage.id)).url).toBe('about:blank');
          expect((yield* service.agentScreenshot(s1, blankPage.id)).mimeType).toBe('image/png');
          expect((yield* service.agentConsole(s1, { pageId: blankPage.id })).entries).toEqual([]);
          expect((yield* service.agentNetwork(s1, { pageId: blankPage.id })).entries).toEqual([]);
          expect((yield* service.agentEval(s1, 'location.href', blankPage.id)).value).toBe(
            'about:blank',
          );
          yield* service.agentBack(s1, blankPage.id);
          yield* service.agentForward(s1, blankPage.id);
          yield* service.agentReload(s1, blankPage.id);
          yield* service.agentClick(s1, { selector: 'body' }, { pageId: blankPage.id });
          expect(prompted).toBe(false);

          // Explicit navigation or creation targeting about:blank remains blocked with SchemeBlocked.
          const navErr = yield* service
            .agentNavigate(s1, 'about:blank', blankPage.id)
            .pipe(Effect.flip);
          expect(navErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });

          const createErr = yield* service.agentCreatePage(s1, 'about:blank').pipe(Effect.flip);
          expect(createErr).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });
        }),
      ),
  );
});

describe('BrowserService live Agent control, Take over & Browser handoff', () => {
  it.effect(
    'auto-opens Browser for active Session on Agent step without stealing focus for background Sessions, and resets on onTurnEnded',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setBounds(s1, bounds);
          yield* service.setBounds(s2, bounds);
          yield* service.setActiveSession(s1);

          expect((yield* service.getState(s1)).open).toBe(false);
          expect(fake.currentPresentation).toBeNull();

          // Agent navigates on currently viewed Session s1 -> auto-opens Browser & sets agentActive.
          const nav1 = yield* service.agentNavigate(s1, 'http://localhost:3000');
          const s1AfterNav = yield* service.getState(s1);
          expect(s1AfterNav.open).toBe(true);
          expect(s1AfterNav.control).toEqual({
            _tag: 'agentActive',
            pageId: nav1.pageId,
            action: 'navigate',
          });
          expect(fake.currentPresentation).toEqual({
            pageId: nav1.pageId,
            bounds,
            visible: true,
          });

          // Subsequent Agent steps update action/pageId while staying agentActive.
          yield* service.agentSnapshot(s1);
          expect((yield* service.getState(s1)).control).toEqual({
            _tag: 'agentActive',
            pageId: nav1.pageId,
            action: 'snapshot',
          });

          // Background Session s2 performs Agent Browser steps -> never opens s2 or steals s1 presentation.
          const nav2 = yield* service.agentNavigate(s2, 'http://localhost:4000');
          const s2AfterNav = yield* service.getState(s2);
          expect(s2AfterNav.open).toBe(false);
          expect(s2AfterNav.control).toEqual({
            _tag: 'agentActive',
            pageId: nav2.pageId,
            action: 'navigate',
          });
          expect(fake.currentPresentation).toEqual({
            pageId: nav1.pageId,
            bounds,
            visible: true,
          });

          // Ending the Turn resets control to idle cleanly.
          yield* service.onTurnEnded(s1);
          expect((yield* service.getState(s1)).control).toEqual({ _tag: 'idle' });
          expect((yield* service.getState(s2)).control).toEqual({
            _tag: 'agentActive',
            pageId: nav2.pageId,
            action: 'navigate',
          });
        }),
      ),
  );

  it.effect(
    'pauses pending and subsequent Agent Browser Steps during Take over until Continue or onTurnEnded',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          yield* service.setActiveSession(s1);
          const nav = yield* service.agentNavigate(s1, 'http://localhost:3000');

          const taken = yield* service.takeOver(s1);
          expect(taken.control).toEqual({ _tag: 'userTakeover', pausedCount: 0 });

          // Subsequent Agent Browser Steps pause without touching the host while user can still browse.
          const clickFiber = yield* service.agentClick(s1, { ref: 'e1' }).pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect(fake.interactions).toEqual([]);
          expect((yield* service.getState(s1)).control).toEqual({
            _tag: 'userTakeover',
            pausedCount: 1,
          });

          const navFiber = yield* service
            .agentNavigate(s1, 'http://localhost:3000/after-continue')
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          expect((yield* service.getState(s1)).control).toEqual({
            _tag: 'userTakeover',
            pausedCount: 2,
          });

          // User navigation remains responsive while Agent is paused.
          yield* service.navigate(s1, 'http://localhost:3000/user-step');
          expect((yield* service.getState(s1)).pages[0]?.url).toBe(
            'http://localhost:3000/user-step',
          );

          // Clicking Continue unblocks the paused Agent steps and returns to agentActive.
          const continued = yield* service.continueAgent(s1);
          expect(continued.control._tag).toBe('agentActive');

          yield* Fiber.join(clickFiber);
          yield* Fiber.join(navFiber);
          expect(fake.interactions).toHaveLength(1);
          expect(fake.interactions[0]).toMatchObject({ kind: 'click', pageId: nav.pageId });
          expect((yield* service.getState(s1)).pages[0]?.url).toBe(
            'http://localhost:3000/after-continue',
          );

          // Stopping a Turn during Take over unblocks paused steps with Unavailable and resets to idle.
          yield* service.takeOver(s1);
          const cancelledFiber = yield* service
            .agentSnapshot(s1)
            .pipe(Effect.flip, Effect.forkChild);
          yield* Effect.yieldNow;
          expect((yield* service.getState(s1)).control).toEqual({
            _tag: 'userTakeover',
            pausedCount: 1,
          });

          yield* service.onTurnEnded(s1);
          const err = yield* Fiber.join(cancelledFiber);
          expect(err).toMatchObject({ _tag: 'BrowserError', reason: 'Unavailable' });
          expect((yield* service.getState(s1)).control).toEqual({ _tag: 'idle' });
        }),
      ),
  );

  it.effect(
    'agentHandoff focuses target Page, auto-opens active Browser without stealing background, emits handoffAttention, and resolves on continueAgent or onTurnEnded',
    () =>
      withBrowser((fake) =>
        Effect.gen(function* () {
          const service = yield* BrowserService;
          const attentionFiber = yield* service.handoffAttention.pipe(
            Stream.take(4),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* Effect.yieldNow;

          // Create two pages in s1 (closed) while s2 is active.
          yield* service.setBounds(s1, bounds);
          yield* service.setBounds(s2, bounds);
          yield* service.setActiveSession(s2);
          const p1 = (yield* service.createPage(s1, 'http://localhost:3000/one')).activePageId!;
          const p2 = (yield* service.createPage(s1, 'http://localhost:3000/two')).activePageId!;
          expect((yield* service.getState(s1)).activePageId).toBe(p2);
          expect((yield* service.getState(s1)).open).toBe(false);

          // Background Session s1 calls agentHandoff targeting p1 -> focuses p1 inside s1, does NOT steal s2 focus or open s1.
          const bgHandoffFiber = yield* service
            .agentHandoff(s1, 'Sign in to continue', p1)
            .pipe(Effect.forkChild);
          yield* Effect.yieldNow;
          const s1State = yield* service.getState(s1);
          expect(s1State.activePageId).toBe(p1);
          expect(s1State.open).toBe(false);
          expect(s1State.control).toEqual({
            _tag: 'handoffWaiting',
            pageId: p1,
            reason: 'Sign in to continue',
          });
          expect(fake.currentPresentation).toBeNull();

          // Switching to s1 auto-opens the pane so the user sees the handoff banner and Page p1.
          yield* service.setActiveSession(s1);
          expect((yield* service.getState(s1)).open).toBe(true);
          expect(fake.currentPresentation).toEqual({ pageId: p1, bounds, visible: true });

          // Continuing resumes the handoff call and clears handoffWaiting -> agentActive.
          yield* service.continueAgent(s1);
          expect(yield* Fiber.join(bgHandoffFiber)).toEqual({ resumed: true, pageId: p1 });
          expect((yield* service.getState(s1)).control._tag).toBe('agentActive');

          // Second handoff cancelled via onTurnEnded fails cleanly and clears handoffAttention.
          const cancelledHandoffFiber = yield* service
            .agentHandoff(s1, 'Complete 2FA')
            .pipe(Effect.flip, Effect.forkChild);
          yield* Effect.yieldNow;
          expect((yield* service.getState(s1)).control).toEqual({
            _tag: 'handoffWaiting',
            pageId: p1,
            reason: 'Complete 2FA',
          });

          yield* service.onTurnEnded(s1);
          const handoffErr = yield* Fiber.join(cancelledHandoffFiber);
          expect(handoffErr).toMatchObject({ _tag: 'BrowserError', reason: 'Unavailable' });
          expect((yield* service.getState(s1)).control).toEqual({ _tag: 'idle' });

          const attentionEvents = [...(yield* Fiber.join(attentionFiber))];
          expect(attentionEvents).toEqual([
            { sessionId: s1, pending: true },
            { sessionId: s1, pending: false },
            { sessionId: s1, pending: true },
            { sessionId: s1, pending: false },
          ]);
        }),
      ),
  );
});
