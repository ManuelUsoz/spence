import { expect, test } from '../fixtures';

test('the sidebar starts chats and opens Settings, with the view beside it', async ({ spence }) => {
  const page = spence.page;
  await expect(page.getByTestId('no-chats')).toBeVisible();
  await expect(page.getByTestId('load-info')).toBeVisible();
  await spence.shot('shell-empty');

  await page.getByTestId('new-chat').click();
  await page.getByTestId('new-chat').click();
  await expect(
    page.getByTestId('chat-list').getByRole('button', { name: /^Chat \d$/ }),
  ).toHaveCount(2);
  await spence.shot('shell-two-chats');

  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await expect(page.getByTestId('settings-general')).toBeVisible();
  await spence.shot('shell-settings');

  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});
