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
    <title>Agent MCP Fixture</title>
    <link rel="icon" href="data:," />
  </head>
  <body>
    <h1>Agent Fixture</h1>
    <label for="username">Username</label>
    <input id="username" type="text" />
    <button id="submit-btn" type="button">Submit</button>
    <div id="status">Idle</div>
    <script>
      console.info('fixture booted');
      document.getElementById('submit-btn').addEventListener('click', async () => {
        const val = document.getElementById('username').value;
        document.getElementById('status').textContent = 'Hello, ' + val;
        console.log('submitted:' + val);
        await fetch('/api/ping?token=secret-query-value', {
          headers: { Authorization: 'Bearer secret-header-value' },
        });
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (reqUrl.pathname === '/api/ping') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'session=super-secret-cookie; Path=/',
      });
      res.end(JSON.stringify({ ok: true }));
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

interface McpToolResponse {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly data?: string;
    readonly mimeType?: string;
  }>;
}

const runBrowserMcp = async (
  page: Parameters<Parameters<typeof test>[1]>[0]['spence']['page'],
  tool: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResponse> => {
  const index = await page.getByTestId('message-agent').count();
  await page.getByTestId('composer-input').fill(`browser-mcp:${tool}:${JSON.stringify(args)}`);
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');

  const msg = page.getByTestId('message-agent').nth(index);
  await expect(msg).toBeVisible();

  const code = msg.locator('code').first();
  await expect(code).toBeVisible();

  let parsed: McpToolResponse | undefined;
  await expect
    .poll(async () => {
      const raw = await code.innerText();
      try {
        parsed = JSON.parse(raw) as McpToolResponse;
        return Array.isArray(parsed.content);
      } catch {
        return false;
      }
    })
    .toBe(true);

  if (parsed === undefined) throw new Error(`Missing parsed MCP response for ${tool}`);
  return parsed;
};

test('drives real WebContentsView via spence-browser MCP snapshot, fill, click, screenshot, console, and redacted network', async ({
  spence,
}) => {
  const server = await startFixtureServer();
  const page = spence.page;

  try {
    await page.getByTestId('add-project').click();
    await page.getByTestId('new-session').click();

    await page.getByTestId('toggle-browser').click();
    await expect(page.getByTestId('browser-pane')).toBeVisible();

    const nav = await runBrowserMcp(page, 'navigate', { url: `${server.baseUrl}/` });
    expect(nav.isError).not.toBe(true);

    const waited = await runBrowserMcp(page, 'wait_for', {
      selector: '#submit-btn',
      text: 'Idle',
      timeoutMs: 5000,
    });
    expect(waited.isError).not.toBe(true);

    const snap = await runBrowserMcp(page, 'snapshot');
    expect(snap.isError).not.toBe(true);
    const snapText = snap.content[0]?.text ?? '';
    expect(snapText).toContain('Agent MCP Fixture');

    const inputMatch = /textbox "Username" \[ref=(e\d+)\]/.exec(snapText);
    const buttonMatch = /button "Submit" \[ref=(e\d+)\]/.exec(snapText);
    expect(inputMatch?.[1]).toBeTruthy();
    expect(buttonMatch?.[1]).toBeTruthy();
    const inputRef = inputMatch?.[1] ?? '';
    const buttonRef = buttonMatch?.[1] ?? '';

    const filled = await runBrowserMcp(page, 'fill', {
      ref: inputRef,
      value: 'Ada Lovelace',
    });
    expect(filled.isError).not.toBe(true);

    const clicked = await runBrowserMcp(page, 'click', { ref: buttonRef });
    expect(clicked.isError).not.toBe(true);

    const waitedStatus = await runBrowserMcp(page, 'wait_for', {
      text: 'Hello, Ada Lovelace',
      timeoutMs: 5000,
    });
    expect(waitedStatus.isError).not.toBe(true);

    const evaluated = await runBrowserMcp(page, 'eval', {
      expression: "document.getElementById('status')?.textContent",
    });
    expect(evaluated.isError).not.toBe(true);
    expect(JSON.parse(evaluated.content[0]?.text ?? '{}')).toEqual({
      value: 'Hello, Ada Lovelace',
      type: 'string',
    });

    const consoleLogs = await runBrowserMcp(page, 'console');
    expect(consoleLogs.isError).not.toBe(true);
    const consolePayload = JSON.parse(consoleLogs.content[0]?.text ?? '{}') as {
      readonly entries: ReadonlyArray<{ readonly level: string; readonly message: string }>;
    };
    const messages = consolePayload.entries.map((e) => e.message);
    expect(messages).toContain('fixture booted');
    expect(messages).toContain('submitted:Ada Lovelace');

    const netLogs = await runBrowserMcp(page, 'network', { urlContains: '/api/ping' });
    expect(netLogs.isError).not.toBe(true);
    const netText = netLogs.content[0]?.text ?? '';
    expect(netText).toContain('/api/ping');
    expect(netText).not.toContain('secret-query-value');
    expect(netText).not.toContain('secret-header-value');
    expect(netText).not.toContain('super-secret-cookie');

    const shot = await runBrowserMcp(page, 'screenshot');
    expect(shot.isError).not.toBe(true);
    expect(shot.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect((shot.content[0]?.data ?? '').length).toBeGreaterThan(20);
  } finally {
    await server.close();
  }
});
