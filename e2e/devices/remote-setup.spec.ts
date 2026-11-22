import type { Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
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
