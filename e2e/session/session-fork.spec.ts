import { _electron as electron, expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const electronPath: string = createRequire(path.join(root, 'package.json'))('electron');
const fakeAgentScript = path.join(root, 'electron', 'acp', 'fakeAgent.mjs');

const writeShim = (bin: string, commandName: string, extraArgs: string): void => {
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(bin, `${commandName}.cmd`),
      `@"${process.execPath}" "${fakeAgentScript}" ${extraArgs} %*\r\n`,
    );
  } else {
    writeFileSync(
      path.join(bin, commandName),
      `#!/bin/sh\nexec "${process.execPath}" "${fakeAgentScript}" ${extraArgs} "$@"\n`,
      { mode: 0o755 },
    );
  }
};

const writeNpmPackageJson = (bin: string, pkgName: string, version: string): void => {
  const dir = path.join(bin, 'node_modules', ...pkgName.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: pkgName, version }));
};

test('creates Session Fork, navigates Forked from / Forked to, and preserves independence on deletion', async () => {
  const locale = test.info().project.name === 'es' ? 'es' : 'en';
  const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-fork-'));
  const pickFolder = path.join(userData, 'folders', 'fork-project');
  const agentBin = path.join(userData, 'bin');
  mkdirSync(pickFolder, { recursive: true });
  mkdirSync(path.join(userData, 'spence'), { recursive: true });
  writeFileSync(
    path.join(userData, 'spence', 'settings.json'),
    JSON.stringify({ version: 1, theme: 'dark' }),
  );

  writeShim(agentBin, 'claude-agent-acp', '--version=0.105.0');
  writeNpmPackageJson(agentBin, '@agentclientprotocol/claude-agent-acp', '0.105.0');
  writeShim(agentBin, 'codex-acp', '--version=2.6.0');
  writeNpmPackageJson(agentBin, '@agentclientprotocol/codex-acp', '2.6.0');

  const app = await electron.launch({
    executablePath: electronPath,
    args: [root],
    colorScheme: null,
    env: {
      ...process.env,
      PATH: `${agentBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
      SPENCE_E2E: '1',
      SPENCE_E2E_CATALOG: '1',
      SPENCE_USER_DATA: userData,
      SPENCE_LOCALE: locale,
      SPENCE_E2E_PICK_FOLDER: pickFolder,
      SPENCE_E2E_AGENT_BIN: agentBin,
    },
  });

  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('fork-project');
    await page.getByTestId('new-session').click();

    const composer = page.getByTestId('composer-input');
    await composer.fill('echo:Goal: implement session fork');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('message-agent')).toHaveText('Goal: implement session fork');

    // Fork from the last Turn (its hover actions); the top bar Session menu does not offer Fork.
    await page.getByTestId('turn-fork').click();

    const dialog = page.getByTestId('handoff-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('handoff-agent-select').selectOption('codex');
    await dialog.getByTestId('handoff-confirm').click();
    await expect(dialog).toBeHidden();

    // Source stays selected and displays inline Forked to marker; sidebar stays flat with 2 sessions
    await expect(page.getByTestId('session-row')).toHaveCount(2);
    await expect(page.getByTestId('fork-target-link')).toBeVisible();

    // Click Forked to -> opens Fork Tab with Forked from boundary + expandable summary
    await page.getByTestId('fork-target-link').click();
    await expect(page.getByTestId('fork-source-link')).toBeVisible();
    await expect(page.getByTestId('handoff-boundary-summary')).toBeVisible();
    await expect(page).toHaveScreenshot(`session-fork-boundary-${locale}.png`, {
      mask: [page.getByTestId('project-path')],
    });

    // Click Forked from -> returns to source Tab
    await page.getByTestId('fork-source-link').click();
    await expect(page.getByTestId('fork-target-link')).toBeVisible();

    // Delete the Fork from the sidebar -> reciprocal Forked to marker disappears from source
    await page
      .locator('[data-testid="session-row"]', { hasText: 'Fork of' })
      .first()
      .click({ button: 'right' });
    await page.getByTestId('menu-delete').click();
    await page.getByTestId('confirm-action').click();
    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect(page.getByTestId('fork-target-link')).toHaveCount(0);

    // Create a second Fork, open it, then delete the source -> Fork survives with "Source deleted"
    await page.getByTestId('turn-fork').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('handoff-agent-select').selectOption('codex');
    await dialog.getByTestId('handoff-confirm').click();
    await expect(dialog).toBeHidden();

    await page.getByTestId('fork-target-link').click();
    await expect(page.getByTestId('fork-source-link')).toBeVisible();

    await page
      .locator('[data-testid="session-row"]', { hasNotText: 'Fork of' })
      .first()
      .click({ button: 'right' });
    await page.getByTestId('menu-delete').click();
    await page.getByTestId('confirm-action').click();

    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect(page.getByTestId('fork-source-deleted')).toBeVisible();
    await expect(page.getByTestId('fork-source-link')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});
