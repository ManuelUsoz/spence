import { expect, test } from '../fixtures';

test('a working Turn folds into Ticker, Receipt and Dock Plan', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  // `busy` stays running until cancelled, so the running states are stable to capture.
  await composer.fill('busy');
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toHaveText('busy');
  await expect(page.getByTestId('ticker')).toBeVisible();
  const mask = [
    page.getByTestId('project-path'),
    page.locator('[data-testid="ticker"] .tabular-nums'),
    page.locator('[data-testid="receipt"] [data-slot="trace-description"]'),
  ];
  await spence.shot('thread-running', { mask });

  await expect(page.getByTestId('dock')).toContainText('Plan');
  await page.getByTestId('dock').getByRole('button').click();
  await spence.shot('dock-plan', { mask });

  await page.getByTestId('stop').click();
  await expect(page.getByTestId('stop')).toBeHidden();
  await page.getByTestId('new-session').click();
  await composer.fill('work');
  await composer.press('Enter');

  await expect(page.getByTestId('receipt').last()).toBeVisible();
  await expect(page.getByTestId('message-agent')).toContainText('greeting');
  await spence.shot('thread-receipt', { mask });

  await page
    .getByTestId('receipt')
    .last()
    .getByRole('button', { name: /view\.ts/ })
    .click();
  await expect(page.getByTestId('file-diff')).toBeVisible();
  await spence.shot('thread-receipt-open', { mask });
});
