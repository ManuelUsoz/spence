import { expect, test } from '../fixtures';

test('opens an active owned Worker and returns to its Parent Session', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('delegate:busy');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('workers-toggle')).toContainText('1');
  await page.getByTestId('workers-toggle').click();
  await page.getByTestId('worker-row').click();
  await expect(page.getByTestId('worker-parent')).toBeVisible();
  await expect(page.getByTestId('message-user')).toContainText('busy');
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('stop')).toBeHidden();
  await composer.fill('echo:Worker follow-up');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toContainText('Worker follow-up');
  await page.getByTestId('worker-parent').click();
  await expect(page.getByTestId('message-user')).toContainText('delegate:busy');
});
