import { _electron as electron, expect, test } from '@playwright/test';
import { sandboxArgs } from '../fixtures';
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
    args: [root, ...sandboxArgs],
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

    // Fork from the last Turn directly without a modal; the new Fork tab opens with a summary dialog trigger.
    await page.getByTestId('turn-fork').click();

    await expect(page.getByTestId('handoff-dialog')).toHaveCount(0);
    await expect(page.getByTestId('session-row')).toHaveCount(2);
    await expect(page.getByTestId('fork-source-link')).toBeVisible();
    await expect(page.getByTestId('fork-summary-trigger')).toBeVisible();

    await page.getByTestId('fork-summary-trigger').click();
    await expect(page.getByTestId('fork-summary-dialog')).toBeVisible();
    await expect(page.getByTestId('handoff-boundary-summary')).toBeVisible();
    await page.getByTestId('fork-summary-close').click();
    await expect(page.getByTestId('fork-summary-dialog')).toBeHidden();

    // Click Forked from -> returns to source Tab with reciprocal Forked to marker
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

    // Create a second Fork, then delete the source -> Fork survives with "Source deleted"
    await page.getByTestId('turn-fork').click();
    await expect(page.getByTestId('session-row')).toHaveCount(2);
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
