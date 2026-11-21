/**
 * `BrowserRpcs` over the real MessagePort transport with production serialization (`layerSchemaBinary`),
 * backed by `layerBrowserService` and `makeFakeBrowserHost`.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { BrowserRpcs, type BrowserEvent } from '../../src/shared/browser/browser.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { makeFakeBrowserHost } from '../browser/browser-host-fake';
import { layerBrowserService } from '../browser/browser-service';
import { layerBrowserServiceHandlers } from './browser-handlers';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

const sessionId = SessionId.make('browser-transport-s1');

const startServer = Effect.fnUntraced(function* () {
  const fake = makeFakeBrowserHost();
  const serviceLayer = layerBrowserService.pipe(Layer.provide(fake.layer));
  const handlers = layerBrowserServiceHandlers.pipe(Layer.provide(serviceLayer));
  const context = yield* Layer.build(
    RpcServer.layer(BrowserRpcs).pipe(Layer.provideMerge(layerIpcServer), Layer.provide(handlers)),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  const { port1, port2 } = new MessageChannel();
  handoff.bind(serverPort(port1));
  const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
  const client = yield* RpcClient.make(BrowserRpcs).pipe(Effect.provideContext(protocol));
  return { client, fake };
});

describe('BrowserRpcs over the MessagePort transport', () => {
  it.live('round-trips Browser state, navigation, width, bounds, and Browser.events stream', () =>
    Effect.gen(function* () {
      const { client, fake } = yield* startServer();
      const eventsFiber = yield* client['Browser.events']().pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout('5 seconds'),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const opened = yield* client['Browser.setOpen']({ sessionId, open: true });
      expect(opened.open).toBe(true);
      expect(opened.pages).toHaveLength(1);
      const pageId = opened.activePageId;
      if (pageId === null) return yield* Effect.die('expected activePageId');

      yield* client['Browser.setActiveSession']({ sessionId });
      yield* client['Browser.setBounds']({
        sessionId,
        bounds: { x: 400, y: 48, width: 500, height: 700 },
      });
      expect(fake.currentPresentation).toEqual({
        pageId,
        bounds: { x: 400, y: 48, width: 500, height: 700 },
        visible: true,
      });

      const resized = yield* client['Browser.setWidth']({ sessionId, width: 640 });
      expect(resized.width).toBe(640);

      const events = yield* Fiber.join(eventsFiber);
      const states = [...events].flatMap((event: BrowserEvent) =>
        event._tag === 'State' ? [event.state] : [],
      );
      expect(states.map((state) => state.open)).toEqual([true, true]);
      expect(states[1]?.width).toBe(640);
    }).pipe(Effect.scoped),
  );

  it.live('round-trips navigation, host commands, and typed BrowserError over the wire', () =>
    Effect.gen(function* () {
      const { client, fake } = yield* startServer();
      const missingErr = yield* client['Browser.reload']({ sessionId }).pipe(Effect.flip);
      expect(missingErr).toMatchObject({ _tag: 'BrowserError', reason: 'NoActivePage' });

      yield* client['Browser.setOpen']({ sessionId, open: true });
      const blocked = yield* client['Browser.navigate']({
        sessionId,
        url: 'file:///etc/passwd',
      }).pipe(Effect.flip);
      expect(blocked).toMatchObject({ _tag: 'BrowserError', reason: 'SchemeBlocked' });

      const nav = yield* client['Browser.navigate']({ sessionId, url: 'example.com/docs' });
      expect(nav.pages[0]?.url).toBe('https://example.com/docs');

      yield* client['Browser.goBack']({ sessionId });
      yield* client['Browser.goForward']({ sessionId });
      yield* client['Browser.reload']({ sessionId });
      yield* client['Browser.openExternal']({ sessionId });
      yield* client['Browser.openDevTools']({ sessionId });

      expect(fake.commands.map((command) => command.kind)).toEqual([
        'goBack',
        'goForward',
        'reload',
      ]);
      expect(fake.externalUrls).toEqual(['https://example.com/docs']);
      expect(fake.devToolsOpenedFor).toEqual([nav.activePageId]);

      const fetched = yield* client['Browser.getState']({ sessionId });
      expect(fetched.pages[0]?.url).toBe('https://example.com/docs');

      const pageId = fetched.activePageId;
      if (pageId === null) return yield* Effect.die('expected activePageId');
      fake.setScreenshot(pageId, {
        name: 'browser-screenshot.png',
        mimeType: 'image/png',
        data: 'ZmFrZS1wbmc=',
      });
      const shot = yield* client['Browser.captureScreenshot']({ sessionId });
      expect(shot).toEqual({
        name: 'browser-screenshot.png',
        mimeType: 'image/png',
        data: 'ZmFrZS1wbmc=',
      });

      fake.emitHostEvent({
        _tag: 'ConsoleError',
        pageId,
        error: {
          kind: 'console',
          message: 'Uncaught ReferenceError: x is not defined',
          url: 'https://example.com/app.js:12',
          at: 1700000000000,
        },
      });
      fake.emitHostEvent({
        _tag: 'ConsoleError',
        pageId,
        error: {
          kind: 'network',
          message: 'POST 500',
          url: 'https://example.com/api/save',
          status: 500,
          at: 1700000000001,
        },
      });

      let errors = (yield* client['Browser.getConsoleErrors']({ sessionId })).errors;
      for (let attempt = 0; attempt < 20 && errors.length < 2; attempt++) {
        yield* Effect.sleep('10 millis');
        errors = (yield* client['Browser.getConsoleErrors']({ sessionId })).errors;
      }
      expect(errors).toEqual([
        {
          kind: 'console',
          message: 'Uncaught ReferenceError: x is not defined',
          url: 'https://example.com/app.js:12',
          at: 1700000000000,
        },
        {
          kind: 'network',
          message: 'POST 500',
          url: 'https://example.com/api/save',
          status: 500,
          at: 1700000000001,
        },
      ]);

      const pickedFiber = yield* client['Browser.events']().pipe(
        Stream.filter((event) => event._tag === 'ElementPicked'),
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout('5 seconds'),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      const pickerStarted = yield* client['Browser.startElementPicker']({ sessionId });
      expect(pickerStarted.pickerActive).toBe(true);
      fake.emitHostEvent({
        _tag: 'ElementPicked',
        pageId,
        element: {
          selector: '#submit-btn',
          tagName: 'button',
          text: 'Submit',
          htmlExcerpt: '<button id="submit-btn">Submit</button>',
        },
      });
      const picked = yield* Fiber.join(pickedFiber);
      expect(picked[0]).toEqual({
        _tag: 'ElementPicked',
        sessionId,
        element: {
          selector: '#submit-btn',
          tagName: 'button',
          text: 'Submit',
          htmlExcerpt: '<button id="submit-btn">Submit</button>',
        },
      });
      const cancelled = yield* client['Browser.cancelElementPicker']({ sessionId });
      expect(cancelled.pickerActive).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live(
    'round-trips Browser.setOccluded, lastFrameDataUrl, and presentation restoration over MessagePort',
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* startServer();
        const opened = yield* client['Browser.setOpen']({ sessionId, open: true });
        const pageId = opened.activePageId;
        if (pageId === null) return yield* Effect.die('expected activePageId');

        yield* client['Browser.setActiveSession']({ sessionId });
        yield* client['Browser.setBounds']({
          sessionId,
          bounds: { x: 400, y: 48, width: 500, height: 700 },
        });
        fake.setFrameDataUrl(pageId, 'data:image/png;base64,wireframe');

        const eventsFiber = yield* client['Browser.events']().pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeout('5 seconds'),
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        yield* client['Browser.setOccluded']({ occluded: true });
        expect(fake.currentPresentation).toBeNull();
        expect(yield* client['Browser.getState']({ sessionId })).toMatchObject({
          occluded: true,
          lastFrameDataUrl: 'data:image/png;base64,wireframe',
        });

        yield* client['Browser.setOccluded']({ occluded: false });
        expect(fake.currentPresentation).toEqual({
          pageId,
          bounds: { x: 400, y: 48, width: 500, height: 700 },
          visible: true,
        });
        const restored = yield* client['Browser.getState']({ sessionId });
        expect(restored.occluded).toBe(false);
        expect(restored.lastFrameDataUrl).toBeUndefined();

        const events = [...(yield* Fiber.join(eventsFiber))];
        const states = events.flatMap((event: BrowserEvent) =>
          event._tag === 'State' ? [event.state] : [],
        );
        expect(states).toHaveLength(2);
        expect(states[0]).toMatchObject({
          occluded: true,
          lastFrameDataUrl: 'data:image/png;base64,wireframe',
        });
        expect(states[1]?.occluded).toBe(false);
        expect(states[1]?.lastFrameDataUrl).toBeUndefined();
      }).pipe(Effect.scoped),
  );
});
