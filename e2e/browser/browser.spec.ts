import { _electron as electron } from '@playwright/test';
import { createServer } from 'node:http';
import path from 'node:path';
import { expect, sandboxArgs, test } from '../fixtures';

const root = path.resolve(__dirname, '../..');

const startFixtureServer = async () => {
  const seenCookieHeaders: string[] = [];
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.headers.cookie) seenCookieHeaders.push(req.headers.cookie);

    if (reqUrl.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'spence_persist=cookie-ok; Max-Age=3600; Path=/',
      });
      res.end(
        '<!doctype html><html><head><title>Fixture Home</title></head><body><h1>Home</h1></body></html>',
      );
      return;
    }

    if (reqUrl.pathname === '/page2') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><title>Fixture Page Two</title></head><body><div id="cookie">${req.headers.cookie ?? ''}</div></body></html>`,
      );
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Expected TCP address from fixture HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    seenCookieHeaders,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test('embedded Browser syncs WebContentsView bounds, enforces zero-preload isolation, navigates, and resizes', async ({
  spence,
}) => {
  const server = await startFixtureServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();
    await page.getByTestId('new-session').click();
    await page.getByTestId('composer-input').fill('echo:Inspecting preview');
    await expect(page.getByTestId('send')).toBeEnabled();
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('message-agent')).toHaveText('Inspecting preview');

    const toggle = page.getByTestId('toggle-browser');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeEnabled();

    await toggle.click();
    await expect(page.getByTestId('shell-split')).toBeVisible();
    await expect(page.getByTestId('browser-pane')).toBeVisible();
    await expect(page.getByTestId('browser-url-input')).toHaveValue('about:blank');

    await spence.shot('browser-pane-open', { mask: [page.getByTestId('project-path')] });

    const urlInput = page.getByTestId('browser-url-input');
    await urlInput.fill(`${server.baseUrl}/`);
    await urlInput.press('Enter');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/`);

    // Wait for the WebContentsView to finish loading and inspect isolation, title, and bounds.
    await expect
      .poll(async () =>
        spence.app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            | {
                readonly webContents: Electron.WebContents;
                getBounds: () => Electron.Rectangle;
              }
            | undefined;
          if (!view) return null;
          const probe = (await view.webContents.executeJavaScript(
            '({ desktop: typeof window.desktop, requireType: typeof window.require, cookie: document.cookie })',
          )) as { desktop: string; requireType: string; cookie: string };
          return {
            url: view.webContents.getURL(),
            title: view.webContents.getTitle(),
            bounds: view.getBounds(),
            ...probe,
          };
        }),
      )
      .toMatchObject({
        url: `${server.baseUrl}/`,
        title: 'Fixture Home',
        desktop: 'undefined',
        requireType: 'undefined',
        cookie: expect.stringContaining('spence_persist=cookie-ok'),
      });

    const viewportBox = await page.getByTestId('browser-viewport').boundingBox();
    expect(viewportBox).not.toBeNull();
    const viewBounds = await spence.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => 'webContents' in child);
      return view?.getBounds() ?? null;
    });
    expect(viewBounds).not.toBeNull();
    if (viewportBox && viewBounds) {
      expect(Math.abs(viewBounds.x - Math.round(viewportBox.x))).toBeLessThanOrEqual(2);
      expect(Math.abs(viewBounds.y - Math.round(viewportBox.y))).toBeLessThanOrEqual(2);
      expect(Math.abs(viewBounds.width - Math.round(viewportBox.width))).toBeLessThanOrEqual(2);
      expect(Math.abs(viewBounds.height - Math.round(viewportBox.height))).toBeLessThanOrEqual(2);
    }

    // Shrink the Browser so the available window width cannot cap the requested growth.
    const handleBox = await page.getByTestId('browser-resize-handle').boundingBox();
    expect(handleBox).not.toBeNull();
    if (handleBox) {
      const cx = handleBox.x + handleBox.width / 2;
      const cy = handleBox.y + handleBox.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + 120, cy);
      await page.mouse.up();
    }

    await expect
      .poll(async () =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child);
          return view?.getBounds().width ?? 0;
        }),
      )
      .toBeLessThan((viewBounds?.width ?? 0) - 80);

    // Navigate to page2, verify back/forward/reload, and hide/restore across Settings.
    await urlInput.fill(`${server.baseUrl}/page2`);
    await urlInput.press('Enter');
    await expect(urlInput).toHaveValue(`${server.baseUrl}/page2`);
    await expect(page.getByTestId('browser-back')).toBeEnabled();

    await page.getByTestId('browser-back').click();
    await expect(urlInput).toHaveValue(`${server.baseUrl}/`);
    await expect(page.getByTestId('browser-forward')).toBeEnabled();

    await page.getByTestId('browser-forward').click();
    await expect(urlInput).toHaveValue(`${server.baseUrl}/page2`);

    await page.getByTestId('browser-reload').click();
    await expect(urlInput).toHaveValue(`${server.baseUrl}/page2`);

    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect
      .poll(async () =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          return win?.contentView.children.filter((child) => 'webContents' in child).length ?? 0;
        }),
      )
      .toBe(0);

    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('shell-split')).toBeVisible();
    await expect
      .poll(async () =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          return win?.contentView.children.filter((child) => 'webContents' in child).length ?? 0;
        }),
      )
      .toBe(1);
  } finally {
    await server.close();
  }
});

test('persists cookies across restarts in persist:spence-browser', async ({ spence }) => {
  test.setTimeout(90_000);
  const server = await startFixtureServer();

  try {
    await spence.page.getByTestId('add-project').click();
    await spence.page.getByTestId('new-session').click();
    await spence.page.getByTestId('toggle-browser').click();
    const input = spence.page.getByTestId('browser-url-input');
    await input.fill(`${server.baseUrl}/`);
    await input.press('Enter');

    await expect
      .poll(async () =>
        spence.app.evaluate(async ({ session }, targetUrl) => {
          const cookies = await session
            .fromPartition('persist:spence-browser')
            .cookies.get({ url: targetUrl });
          return cookies.map((c) => `${c.name}=${c.value}`);
        }, server.baseUrl),
      )
      .toContain('spence_persist=cookie-ok');

    await spence.app.evaluate(async ({ session }) => {
      await session.fromPartition('persist:spence-browser').cookies.flushStore();
    });

    const executablePath = await spence.app.evaluate(() => process.execPath);
    await spence.app.close();

    const restarted = await electron.launch({
      executablePath,
      args: [root, ...sandboxArgs],
      colorScheme: null,
      env: {
        ...process.env,
        SPENCE_E2E: '1',
        SPENCE_USER_DATA: spence.userData,
        SPENCE_LOCALE: spence.locale,
        SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
        SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
      },
    });
    try {
      const restartedPage = await restarted.firstWindow();
      await restartedPage.waitForLoadState('domcontentloaded');
      await expect(restartedPage.getByTestId('current-project')).toContainText('demo-project');
      await restartedPage.getByTestId('new-session').click();
      await restartedPage.getByTestId('toggle-browser').click();
      const restartedInput = restartedPage.getByTestId('browser-url-input');
      await restartedInput.fill(`${server.baseUrl}/page2`);
      await restartedInput.press('Enter');
      await expect
        .poll(() =>
          server.seenCookieHeaders.some((header) => header.includes('spence_persist=cookie-ok')),
        )
        .toBe(true);
    } finally {
      await restarted.close();
    }
  } finally {
    await server.close();
  }
});
