import { createServer } from 'node:http';
import { expect, type Spence, test } from '../fixtures';

const startMultiPageServer = async () => {
  const seenCookieHeaders: string[] = [];
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.cookie) seenCookieHeaders.push(req.headers.cookie);

    switch (reqUrl.pathname) {
      case '/one':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>Page One</title></head><body><h1>One</h1></body></html>',
        );
        return;
      case '/two':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>Page Two</title></head><body><h1>Two</h1></body></html>',
        );
        return;
      case '/set-cookie':
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': 'spence_shared=multi-ok; Max-Age=3600; Path=/',
        });
        res.end(
          '<!doctype html><html><head><title>Auth Home</title></head><body><h1>Signed In</h1></body></html>',
        );
        return;
      case '/cookie-echo':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><html><head><title>Cookie Check</title></head><body><div id="cookie">${req.headers.cookie ?? ''}</div></body></html>`,
        );
        return;
      case '/opener':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
  <head><title>Opener Page</title></head>
  <body>
    <a id="blank-link" href="/popup-link" target="_blank">Blank Link</a>
    <button id="js-popup" type="button" onclick="window.open('/popup-window', '_blank')">JS Popup</button>
    <button id="bad-js" type="button" onclick="window.open('javascript:alert(1)', '_blank')">Bad JS</button>
    <button id="bad-file" type="button" onclick="window.open('file:///etc/passwd', '_blank')">Bad File</button>
    <button id="bad-blank" type="button" onclick="window.open('about:blank', '_blank')">Bad Blank</button>
  </body>
</html>`);
        return;
      case '/popup-link':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>Popup Link Target</title></head><body><h1>Link Target</h1></body></html>',
        );
        return;
      case '/popup-window':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>Popup Window Target</title></head><body><h1>Window Target</h1></body></html>',
        );
        return;
      default:
        res.writeHead(404);
        res.end('Not found');
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Expected TCP address from multi-page fixture HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seenCookieHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const inspectAttachedViews = async (app: Spence['app']) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const views = (win?.contentView.children ?? []).filter(
      (child) => 'webContents' in child,
    ) as Array<{
      readonly webContents: Electron.WebContents;
    }>;
    return {
      windowCount: BrowserWindow.getAllWindows().length,
      views: views.map((view) => ({
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
      })),
    };
  });

const probeActiveView = async <T>(app: Spence['app'], script: string): Promise<T> =>
  app.evaluate(async ({ BrowserWindow }, code) => {
    const win = BrowserWindow.getAllWindows()[0];
    const view = win?.contentView.children.find((child) => 'webContents' in child) as
      { readonly webContents: Electron.WebContents } | undefined;
    if (!view) throw new Error('Expected an attached WebContentsView');
    return (await view.webContents.executeJavaScript(code, true)) as T;
  }, script);

const sendSessionMessage = async (spence: Spence, text: string) => {
  await spence.page.getByTestId('new-session').click();
  await spence.page.getByTestId('composer-input').fill(text);
  await expect(spence.page.getByTestId('send')).toBeEnabled();
  await spence.page.getByTestId('composer-input').press('Enter');
};

test('creates, switches, and closes Pages via the Page strip and shows empty state at 0 Pages', async ({
  spence,
}) => {
  const server = await startMultiPageServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();
    await sendSessionMessage(spence, 'echo:Multi-Page Session');
    await expect(page.getByTestId('message-agent')).toHaveText('Multi-Page Session');

    await page.getByTestId('toggle-browser').click();
    await expect(page.getByTestId('browser-page-strip')).toBeVisible();

    const tabs = page.getByTestId('browser-page-tab');
    const urlInput = page.getByTestId('browser-url-input');
    const fallbackTitle = spence.t({ en: 'New Page', es: 'Nueva Página' });

    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0).getByTestId('browser-page-title')).toHaveText(fallbackTitle);
    await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true');

    await urlInput.fill(`${server.baseUrl}/one`);
    await urlInput.press('Enter');
    await expect(tabs.nth(0).getByTestId('browser-page-title')).toHaveText('Page One');
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [{ url: `${server.baseUrl}/one`, title: 'Page One' }] });

    // Create Page 2 via + button and navigate it independently.
    await page.getByTestId('browser-new-page').click();
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(1).getByTestId('browser-page-title')).toHaveText(fallbackTitle);
    await expect(urlInput).toHaveValue('about:blank');

    await urlInput.fill(`${server.baseUrl}/two`);
    await urlInput.press('Enter');
    await expect(tabs.nth(1).getByTestId('browser-page-title')).toHaveText('Page Two');
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [{ url: `${server.baseUrl}/two`, title: 'Page Two' }] });

    await spence.shot('browser-multi-page', {
      mask: [page.getByTestId('project-path'), page.getByTestId('browser-url-input')],
    });

    // Switch back to Page 1.
    await tabs.nth(0).getByTestId('browser-page-select').click();
    await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/one`);
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [{ url: `${server.baseUrl}/one`, title: 'Page One' }] });

    // Close Page 1 -> falls back to remaining Page Two.
    await tabs.nth(0).getByTestId('browser-page-close').click();
    await expect(tabs).toHaveCount(1);
    await expect(tabs.nth(0).getByTestId('browser-page-title')).toHaveText('Page Two');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/two`);

    // Close last Page -> renders empty state inside viewport with 0 attached WebContentsViews.
    await tabs.nth(0).getByTestId('browser-page-close').click();
    await expect(tabs).toHaveCount(0);
    await expect(page.getByTestId('browser-empty-state')).toBeVisible();
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [] });

    // Re-create a Page from empty state CTA.
    await page.getByTestId('browser-empty-new-page').click();
    await expect(tabs).toHaveCount(1);
    await expect(page.getByTestId('browser-empty-state')).toBeHidden();
    await expect(urlInput).toHaveValue('about:blank');
  } finally {
    await server.close();
  }
});

test('isolates Pages per Session while sharing cookies across Sessions via persist:spence-browser', async ({
  spence,
}) => {
  const server = await startMultiPageServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();

    // Session Alpha opens Browser with two Pages and sets a cookie.
    await sendSessionMessage(spence, 'echo:Session Alpha');
    await expect(page.getByTestId('message-agent')).toHaveText('Session Alpha');

    await page.getByTestId('toggle-browser').click();
    const urlInput = page.getByTestId('browser-url-input');
    await urlInput.fill(`${server.baseUrl}/set-cookie`);
    await urlInput.press('Enter');
    await expect(page.getByTestId('browser-page-title').first()).toHaveText('Auth Home');

    await page.getByTestId('browser-new-page').click();
    await urlInput.fill(`${server.baseUrl}/two`);
    await urlInput.press('Enter');
    await expect(page.getByTestId('browser-page-tab')).toHaveCount(2);
    await expect(page.getByTestId('browser-page-title').nth(1)).toHaveText('Page Two');

    // Switch to Session Beta -> Browser starts closed with no attached views.
    await sendSessionMessage(spence, 'echo:Session Beta');
    await expect(page.getByTestId('message-agent')).toHaveText('Session Beta');
    await expect(page.getByTestId('browser-pane')).toBeHidden();
    await expect(page.getByTestId('toggle-browser')).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [] });

    // Open Browser in Session Beta -> gets its own clean Page, sharing cookies from Session Alpha.
    await page.getByTestId('toggle-browser').click();
    await expect(page.getByTestId('browser-page-tab')).toHaveCount(1);
    await expect(urlInput).toHaveValue('about:blank');

    await urlInput.fill(`${server.baseUrl}/cookie-echo`);
    await urlInput.press('Enter');
    await expect(page.getByTestId('browser-page-title').first()).toHaveText('Cookie Check');
    await expect
      .poll(() =>
        server.seenCookieHeaders.some((header) => header.includes('spence_shared=multi-ok')),
      )
      .toBe(true);
    await expect
      .poll(() => probeActiveView<string>(spence.app, 'document.cookie'))
      .toContain('spence_shared=multi-ok');

    // Switch back to Session Alpha -> restores its 2 Pages and active Page Two cleanly.
    await page.getByTestId('session-row').filter({ hasText: 'Session Alpha' }).click();
    await expect(page.getByTestId('browser-pane')).toBeVisible();
    await expect(page.getByTestId('browser-page-tab')).toHaveCount(2);
    await expect(page.getByTestId('browser-page-title').nth(0)).toHaveText('Auth Home');
    await expect(page.getByTestId('browser-page-title').nth(1)).toHaveText('Page Two');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/two`);
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({ windowCount: 1, views: [{ url: `${server.baseUrl}/two`, title: 'Page Two' }] });

    // Switch back to Session Beta -> still shows Session Beta's Cookie Check Page.
    await page.getByTestId('session-row').filter({ hasText: 'Session Beta' }).click();
    await expect(page.getByTestId('browser-page-tab')).toHaveCount(1);
    await expect(page.getByTestId('browser-page-title').first()).toHaveText('Cookie Check');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/cookie-echo`);
  } finally {
    await server.close();
  }
});

test('routes target="_blank" and window.open popups into new Pages and rejects disallowed schemes', async ({
  spence,
}) => {
  const server = await startMultiPageServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();
    await sendSessionMessage(spence, 'echo:Popup Session');
    await expect(page.getByTestId('message-agent')).toHaveText('Popup Session');

    await page.getByTestId('toggle-browser').click();
    const urlInput = page.getByTestId('browser-url-input');
    const tabs = page.getByTestId('browser-page-tab');

    await urlInput.fill(`${server.baseUrl}/opener`);
    await urlInput.press('Enter');
    await expect(tabs.nth(0).getByTestId('browser-page-title')).toHaveText('Opener Page');
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/opener`, title: 'Opener Page' }],
      });

    // Click target="_blank" link inside the WebContentsView -> opens as Page 2 in same Browser.
    await probeActiveView(spence.app, 'document.getElementById("blank-link").click()');
    await expect(tabs).toHaveCount(2);
    await expect(tabs.nth(1)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(1).getByTestId('browser-page-title')).toHaveText('Popup Link Target');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/popup-link`);
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/popup-link`, title: 'Popup Link Target' }],
      });

    // Return to opener Page and trigger window.open(...) -> opens as Page 3.
    await tabs.nth(0).getByTestId('browser-page-select').click();
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/opener`, title: 'Opener Page' }],
      });

    await probeActiveView(spence.app, 'document.getElementById("js-popup").click()');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(2)).toHaveAttribute('data-active', 'true');
    await expect(tabs.nth(2).getByTestId('browser-page-title')).toHaveText('Popup Window Target');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/popup-window`);
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/popup-window`, title: 'Popup Window Target' }],
      });

    // Return to opener Page and trigger disallowed popup schemes -> denied without new Pages or windows.
    await tabs.nth(0).getByTestId('browser-page-select').click();
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/opener`, title: 'Opener Page' }],
      });

    await probeActiveView(spence.app, 'document.getElementById("bad-js").click()');
    await probeActiveView(spence.app, 'document.getElementById("bad-file").click()');
    await probeActiveView(spence.app, 'document.getElementById("bad-blank").click()');

    // Confirm asynchronously via round-trip evaluate that no popup window or Page was opened.
    await expect
      .poll(() => inspectAttachedViews(spence.app))
      .toEqual({
        windowCount: 1,
        views: [{ url: `${server.baseUrl}/opener`, title: 'Opener Page' }],
      });
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toHaveAttribute('data-active', 'true');
  } finally {
    await server.close();
  }
});
