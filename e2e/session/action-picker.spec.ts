import { expect, test } from '../fixtures';

const modKey = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Session action picker (Mod+Shift+K), Mod+K search preservation, /compact intercept, and Compaction', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();

  // Mod+K stays bound to sidebar Session search.
  await page.keyboard.press(`${modKey}+k`);
  await expect(page.getByTestId('session-search')).toBeFocused();
  await expect(page.getByTestId('session-actions-picker')).toHaveCount(0);

  // Mod+Shift+K opens the searchable Session action picker with all four operations.
  await page.getByTestId('composer-input').click();
  await page.keyboard.press(`${modKey}+Shift+K`);
  const picker = page.getByTestId('session-actions-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('session-action-compact')).toBeEnabled();
  await expect(page.getByTestId('session-action-clear')).toBeEnabled();
  await expect(page.getByTestId('session-action-switch-agent')).toBeEnabled();
  await expect(page.getByTestId('session-action-fork')).toBeDisabled();
  await spence.shot('session-action-picker', { mask: [page.getByTestId('project-path')] });

  // Esc dismisses without cancelling anything.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // Send a prompt that reports Context usage, then invoke Compact from the picker.
  await page.getByTestId('composer-input').fill('usage:24000/200000');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('context-ring-arc')).toBeVisible();

  await page.getByTestId('session-actions-trigger').click();
  await expect(picker).toBeVisible();
  await page.getByTestId('session-actions-search').fill('comp');
  await expect(page.getByTestId('session-action-compact')).toBeVisible();
  await expect(page.getByTestId('session-action-clear')).toHaveCount(0);
  await page.getByTestId('session-actions-search').press('Enter');

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
