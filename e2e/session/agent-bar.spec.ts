import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const fakeAgentScript = path.resolve(__dirname, '..', '..', 'electron', 'acp', 'fakeAgent.mjs');

const writeShim = (userData: string, extraArgs: string): void => {
  const bin = path.join(userData, 'bin');
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(bin, 'fake-agent.cmd'),
      `@"${process.execPath}" "${fakeAgentScript}" ${extraArgs} %*\r\n`,
    );
  } else {
    writeFileSync(
      path.join(bin, 'fake-agent'),
      `#!/bin/sh\nexec "${process.execPath}" "${fakeAgentScript}" ${extraArgs} "$@"\n`,
      { mode: 0o755 },
    );
  }
};

test.describe('Agent bar and Turn failures', () => {
  test('shows the install offer when the Agent is not installed and recovers when restored', async ({
    spence,
  }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    rmSync(path.join(spence.userData, 'bin'), { recursive: true, force: true });
    await page.getByTestId('new-session').click();

    const bar = page.getByTestId('agent-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText('Fake');
    await expect(page.getByTestId('composer-input')).toBeEditable();
    await page.getByTestId('composer-input').fill('Draft before install');
    await expect(page.getByTestId('send')).toBeDisabled();

    await spence.shot('agent-bar-not-installed', { mask: [page.getByTestId('project-path')] });
  });

  test('shows cantStart with Try again and Open log, then recovers on Try again', async ({
    spence,
  }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    writeShim(spence.userData, '--fail-init');
    await page.getByTestId('new-session').click();

    const bar = page.getByTestId('agent-bar');
    await expect(bar).toContainText(
      spence.t({ en: "Fake couldn't start", es: 'Fake no pudo iniciarse' }),
    );
    await expect(page.getByTestId('agent-retry')).toBeVisible();
    await expect(page.getByTestId('open-agent-log')).toBeVisible();
    await page.getByTestId('composer-input').fill('Keep this draft');
    await expect(page.getByTestId('send')).toBeDisabled();

    await spence.shot('agent-bar-cant-start', { mask: [page.getByTestId('project-path')] });

    writeShim(spence.userData, '');
    await page.getByTestId('agent-retry').click();
    await expect(bar).toBeHidden();
    await expect(page.getByTestId('send')).toBeEnabled();
  });

  test('shows needsLogin on -32000, supports Log in and Cancel, and restores the failed prompt', async ({
    spence,
  }) => {
    const page = spence.page;
    writeShim(spence.userData, '--extra-auth --login-hold');
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const composer = page.getByTestId('composer-input');
    await composer.fill('login');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');

    const bar = page.getByTestId('agent-bar');
    await expect(bar).toContainText(
      spence.t({ en: 'Fake needs to log in', es: 'Fake necesita iniciar sesión' }),
    );
    await expect(page.getByTestId('agent-login')).toBeVisible();
    await expect(composer).toHaveValue('login');
    await expect(page.getByTestId('send')).toBeDisabled();

    await spence.shot('agent-bar-login', { mask: [page.getByTestId('project-path')] });

    await page.getByTestId('agent-login').click();
    await expect(bar).toContainText(
      spence.t({
        en: 'Finish logging in in your browser…',
        es: 'Termina de iniciar sesión en tu navegador…',
      }),
    );
    await expect(bar).toContainText(spence.t({ en: 'Other ways', es: 'Otras formas' }));
    await page.getByTestId('agent-login-cancel').click();
    await expect(page.getByTestId('agent-login')).toBeVisible();
  });

  test('shows folded crash diagnostics on agentStopped and restores the prompt', async ({
    spence,
  }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const composer = page.getByTestId('composer-input');
    await composer.fill('crash');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');

    const outcome = page.getByTestId('outcome');
    await expect(outcome).toContainText(
      spence.t({ en: 'Fake stopped unexpectedly', es: 'Fake se detuvo inesperadamente' }),
    );
    await expect(composer).toHaveValue('crash');

    await spence.shot('thread-agent-stopped', { mask: [page.getByTestId('project-path')] });

    await outcome.locator('summary').click();
    await expect(outcome.locator('pre')).toContainText('exit code 3');
  });
});
