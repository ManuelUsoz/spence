import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';
import { expect, sandboxArgs, test } from '../fixtures';

const fakeAgentScript = path.resolve(__dirname, '..', '..', 'electron', 'acp', 'fakeAgent.mjs');

const writeFailRestoreShim = (binDir: string): void => {
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(binDir, 'fake-agent.cmd'),
      `@"${process.execPath}" "${fakeAgentScript}" --fail-resume --fail-load %*\n`,
    );
  } else {
    writeFileSync(
      path.join(binDir, 'fake-agent'),
      `#!/bin/sh\nexec "${process.execPath}" "${fakeAgentScript}" --fail-resume --fail-load "$@"\n`,
      { mode: 0o755 },
    );
  }
};

test('reopens a Session with its thread after restart', async ({ spence }) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Hello before restart');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello before restart');

  // Close the app, then relaunch with the same data directory.
  const executablePath = await spence.app.evaluate(() => process.execPath);
  await spence.app.close();
  const restarted = await electron.launch({
    executablePath,
    args: [process.cwd(), ...sandboxArgs],
    env: {
      ...process.env,
      SPENCE_E2E: '1',
      SPENCE_USER_DATA: spence.userData,
      SPENCE_LOCALE: spence.locale,
      SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
      SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
    },
  });
  const restartedPage = await restarted.firstWindow();
  await restartedPage.waitForLoadState('domcontentloaded');

  await expect(restartedPage.getByTestId('session-row')).toHaveCount(1);
  await expect(restartedPage.getByTestId('panel-title')).toHaveText('echo:Hello before restart');
  await expect(restartedPage.getByTestId('tab-title')).toHaveText('echo:Hello before restart');
  await expect(restartedPage.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(restartedPage.getByTestId('message-agent')).toHaveText('Hello before restart');

  await expect(restartedPage).toHaveScreenshot(spence.shotFile('reopened-session'), {
    mask: [restartedPage.getByTestId('project-path')],
  });
  await restarted.close();
});

test('gates Send behind memoryLost notice bar on reopen until Start with empty context', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Hello before restart');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello before restart');

  const executablePath = await spence.app.evaluate(() => process.execPath);
  await spence.app.close();
  writeFailRestoreShim(path.join(spence.userData, 'bin'));

  const restarted = await electron.launch({
    executablePath,
    args: [process.cwd(), ...sandboxArgs],
    env: {
      ...process.env,
      SPENCE_E2E: '1',
      SPENCE_USER_DATA: spence.userData,
      SPENCE_LOCALE: spence.locale,
      SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
      SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
    },
  });
  const restartedPage = await restarted.firstWindow();
  await restartedPage.waitForLoadState('domcontentloaded');

  await expect(restartedPage.getByTestId('message-user')).toHaveText('echo:Hello before restart');
  await expect(restartedPage.getByTestId('message-agent')).toHaveText('Hello before restart');
  await expect(restartedPage.getByTestId('memory-lost-bar')).toBeVisible();

  const restartedComposer = restartedPage.getByTestId('composer-input');
  await expect(restartedComposer).toBeEnabled();
  await restartedComposer.fill('echo:After restart');
  await expect(restartedPage.getByTestId('send')).toBeDisabled();

  await expect(restartedPage).toHaveScreenshot(spence.shotFile('memory-lost-gate'), {
    mask: [restartedPage.getByTestId('project-path')],
  });

  await restartedPage.getByTestId('start-empty-context').click();
  await expect(restartedPage.getByTestId('memory-lost-bar')).toBeHidden();
  await expect(restartedPage.getByTestId('send')).toBeEnabled();
  await restartedComposer.press('Enter');
  await expect(restartedPage.getByTestId('message-agent').nth(1)).toHaveText('After restart');
  await restarted.close();
});
