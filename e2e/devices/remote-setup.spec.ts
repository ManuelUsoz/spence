import type { Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Spence } from '../fixtures';

test.use({ spenceSettings: { theme: 'light' } });

/** Opens Settings > Devices and names this Device, so screenshots never show the machine's hostname. */
const openDevices = async (spence: Spence, name: string) => {
  const { page } = spence;
  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings-page');
  await dialog.getByTestId('settings-nav-devices').click();
  const devices = dialog.getByTestId('settings-devices');
  const nameField = devices.getByTestId('settings-device-name');
  await nameField.fill(name);
  await nameField.press('Enter');
  await nameField.blur();
  await expect(nameField).toHaveValue(name);
  return devices;
};

const portOf = async (page: Page, spence: Spence): Promise<number> => {
  const listening = page.getByText(
    spence.t({ en: /Listening on port \d+\./, es: /Escuchando en el puerto \d+\./ }),
  );
  await expect(listening).toBeVisible();
  const port = /(\d+)/.exec((await listening.textContent()) ?? '')?.[1];
  if (port === undefined) throw new Error('no port shown');
  return Number(port);
};

/** Pairs `viewer` with `host` (hosting on, code typed on the viewer) and leaves both on their main view. */
const pair = async (host: Spence, viewer: Spence) => {
  const hostDevices = await openDevices(host, 'Studio PC');
  await hostDevices.getByTestId('settings-hosting').getByRole('switch').click();
  const port = await portOf(host.page, host);
  await hostDevices.getByTestId('pairing-start').click();
  const code = hostDevices.getByTestId('pairing-code');
  await expect(code).toHaveText(/^\d{6}$/);

  const viewerDevices = await openDevices(viewer, 'Kitchen laptop');
  await viewerDevices.getByTestId('pair-address').fill(`127.0.0.1:${port}`);
  await viewerDevices.getByTestId('pair-code').fill((await code.textContent()) ?? '');
  await viewerDevices.getByTestId('pair-submit').click();
  await expect(viewerDevices.getByTestId('paired-device-name')).toHaveText('Studio PC');
  await viewer.page.keyboard.press('Escape');
  await expect(viewer.page.getByTestId('settings-page')).toBeHidden();
  await host.page.keyboard.press('Escape');
};

test('set up a Remote device: add a Project through its folders, and change its execution Settings', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;
  // A folder on the host's disk, in the folder its browser starts at.
  await host.pickNext('studio-site');
  await pair(host, viewer);

  // The viewer has no Project yet: it adds its first one on the host.
  const { page } = viewer;
  await expect(page.getByTestId('add-project-remote')).toHaveText(
    viewer.t({ en: 'Add Project on Studio PC', es: 'Añadir Proyecto en Studio PC' }),
  );
  await page.getByTestId('add-project-remote').click();
  const browser = page.getByTestId('folder-browser');
  await expect(browser.getByTestId('folder-entry-name')).toHaveText([
    'demo-project',
    'studio-site',
  ]);
  await viewer.shot('remote-folder-browser', {
    mask: [browser.getByTestId('folder-path'), browser.getByTestId('folder-roots')],
  });

  await browser.getByTestId('folder-entry').nth(1).click();
  await expect(browser.getByTestId('folder-empty')).toBeVisible();
  await browser.getByTestId('folder-choose').click();
  await expect(browser).toBeHidden();
  await expect(page.getByTestId('current-project')).toContainText('studio-site');
  await expect(page.getByTestId('project-device')).toHaveText('Studio PC');

  // The Project is stored on the host, and not on the viewer.
  const stored = (spence: Spence) =>
    readFileSync(path.join(spence.userData, 'spence', 'projects.json'), 'utf8');
  expect(stored(host)).toContain('studio-site');
  expect(
    existsSync(path.join(viewer.userData, 'spence', 'projects.json')) ? stored(viewer) : '',
  ).not.toContain('studio-site');

  // The viewer changes the host's default permission mode; its own stays as it was.
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings-page');
  await settings.getByTestId('settings-device').locator('hlm-select-trigger').click();
  await page.getByRole('option', { name: 'Studio PC' }).click();
  await settings.getByTestId('permission-ask').click();
  await expect(settings.getByTestId('permission-ask')).toHaveAttribute('aria-pressed', 'true');
  await viewer.shot('remote-execution-settings');
  await settings.getByTestId('settings-device').locator('hlm-select-trigger').click();
  await page
    .getByRole('option', { name: viewer.t({ en: 'This Device', es: 'Este Dispositivo' }) })
    .click();
  await expect(settings.getByTestId('permission-auto')).toHaveAttribute('aria-pressed', 'true');

  await host.page.getByTestId('open-settings').click();
  await expect(
    host.page.getByTestId('settings-page').getByTestId('permission-ask'),
  ).toHaveAttribute('aria-pressed', 'true');
});

const seedRemoteManagedAgents = (userData: string): void => {
  const spenceRoot = path.join(userData, 'spence');
  const runtimeDir = path.join(spenceRoot, 'runtime', 'node-v22.14.0');
  const isWin = process.platform === 'win32';
  const npmBin = isWin
    ? path.join(runtimeDir, 'node_modules', 'npm', 'bin')
    : path.join(runtimeDir, 'lib', 'node_modules', 'npm', 'bin');
  mkdirSync(isWin ? runtimeDir : path.join(runtimeDir, 'bin'), { recursive: true });
  mkdirSync(npmBin, { recursive: true });
  if (isWin) {
    copyFileSync(process.execPath, path.join(runtimeDir, 'node.exe'));
  } else {
    writeFileSync(
      path.join(runtimeDir, 'bin', 'node'),
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    path.join(npmBin, 'npm-cli.js'),
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      'const args = process.argv.slice(2);',
      "const prefix = args[args.indexOf('--prefix') + 1];",
      "const pkgSpec = args[args.length - 1] ?? '';",
      "const atIdx = pkgSpec.lastIndexOf('@');",
      'const pkgName = atIdx > 0 ? pkgSpec.slice(0, atIdx) : pkgSpec;',
      "const pkgVersion = atIdx > 0 ? pkgSpec.slice(atIdx + 1) : '1.0.0';",
      "const binName = pkgName.includes('codex') ? 'codex-acp' : 'claude-agent-acp';",
      "const pkgDir = path.join(prefix, 'node_modules', ...pkgName.split('/'));",
      "fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });",
      "fs.writeFileSync(path.join(pkgDir, 'bin', `${binName}.js`), '#!/usr/bin/env node\\n');",
      'fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: pkgName, version: pkgVersion, bin: { [binName]: `./bin/${binName}.js` } }));',
      "process.stdout.write('added 1 package\\n');",
    ].join('\n'),
  );

  // Seed outdated Claude 0.105.0 on the remote host (qualified is 0.106.0).
  const claudePkgDir = path.join(
    spenceRoot,
    'agents',
    'claude',
    'node_modules',
    '@agentclientprotocol',
    'claude-agent-acp',
  );
  mkdirSync(path.join(claudePkgDir, 'bin'), { recursive: true });
  writeFileSync(path.join(claudePkgDir, 'bin', 'claude-agent-acp.js'), '#!/usr/bin/env node\n');
  writeFileSync(
    path.join(claudePkgDir, 'package.json'),
    JSON.stringify({
      name: '@agentclientprotocol/claude-agent-acp',
      version: '0.105.0',
      bin: { 'claude-agent-acp': './bin/claude-agent-acp.js' },
    }),
  );
};

test('runs Set up and Update for Agents on a paired Remote device in its own store', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;
  seedRemoteManagedAgents(host.userData);
  await pair(host, viewer);

  const { page } = viewer;
  await page.getByTestId('open-settings').click();
  const settings = page.getByTestId('settings-page');
  await settings.getByTestId('settings-device').locator('hlm-select-trigger').click();
  await page.getByRole('option', { name: 'Studio PC' }).click();

  await settings.getByTestId('settings-nav-agents').click();
  const agents = settings.getByTestId('settings-agents');
  await expect(agents.getByTestId('agent-claude-status')).toContainText('0.105.0');
  const claudeUnverified = agents.getByTestId('agent-claude-unverified');
  await expect(claudeUnverified).toBeVisible();
  await expect(claudeUnverified.getByTestId('update-agent')).toHaveText(
    viewer.t({ en: 'Update', es: 'Actualizar' }),
  );
  await expect(agents.getByTestId('agent-codex').getByTestId('install')).toHaveText(
    viewer.t({ en: 'Set up', es: 'Instalar' }),
  );

  // Update outdated Claude on the Remote device.
  await claudeUnverified.getByTestId('update-agent').click();
  await expect(claudeUnverified).toBeHidden();
  await expect(agents.getByTestId('agent-claude-status')).toContainText('0.106.0');

  // Set up Codex on the Remote device.
  await agents.getByTestId('agent-codex').getByTestId('install').click();
  await expect(agents.getByTestId('agent-codex-status')).toContainText('2.6.0');

  // Both installs live strictly in host's userData/spence/agents/, never viewer's.
  expect(
    JSON.parse(
      readFileSync(
        path.join(
          host.userData,
          'spence',
          'agents',
          'claude',
          'node_modules',
          '@agentclientprotocol',
          'claude-agent-acp',
          'package.json',
        ),
        'utf8',
      ),
    ).version,
  ).toBe('0.106.0');
  expect(
    JSON.parse(
      readFileSync(
        path.join(
          host.userData,
          'spence',
          'agents',
          'codex',
          'node_modules',
          '@agentclientprotocol',
          'codex-acp',
          'package.json',
        ),
        'utf8',
      ),
    ).version,
  ).toBe('2.6.0');
  expect(existsSync(path.join(viewer.userData, 'spence', 'agents'))).toBe(false);
});
