import { createServer } from 'node:http';
import { expect, test } from '../fixtures';

const startFixtureServer = async () => {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (reqUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Bridge Fixture</title>
    <link rel="icon" href="data:," />
    <style>
      body { font-family: sans-serif; margin: 24px; background: #f8fafc; color: #0f172a; }
      .cta { display: inline-block; padding: 12px 20px; background: #1d4ed8; color: #ffffff; border-radius: 8px; text-decoration: none; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1 id="heading">Bridge Fixture</h1>
    <a id="nav-link" class="cta" href="/navigated">Checkout link</a>
  </body>
</html>`);
      return;
    }

    if (reqUrl.pathname === '/clean') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Clean Page</title><link rel="icon" href="data:," /></head>
  <body><p>No errors here</p></body>
</html>`);
      return;
    }

    if (reqUrl.pathname === '/navigated') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>Navigated</title></head><body><h1>Navigated Away</h1></body></html>',
      );
      return;
    }

    if (reqUrl.pathname === '/api/broken') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'boom' }));
      return;
    }

    res.writeHead(204);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('Expected TCP address from fixture HTTP server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test('bridges Browser screenshots, Element picker selection/cancel, and console/network errors into Composer', async ({
  spence,
}) => {
  const server = await startFixtureServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();
    await page.getByTestId('new-session').click();
    await page.getByTestId('composer-input').fill('echo:Ready');
    await expect(page.getByTestId('send')).toBeEnabled();
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('message-agent')).toHaveText('Ready');

    await page.getByTestId('toggle-browser').click();
    await expect(page.getByTestId('browser-pane')).toBeVisible();

    const urlInput = page.getByTestId('browser-url-input');
    await urlInput.fill(`${server.baseUrl}/`);
    await urlInput.press('Enter');

    await expect
      .poll(async () =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            { readonly webContents: Electron.WebContents } | undefined;
          if (!view || view.webContents.isLoading()) return null;
          return { url: view.webContents.getURL(), title: view.webContents.getTitle() };
        }),
      )
      .toEqual({ url: `${server.baseUrl}/`, title: 'Bridge Fixture' });

    // Empty-state toast when no console or network errors have been recorded.
    const emptyToastText = spence.t({
      en: 'No console or network errors recorded on this Page.',
      es: 'No hay errores de consola ni de red registrados en esta Página.',
    });
    const errorsBtn = page.getByTestId('browser-console-errors');
    await errorsBtn.click();
    await expect(page.getByText(emptyToastText)).toBeVisible();
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    await expect(page.getByText(emptyToastText)).toHaveCount(0);

    // Screenshot attaches a PNG image into the Composer and sends it in the next Message.
    await page.getByTestId('browser-screenshot').click();
    await expect(page.getByTestId('composer-images').getByTestId('image-thumbnail')).toHaveCount(1);

    await page.getByTestId('composer-input').fill('echo:Check screenshot');
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('message-images')).toHaveCount(1);
    await expect(page.getByTestId('message-images').locator('img')).toHaveCount(1);

    // Element picker enters active mode, highlights on hover, and cancels cleanly on Escape.
    const pickerBtn = page.getByTestId('browser-element-picker');
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(async () =>
        spence.app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            { readonly webContents: Electron.WebContents } | undefined;
          if (!view) return false;
          return (await view.webContents.executeJavaScript(
            "document.querySelector('[data-spence-picker-overlay]') !== null",
          )) as boolean;
        }),
      )
      .toBe(true);

    // Escape inside the Page cancels picker and removes the overlay.
    await spence.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => 'webContents' in child) as
        { readonly webContents: Electron.WebContents } | undefined;
      view?.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      view?.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    });
    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () =>
        spence.app.evaluate(async ({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            { readonly webContents: Electron.WebContents } | undefined;
          if (!view) return null;
          return (await view.webContents.executeJavaScript(
            "document.querySelector('[data-spence-picker-overlay]') !== null",
          )) as boolean;
        }),
      )
      .toBe(false);

    // Escape in the main renderer window also cancels picker mode.
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'false');

    // Hover + click over an <a> link selects the element, inserts snippet, and blocks navigation.
    await pickerBtn.click();
    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'true');

    const linkCenter = await spence.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => 'webContents' in child) as
        { readonly webContents: Electron.WebContents } | undefined;
      if (!view) return null;
      return (await view.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('nav-link');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`)) as { x: number; y: number } | null;
    });
    expect(linkCenter).not.toBeNull();
    if (linkCenter) {
      await spence.app.evaluate(({ BrowserWindow }, pt) => {
        const win = BrowserWindow.getAllWindows()[0];
        const view = win?.contentView.children.find((child) => 'webContents' in child) as
          { readonly webContents: Electron.WebContents } | undefined;
        view?.webContents.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      }, linkCenter);

      await expect
        .poll(async () =>
          spence.app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            const view = win?.contentView.children.find((child) => 'webContents' in child) as
              { readonly webContents: Electron.WebContents } | undefined;
            if (!view) return null;
            return (await view.webContents.executeJavaScript(`(() => {
              const ov = document.querySelector('[data-spence-picker-overlay]');
              if (!ov) return null;
              return { display: getComputedStyle(ov).display, text: ov.textContent || '' };
            })()`)) as { display: string; text: string } | null;
          }),
        )
        .toEqual({ display: 'block', text: '#nav-link' });

      await spence.app.evaluate(({ BrowserWindow }, pt) => {
        const win = BrowserWindow.getAllWindows()[0];
        const view = win?.contentView.children.find((child) => 'webContents' in child) as
          { readonly webContents: Electron.WebContents } | undefined;
        view?.webContents.sendInputEvent({
          type: 'mouseDown',
          x: pt.x,
          y: pt.y,
          button: 'left',
          clickCount: 1,
        });
        view?.webContents.sendInputEvent({
          type: 'mouseUp',
          x: pt.x,
          y: pt.y,
          button: 'left',
          clickCount: 1,
        });
      }, linkCenter);
    }

    await expect(pickerBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('composer-input')).toHaveValue(/#nav-link/);
    await expect(page.getByTestId('composer-input')).toHaveValue(/Checkout link/);
    await expect(page.getByTestId('composer-input')).toHaveValue(/<a id="nav-link"/);

    // Clicking the link in picker mode must NOT navigate the Page.
    const currentUrl = await spence.app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => 'webContents' in child) as
        { readonly webContents: Electron.WebContents } | undefined;
      return view?.webContents.getURL() ?? '';
    });
    expect(currentUrl).toBe(`${server.baseUrl}/`);

    // Trigger both a console.error and a failed 500 fetch inside the Page, then attach them.
    await spence.app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const view = win?.contentView.children.find((child) => 'webContents' in child) as
        { readonly webContents: Electron.WebContents } | undefined;
      if (!view) return;
      await view.webContents.executeJavaScript(`(() => {
        console.error('Widget render failed');
        return fetch('/api/broken').then((r) => r.status);
      })()`);
    });

    await errorsBtn.click();
    await expect(page.getByTestId('composer-input')).toHaveValue(/Widget render failed/);
    await expect(page.getByTestId('composer-input')).toHaveValue(/\[network\].*500.*\/api\/broken/);

    // Also attach a screenshot alongside the snippets to capture the populated Composer baseline.
    await page.getByTestId('browser-screenshot').click();
    await expect(page.getByTestId('composer-images').getByTestId('image-thumbnail')).toHaveCount(1);
    await spence.shot('composer-bridge-attached', {
      mask: [page.getByTestId('project-path'), page.getByTestId('browser-url-input')],
    });

    // A second Session's Page has isolated error buffers (no errors recorded).
    await page.getByTestId('new-session').click();
    await page.getByTestId('toggle-browser').click();
    await page.getByTestId('browser-url-input').fill(`${server.baseUrl}/clean`);
    await page.getByTestId('browser-url-input').press('Enter');
    await expect
      .poll(async () =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            { readonly webContents: Electron.WebContents } | undefined;
          if (!view || view.webContents.isLoading()) return null;
          return view.webContents.getURL();
        }),
      )
      .toBe(`${server.baseUrl}/clean`);
    await page.getByTestId('browser-console-errors').click();
    await expect(page.getByText(emptyToastText).last()).toBeVisible();
  } finally {
    await server.close();
  }
});
