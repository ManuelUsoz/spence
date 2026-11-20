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

test('multi-agent catalog discovery, unverified version notice, native re-scan, and draft Agent switching', async () => {
  const locale = test.info().project.name === 'es' ? 'es' : 'en';
  const userData = mkdtempSync(path.join(tmpdir(), 'spence-e2e-multi-'));
  const pickFolder = path.join(userData, 'folders', 'multi-project');
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

    // Settings shows Default Agent + catalog Agents, unverified Claude version, and native Re-scan.
    await page.getByTestId('open-settings').click();
    const dialog = page.getByTestId('settings-page');
    await expect(dialog.getByTestId('settings-default-agent')).toContainText('Claude');
    await expect(dialog.getByTestId('agent-claude')).toContainText('0.105.0');
    await expect(dialog.getByTestId('agent-claude-unverified')).toContainText('0.106.0');

    writeShim(agentBin, 'agy', '--version=1.2.0 --no-models --no-effort');
    await dialog.getByTestId('agents-rescan').click();
    await expect(dialog.getByTestId('agent-antigravity')).toContainText(
      locale === 'es' ? 'Instalado' : 'Installed',
    );

    await dialog.getByTestId('settings-default-agent').getByRole('combobox').click();
    await page.locator('hlm-select-item[data-value="lastUsed"]').click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // New draft Session starts with Claude (showing non-blocking unverified notice).
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('multi-project');
    await page.getByTestId('new-session').click();

    await expect(page.getByTestId('agent-unverified')).toContainText('0.105.0');
    const picker = page.getByTestId('model-picker');
    const ensureOpen = async () => {
      if (!(await page.getByTestId('agent-menu').isVisible())) await picker.click();
    };
    await expect(picker).toBeVisible();

    // Switching draft Agent to Antigravity updates controls for its capabilities (no Ask, no Models).
    await ensureOpen();
    await page.getByTestId('agent-option-antigravity').click();
    // Switching Agent rebuilds the Composer controls and closes the picker; reopen it.
    await expect(async () => {
      await ensureOpen();
      await expect(page.getByTestId('models-unavailable')).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect(page.getByTestId('effort-unavailable')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('permission-mode').click();
    await expect(page.getByTestId('permission-mode-ask')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    // Switching draft Agent to Codex clears unverified notice and sends the first Turn cleanly.
    await ensureOpen();
    await page.getByTestId('agent-option-codex').click();
    await expect(page.getByTestId('agent-unverified')).toBeHidden();
    await expect(page.getByTestId('model-picker')).toBeVisible();
    await page.getByTestId('composer-input').fill('hello codex');
    await page.getByTestId('composer-input').press('Enter');

    // Creating a second draft Session inherits Codex because Default Agent is set to Last used.
    await page.getByTestId('new-session').click();
    await page.getByTestId('model-picker').click();
    await expect(page.getByTestId('agent-option-codex')).toHaveAttribute('aria-selected', 'true');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});
