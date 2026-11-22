import { expect, test } from '../fixtures';

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Session actions menu (Mod+Shift+K), Mod+K search focus, /compact intercept, and Compaction', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();
  await expect(page.getByTestId('effort-current')).toBeVisible();

  // Mod+K stays bound to the sidebar Session search.
  await page.keyboard.press(`${modKey}+k`);
  await expect(page.getByTestId('session-search')).toBeFocused();
  await expect(page.getByTestId('session-actions-menu')).toHaveCount(0);

  // Mod+Shift+K opens the top bar Session actions: compact, clear and switch; Fork lives on the Turn.
  await page.getByTestId('composer-input').click();
  await page.keyboard.press(`${modKey}+Shift+K`);
  const menu = page.getByTestId('session-actions-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('session-action-compact')).toBeEnabled();
  await expect(page.getByTestId('session-action-clear')).toBeEnabled();
  await expect(page.getByTestId('session-action-switch-agent')).toBeEnabled();
  await expect(page.getByTestId('session-action-fork')).toHaveCount(0);
  await spence.shot('session-actions-menu', { mask: [page.getByTestId('project-path')] });

  // Esc dismisses without cancelling anything.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Send a prompt that reports Context usage, then invoke Compact from the menu.
  await page.getByTestId('composer-input').fill('usage:24000/200000');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('context-ring-arc')).toBeVisible();

  await page.getByTestId('session-actions-trigger').click();
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('session-context-label')).toContainText('12');
  await page.getByTestId('session-action-compact').click();

  // Compaction streams into the Thread and settles to Compacted.
  const compaction = page.getByTestId('compaction');
  await expect(compaction).toBeVisible();
  await expect(compaction).toContainText(spence.t({ en: 'Compacted', es: 'Compactado' }));
  await spence.shot('thread-compacted', { mask: [page.getByTestId('project-path')] });

  // `/clear` intercepts into Spence's Clear boundary instead of sending as a prompt.
  await page.getByTestId('composer-input').fill('/clear');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('context-divider')).toBeVisible();
});

test('the ⋯ menu renames, archives and deletes the open Session', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('echo:Top bar');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Top bar');
  await expect(page.getByTestId('panel-title')).toHaveText('echo:Top bar');

  // Rename in place; the sidebar row and Tab follow.
  await page.getByTestId('session-actions-trigger').click();
  await page.getByTestId('menu-rename').click();
  const editor = page.getByTestId('panel-rename');
  await expect(editor).toBeFocused();
  await editor.fill('Renamed from the top bar');
  await spence.shot('topbar-rename', { mask: [page.getByTestId('project-path')] });
  await editor.press('Enter');
  await expect(page.getByTestId('panel-title')).toHaveText('Renamed from the top bar');
  await expect(page.getByTestId('tab-title')).toHaveText('Renamed from the top bar');
  await expect(page.getByTestId('session-row')).toContainText('Renamed from the top bar');

  // Archive closes the Session and files it under Archived.
  await page.getByTestId('session-actions-trigger').click();
  await page.getByTestId('menu-archive').click();
  await expect(page.getByTestId('session-actions-trigger')).toHaveCount(0);
  await expect(page.getByTestId('archived-fold')).toContainText(
    spence.t({ en: 'Archived (1)', es: 'Archivadas (1)' }),
  );
});
