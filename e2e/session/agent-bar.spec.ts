import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';
import { seedManagedAdapter, seedManagedRuntime } from '../managed-runtime';

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
    await expect(bar.getByTestId('install')).toHaveText(spence.t({ en: 'Set up', es: 'Instalar' }));
    await expect(bar.getByTestId('show-command')).toHaveCount(0);
    await expect(bar.getByTestId('needs-node')).toHaveCount(0);
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

  test('sets up a missing managed npm Agent inline from AgentBar and enables sending', async ({
    spence,
  }) => {
    seedManagedRuntime(spence.userData);
    rmSync(path.join(spence.userData, 'bin'), { recursive: true, force: true });
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const bar = page.getByTestId('agent-bar');
    await expect(bar).toBeVisible();
    const installBtn = bar.getByTestId('install');
    await expect(installBtn).toHaveText(spence.t({ en: 'Set up', es: 'Instalar' }));

    const composer = page.getByTestId('composer-input');
    await composer.fill('echo:setup-ok');
    await expect(page.getByTestId('send')).toBeDisabled();

    await installBtn.click();
    await expect(bar).toBeHidden();
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('thread')).toContainText('setup-ok');
  });

  test('updates an unverified managed npm Agent inline from AgentBar and clears the notice', async ({
    spence,
  }) => {
    seedManagedRuntime(spence.userData);
    seedManagedAdapter(spence.userData, {
      agentId: 'fake',
      packageName: '@spence/fake-agent',
      binaryName: 'fake-agent',
      version: '0.9.0',
      entrypointFile: 'fake-agent.mjs',
    });
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const unverified = page.getByTestId('agent-unverified');
    await expect(unverified).toBeVisible();
    await expect(unverified).toContainText('0.9.0');
    const updateBtn = unverified.getByTestId('update-agent');
    await expect(updateBtn).toHaveText(spence.t({ en: 'Update', es: 'Actualizar' }));

    await updateBtn.click();
    await expect(unverified).toBeHidden();

    const composer = page.getByTestId('composer-input');
    await composer.fill('echo:updated-ok');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('thread')).toContainText('updated-ok');
  });
});
