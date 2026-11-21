import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream } from 'effect';
import {
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MAX_WIDTH,
  BROWSER_MIN_WIDTH,
  type BrowserBounds,
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
});
