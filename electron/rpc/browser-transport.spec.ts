/**
 * `BrowserRpcs` over the real MessagePort transport with production serialization (`layerSchemaBinary`),
 * backed by `layerBrowserService` and `makeFakeBrowserHost`.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Fiber, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { BrowserRpcs, type BrowserEvent, PageId } from '../../src/shared/browser/browser.rpc';
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
      expect([...events].map((event: BrowserEvent) => event.state.open)).toEqual([true, true]);
      expect(events[1]?.state.width).toBe(640);
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
    }).pipe(Effect.scoped),
  );

  it.live(
    'round-trips createPage, selectPage, closePage, and PageNotFound over binary transport',
    () =>
      Effect.gen(function* () {
        const { client, fake } = yield* startServer();
        const opened = yield* client['Browser.setOpen']({ sessionId, open: true });
        const p1 = opened.pages[0]?.id;
        if (p1 === undefined) return yield* Effect.die('expected initial page');

        const created = yield* client['Browser.createPage']({
          sessionId,
          url: 'http://127.0.0.1:4300/second',
        });
        expect(created.pages).toHaveLength(2);
        const p2 = created.pages[1]?.id;
        if (p2 === undefined) return yield* Effect.die('expected second page');
        expect(created.activePageId).toBe(p2);

        const selected = yield* client['Browser.selectPage']({ sessionId, pageId: p1 });
        expect(selected.activePageId).toBe(p1);

        const afterCloseFirst = yield* client['Browser.closePage']({ sessionId, pageId: p1 });
        expect(afterCloseFirst.pages.map((p) => p.id)).toEqual([p2]);
        expect(afterCloseFirst.activePageId).toBe(p2);

        const afterCloseLast = yield* client['Browser.closePage']({ sessionId, pageId: p2 });
        expect(afterCloseLast.pages).toEqual([]);
        expect(afterCloseLast.activePageId).toBeNull();
        expect(fake.closedPages).toEqual([p1, p2]);

        const missingErr = yield* client['Browser.selectPage']({
          sessionId,
          pageId: PageId.make('missing-wire-page'),
        }).pipe(Effect.flip);
        expect(missingErr).toMatchObject({ _tag: 'BrowserError', reason: 'PageNotFound' });
      }).pipe(Effect.scoped),
  );
});
