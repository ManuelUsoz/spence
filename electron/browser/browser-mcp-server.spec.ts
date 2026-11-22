import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Layer } from 'effect';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { makeFakeBrowserHost } from './browser-host-fake';
import {
  makeBrowserMcpServer,
  makeBrowserMcpTools,
  type RegisteredBrowserMcpServer,
} from './browser-mcp-server';
import { BrowserService, layerBrowserService } from './browser-service';

const s1 = SessionId.make('session-mcp-1');
const s2 = SessionId.make('session-mcp-2');

const rpcCall = (
  registered: RegisteredBrowserMcpServer,
  method: string,
  params?: Record<string, unknown>,
  overrideToken?: string,
) =>
  Effect.promise(async () => {
    const authHeader =
      overrideToken === undefined
        ? Object.fromEntries(registered.server.headers.map((h) => [h.name, h.value]))
        : { Authorization: `Bearer ${overrideToken}` };
    const response = await fetch(registered.server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>),
    };
  });

const callTool = (
  registered: RegisteredBrowserMcpServer,
  name: string,
  args: Record<string, unknown> = {},
) => rpcCall(registered, 'tools/call', { name, arguments: args });

const withBrowserMcp = <A, E, R>(
  body: (ctx: {
    readonly fake: ReturnType<typeof makeFakeBrowserHost>;
    readonly browserService: typeof BrowserService.Service;
    readonly mcp: Effect.Success<typeof makeBrowserMcpServer>;
    readonly runEffect: <T, Err>(effect: Effect.Effect<T, Err>) => Promise<T>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fake = makeFakeBrowserHost();
    const layer = layerBrowserService.pipe(Layer.provide(fake.layer));
    return yield* Effect.gen(function* () {
      const browserService = yield* BrowserService;
      const mcp = yield* makeBrowserMcpServer;
      const runEffect = <T, Err>(effect: Effect.Effect<T, Err>) => Effect.runPromise(effect);
      return yield* body({ fake, browserService, mcp, runEffect });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

describe('browser MCP server', () => {
  it.live('initializes, lists all 19 tools, enforces Bearer auth, and revokes cleanly', () =>
    withBrowserMcp(({ browserService, mcp, runEffect }) =>
      Effect.gen(function* () {
        const registered = mcp.register(
          makeBrowserMcpTools({
            browserService,
            sessionId: s1,
            active: () => true,
            runEffect,
          }),
        );

        const init = yield* rpcCall(registered, 'initialize');
        expect(init.status).toBe(200);
        expect(init.body).toMatchObject({
          jsonrpc: '2.0',
          id: 1,
          result: {
            protocolVersion: '2025-03-26',
            serverInfo: { name: 'spence-browser', version: '1.0.0' },
          },
        });

        const list = yield* rpcCall(registered, 'tools/list');
        expect(list.status).toBe(200);
        const tools = (
          list.body?.['result'] as { readonly tools: ReadonlyArray<{ readonly name: string }> }
        ).tools.map((t) => t.name);
        expect(tools).toEqual([
          'navigate',
          'back',
          'forward',
          'reload',
          'pages',
          'snapshot',
          'screenshot',
          'console',
          'network',
          'click',
          'fill',
          'type',
          'press',
          'select',
          'hover',
          'scroll',
          'wait_for',
          'eval',
          'handoff',
        ]);

        // Rejects wrong Bearer token and non-POST requests before reading body.
        const badAuth = yield* rpcCall(registered, 'tools/list', undefined, 'wrong-token');
        expect(badAuth.status).toBe(403);

        const getRes = yield* Effect.promise(() =>
          fetch(registered.server.url, {
            method: 'GET',
            headers: Object.fromEntries(
              registered.server.headers.map(
                (h: { readonly name: string; readonly value: string }) => [h.name, h.value],
              ),
            ),
          }),
        );
        expect(getRes.status).toBe(403);

        registered.revoke();
        const afterRevoke = yield* rpcCall(registered, 'tools/list');
        expect(afterRevoke.status).toBe(403);
      }),
    ),
  );

  it.live(
    'rejects calls with NotActive when the Turn is inactive and returns 403 if revoked mid-call',
    () =>
      withBrowserMcp(({ browserService, mcp, runEffect }) =>
        Effect.gen(function* () {
          let turnActive = false;
          const registered = mcp.register(
            makeBrowserMcpTools({
              browserService,
              sessionId: s1,
              active: () => turnActive,
              runEffect,
            }),
          );

          const inactiveRes = yield* callTool(registered, 'pages', { action: 'list' });
          expect(inactiveRes.status).toBe(200);
          const inactiveResult = inactiveRes.body?.['result'] as {
            readonly isError: boolean;
            readonly content: ReadonlyArray<{ readonly text: string }>;
          };
          expect(inactiveResult.isError).toBe(true);
          expect(JSON.parse(inactiveResult.content[0]?.text ?? '{}')).toMatchObject({
            error: { reason: 'NotActive' },
          });

          // Mid-flight revocation returns 403 after handler resolves.
          let releaseGate: (() => void) | undefined;
          const gate = new Promise<void>((resolve) => {
            releaseGate = resolve;
          });
          const slowReg = mcp.register({
            navigate: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            back: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            forward: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            reload: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            pages: () => gate.then(() => ({ content: [{ type: 'text', text: '{}' }] })),
            snapshot: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            screenshot: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            console: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            network: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            click: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            fill: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            type: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            press: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            select: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            hover: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            scroll: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            waitFor: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            eval: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
            handoff: () => Promise.resolve({ content: [{ type: 'text', text: '{}' }] }),
          });
          const pending = Effect.runPromise(callTool(slowReg, 'pages', { action: 'list' }));
          yield* Effect.sleep('20 millis');
          slowReg.revoke();
          releaseGate?.();
          const midRevoke = yield* Effect.promise(() => pending);
          expect(midRevoke.status).toBe(403);
          turnActive = true;
          expect(turnActive).toBe(true);
        }),
      ),
  );

  it.live(
    'executes navigation, pages, snapshot, screenshot image blocks, redacted network, console, interactions, and eval',
    () =>
      withBrowserMcp(({ fake, browserService, mcp, runEffect }) =>
        Effect.gen(function* () {
          const reg1 = mcp.register(
            makeBrowserMcpTools({
              browserService,
              sessionId: s1,
              active: () => true,
              runEffect,
            }),
          );
          const reg2 = mcp.register(
            makeBrowserMcpTools({
              browserService,
              sessionId: s2,
              active: () => true,
              runEffect,
            }),
          );

          const nav = yield* callTool(reg1, 'navigate', { url: 'http://127.0.0.1:4321/form' });
          expect(nav.status).toBe(200);
          const navPayload = JSON.parse(
            (nav.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '{}',
          ) as { pageId: string; url: string };
          expect(navPayload.url).toBe('http://127.0.0.1:4321/form');

          const pageId = navPayload.pageId as Parameters<typeof fake.setSnapshot>[0];
          fake.setSnapshot(pageId, {
            pageId,
            url: 'http://127.0.0.1:4321/form',
            title: 'Form',
            snapshot:
              '- RootWebArea "Form"\n  - textbox "Name" [ref=e1]\n  - button "Save" [ref=e2]',
            refCount: 2,
          });
          fake.setScreenshot(pageId, {
            name: 'browser-screenshot.png',
            mimeType: 'image/png',
            data: 'AQIDBA==',
          });
          fake.setEvalResult(pageId, { value: 'Form', type: 'string' });
          fake.emitHostEvent({
            _tag: 'ConsoleEntry',
            pageId,
            entry: { level: 'info', message: 'ready', at: 1 },
          });
          fake.emitHostEvent({
            _tag: 'NetworkEntry',
            pageId,
            entry: {
              id: 1,
              method: 'GET',
              url: 'https://user:pw@example.com/api?api_key=secret123&ok=1',
              resourceType: 'xhr',
              status: 200,
              requestHeaders: { Authorization: 'Bearer tok', Accept: '*/*' },
              at: 1,
            },
          });

          const snap = yield* callTool(reg1, 'snapshot');
          const snapText = (snap.body?.['result'] as { content: Array<{ text: string }> })
            .content[0]?.text;
          expect(snapText).toContain('[ref=e1]');

          const shot = yield* callTool(reg1, 'screenshot');
          const shotContent = (
            shot.body?.['result'] as {
              content: Array<{ type: string; data?: string; mimeType?: string }>;
            }
          ).content;
          expect(shotContent[0]).toEqual({
            type: 'image',
            mimeType: 'image/png',
            data: 'AQIDBA==',
          });

          yield* callTool(reg1, 'fill', { ref: 'e1', value: 'Bob' });
          yield* callTool(reg1, 'click', { ref: 'e2' });
          yield* callTool(reg1, 'type', { text: 'extra', ref: 'e1' });
          yield* callTool(reg1, 'press', { key: 'Enter', ref: 'e1' });
          yield* callTool(reg1, 'select', { selector: '#role', value: 'admin' });
          yield* callTool(reg1, 'hover', { ref: 'e2' });
          yield* callTool(reg1, 'scroll', { direction: 'down', amount: 250 });
          yield* callTool(reg1, 'wait_for', { text: 'Saved', timeoutMs: 1000 });
          yield* callTool(reg1, 'back');
          yield* callTool(reg1, 'forward');
          yield* callTool(reg1, 'reload');

          const evalRes = yield* callTool(reg1, 'eval', { expression: 'document.title' });
          expect(
            JSON.parse(
              (evalRes.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
                '{}',
            ),
          ).toEqual({ value: 'Form', type: 'string' });

          for (let i = 0; i < 20; i++) {
            const netRes = yield* callTool(reg1, 'network');
            const parsed = JSON.parse(
              (netRes.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
                '{}',
            ) as { entries: Array<{ url: string; requestHeaders?: Record<string, string> }> };
            if (parsed.entries.length === 1) {
              expect(parsed.entries[0]?.url).not.toContain('secret123');
              expect(parsed.entries[0]?.url).not.toContain('pw');
              expect(parsed.entries[0]?.requestHeaders?.['Authorization']).toBe('[REDACTED]');
              break;
            }
            yield* Effect.yieldNow;
          }

          const consoleRes = yield* callTool(reg1, 'console', { level: 'info' });
          expect(
            JSON.parse(
              (consoleRes.body?.['result'] as { content: Array<{ text: string }> }).content[0]
                ?.text ?? '{}',
            ).entries,
          ).toHaveLength(1);

          // Session 2 cannot access Session 1's Page.
          const foreign = yield* callTool(reg2, 'snapshot', { pageId });
          expect((foreign.body?.['result'] as { isError?: boolean }).isError).toBe(true);
          expect(
            JSON.parse(
              (foreign.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
                '{}',
            ),
          ).toMatchObject({ error: { reason: 'PageNotFound' } });

          // Malformed tool arguments return 400.
          const badArgs = yield* callTool(reg1, 'navigate', { url: 123 });
          expect(badArgs.status).toBe(400);

          // Remote Session is rejected with RemoteUnsupported.
          yield* browserService.setSessionDevice(s2, 'paired-remote-1');
          const remoteRes = yield* callTool(reg2, 'navigate', { url: 'http://localhost:3000/' });
          expect((remoteRes.body?.['result'] as { isError?: boolean }).isError).toBe(true);
          expect(
            JSON.parse(
              (remoteRes.body?.['result'] as { content: Array<{ text: string }> }).content[0]
                ?.text ?? '{}',
            ),
          ).toMatchObject({ error: { reason: 'RemoteUnsupported' } });

          // Pages tool creates, selects, and closes Pages.
          const created = yield* callTool(reg1, 'pages', {
            action: 'new',
            url: 'http://127.0.0.1:4321/second',
          });
          const createdPage = JSON.parse(
            (created.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
              '{}',
          ) as { id: string };
          yield* callTool(reg1, 'pages', { action: 'select', pageId });
          const closed = yield* callTool(reg1, 'pages', {
            action: 'close',
            pageId: createdPage.id,
          });
          expect(
            JSON.parse(
              (closed.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
                '{}',
            ).pages,
          ).toHaveLength(1);
        }),
      ),
  );

  it.live('handoff tool pauses until continueAgent or returns error on onTurnEnded', () =>
    withBrowserMcp(({ browserService, mcp, runEffect }) =>
      Effect.gen(function* () {
        const reg = mcp.register(
          makeBrowserMcpTools({
            browserService,
            sessionId: s1,
            active: () => true,
            runEffect,
          }),
        );
        const nav = yield* callTool(reg, 'navigate', { url: 'http://localhost:3000/login' });
        const pageId = JSON.parse(
          (nav.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '{}',
        ).pageId as string;

        // Empty reason is rejected with 400.
        const bad = yield* callTool(reg, 'handoff', { reason: '   ' });
        expect(bad.status).toBe(400);

        // Valid handoff waits until continueAgent resolves it.
        const handoffFiber = yield* callTool(reg, 'handoff', {
          reason: 'Please sign in to your account',
        }).pipe(Effect.forkChild);
        // Wait for handoffWaiting state.
        for (let i = 0; i < 40; i++) {
          const state = yield* browserService.getState(s1);
          if (state.control._tag === 'handoffWaiting') break;
          yield* Effect.sleep('5 millis');
        }
        expect((yield* browserService.getState(s1)).control).toEqual({
          _tag: 'handoffWaiting',
          pageId,
          reason: 'Please sign in to your account',
        });

        yield* browserService.continueAgent(s1);
        const res = yield* Fiber.join(handoffFiber);
        expect(res.status).toBe(200);
        expect((res.body?.['result'] as { isError?: boolean }).isError).toBeUndefined();
        expect(
          JSON.parse(
            (res.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '{}',
          ),
        ).toEqual({ resumed: true, pageId });

        // Cancelled Turn unblocks handoff with Unavailable error.
        const cancelledFiber = yield* callTool(reg, 'handoff', {
          reason: 'Solve verification',
        }).pipe(Effect.forkChild);
        for (let i = 0; i < 40; i++) {
          const state = yield* browserService.getState(s1);
          if (state.control._tag === 'handoffWaiting') break;
          yield* Effect.sleep('5 millis');
        }
        yield* browserService.onTurnEnded(s1);
        const cancelled = yield* Fiber.join(cancelledFiber);
        expect(cancelled.status).toBe(200);
        expect((cancelled.body?.['result'] as { isError?: boolean }).isError).toBe(true);
        expect(
          JSON.parse(
            (cancelled.body?.['result'] as { content: Array<{ text: string }> }).content[0]?.text ??
              '{}',
          ),
        ).toMatchObject({ error: { reason: 'Unavailable' } });
      }),
    ),
  );
});
