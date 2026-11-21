import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const startFixtureServer = async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><title>Occlusion Fixture</title></head><body style="margin:0;background:#1e293b;color:#f8fafc;font-family:sans-serif;padding:24px;"><h1>Fixture Ready</h1></body></html>',
    );
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

const attachedWebViewCount = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return win?.contentView.children.filter((child) => 'webContents' in child).length ?? 0;
  });

test('overlays, tooltips, and full-page views remain visible and clickable over an open Browser pane', async ({
  spence,
}) => {
  const server = await startFixtureServer();
  const page = spence.page;

  try {
    const repo = spence.pickFolder;
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'e2e@spence.local');
    git(repo, 'config', 'user.name', 'Spence E2E');
    writeFileSync(path.join(repo, 'readme.md'), 'hello\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'Initial commit');
    writeFileSync(path.join(repo, 'readme.md'), 'hello\nworld\n');

    await page.getByTestId('add-project').click();
    await page.getByTestId('new-session').click();
    await page.getByTestId('composer-input').fill('echo:Testing occlusion');
    await expect(page.getByTestId('send')).toBeEnabled();
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('message-agent')).toHaveText('Testing occlusion');

    await page.getByTestId('toggle-browser').click();
    await expect(page.getByTestId('shell-split')).toBeVisible();

    const urlInput = page.getByTestId('browser-url-input');
    await urlInput.fill(`${server.baseUrl}/`);
    await urlInput.press('Enter');

    await expect
      .poll(() =>
        spence.app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win?.contentView.children.find((child) => 'webContents' in child) as
            { readonly webContents: Electron.WebContents } | undefined;
          return view?.webContents.getTitle() ?? null;
        }),
      )
      .toBe('Occlusion Fixture');
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 1. Left-sidebar tooltip stays outside the Browser slot and must NOT occlude the native view.
    await page.getByTestId('new-session').hover();
    await expect(page.locator('.cdk-overlay-container [role="tooltip"]')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);
    await page.getByTestId('composer-input').hover();
    await expect(page.locator('.cdk-overlay-container [role="tooltip"]')).toHaveCount(0);

    // 2. Dropdown menu (TopBar Session actions) occludes WebContentsView, shows static frame, and clicks work.
    await page.getByTestId('session-actions-trigger').click();
    await expect(page.getByTestId('session-actions-menu')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
    await expect(page.getByTestId('browser-occluded-frame')).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    );

    await page.getByTestId('menu-rename').click();
    await expect(page.getByTestId('topbar-rename')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('topbar-rename')).toHaveCount(0);
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);
    await expect(page.getByTestId('browser-occluded-frame')).toHaveCount(0);

    // Browser overflow menu also occludes and restores on Escape.
    await page.getByTestId('browser-more').click();
    await expect(page.getByTestId('browser-more-menu')).toBeVisible();
    await expect(page.getByTestId('browser-devtools')).toBeEnabled();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('browser-more-menu')).toHaveCount(0);
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 3. Project settings sheet covers the right-hand Browser pane and remains interactive.
    await page.getByTestId('current-project').click({ button: 'right' });
    await page.getByTestId('project-menu-settings').click();
    await expect(page.getByTestId('project-settings')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
    await expect(page.getByTestId('browser-occluded-frame')).toHaveAttribute(
      'src',
      /^data:image\/png;base64,/,
    );

    await page.getByTestId('project-permission-ask').click();
    await expect(page.getByTestId('project-permission')).toHaveAttribute('data-inherited', 'false');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('project-settings')).toBeHidden();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 4. Delete confirm alert-dialog renders above and restores on Cancel.
    await page.getByTestId('session-actions-trigger').click();
    await page.getByTestId('menu-delete').click();
    await expect(page.getByTestId('session-confirm-dialog')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);

    await page.getByTestId('confirm-cancel').click();
    await expect(page.getByTestId('session-confirm-dialog')).toHaveCount(0);
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 5. Full-page Settings view hides WebContentsView and restores on return.
    await page.getByTestId('open-settings').click();
    await expect(page.getByTestId('settings-page')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('shell-split')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 6. Full-page Changes view hides WebContentsView and restores on return.
    await page.getByTestId('open-changes').click();
    await expect(page.getByTestId('topbar-title')).toHaveText(
      spence.t({ en: 'Changes', es: 'Cambios' }),
    );
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
    await page.getByTestId('changes-back').click();
    await expect(page.getByTestId('shell-split')).toBeVisible();
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(1);

    // 7. Deleting the only Session moves to empty state and hides WebContentsView.
    await page.getByTestId('session-actions-trigger').click();
    await page.getByTestId('menu-delete').click();
    await expect(page.getByTestId('session-confirm-dialog')).toBeVisible();
    await page.getByTestId('confirm-action').click();
    await expect(page.getByTestId('shell-split')).toHaveCount(0);
    await expect.poll(() => attachedWebViewCount(spence.app)).toBe(0);
  } finally {
    await server.close();
  }
});
