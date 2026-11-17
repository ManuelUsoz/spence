import { expect, test } from '../fixtures';

test('a pending Permission request fills the Dock and can be answered', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('permission-mode-ask').click();
  await expect(page.getByTestId('permission-mode')).toContainText(
    spence.t({ en: 'Ask', es: 'Preguntar' }),
  );
  const composer = page.getByTestId('composer-input');
  // The fake Agent emits a Step, then a Permission request for it.
  await composer.fill('permit');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('dock-title')).toHaveText('ls -la');
  await expect(page.getByTestId('ticker')).toContainText(
    spence.t({ en: 'Waiting for you below', es: 'Esperando tu respuesta abajo' }),
  );
  await spence.shot('dock-permission', { mask: [page.getByTestId('project-path')] });

  await page.getByTestId('dock-option').first().click();
  await expect(page.getByTestId('dock')).toBeHidden();
  await expect(page.getByTestId('stop')).toBeHidden();
});

test('the Composer always shows the Ask / Auto Permission mode control', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('permission-mode')).toBeVisible();

  await spence.shot('composer-permission-mode', { mask: [page.getByTestId('project-path')] });

  // Switch to Ask and send a prompt; the fake Agent reports its current mode id.
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('permission-mode-ask').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('mode');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('message-agent')).toContainText('default');
  await expect(page.getByTestId('stop')).toBeHidden();
});
