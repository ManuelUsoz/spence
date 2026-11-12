import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, test } from '../fixtures';

test('reopens a Session with its thread after restart', async ({ spence }) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Hello before restart');
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello before restart');

  // Close the app, then relaunch with the same data directory.
  const executablePath = await spence.app.evaluate(() => process.execPath);
  await spence.app.close();
  const restarted = await electron.launch({
    executablePath,
    args: [process.cwd()],
    env: {
      ...process.env,
      SPENCE_E2E: '1',
      SPENCE_USER_DATA: spence.userData,
      SPENCE_LOCALE: 'en',
      SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
      SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
    },
  });
  const restartedPage = await restarted.firstWindow();
  await restartedPage.waitForLoadState('domcontentloaded');

  await expect(restartedPage.getByTestId('tab')).toHaveCount(1);
  await expect(restartedPage.getByTestId('tab-label')).toHaveText('New Session');
  await expect(restartedPage.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(restartedPage.getByTestId('message-agent')).toHaveText('Hello before restart');

  await expect(restartedPage).toHaveScreenshot('reopened-session.png', {
    mask: [restartedPage.getByTestId('project-path')],
  });
  await restarted.close();
});
