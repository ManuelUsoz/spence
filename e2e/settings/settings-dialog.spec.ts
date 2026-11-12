import { expect, test } from '../fixtures';

test.use({ spenceSettings: { theme: 'light' } });

test('Settings opens from the sidebar and switches the Theme to Dark at once', async ({
  spence,
}) => {
  const { page } = spence;
  const prefersDark = () => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
  await expect(page.getByTestId('no-chats')).toBeVisible();
  await expect.poll(prefersDark).toBe(false);

  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog.getByTestId('settings-general')).toBeVisible();
  await expect(dialog.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true');

  await dialog.getByTestId('theme-dark').click();
  await expect.poll(prefersDark).toBe(true);
  await expect(dialog.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'true');
  await spence.shot('settings-general');

  // Whether the Agent is installed depends on this machine's PATH (see CLAUDE.md on baselines).
  const agents = dialog.getByTestId('settings-agents');
  await agents.scrollIntoViewIfNeeded();
  await expect(agents.getByTestId('agent-claude')).toBeVisible();
  await expect(agents.getByText('Checking how to install')).toHaveCount(0);
  await spence.shot('settings-agents');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
