import type { Locator, Page } from '@playwright/test';
import { expect, test, type Spence } from '../fixtures';

test.use({ spenceSettings: { theme: 'light' } });

/** Opens Settings > Devices and names this Device, so screenshots never show the machine's hostname. */
const openDevices = async (spence: Spence, name: string): Promise<Locator> => {
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

test('a Remote Session whose Device goes away: Reconnecting, then Offline, readable, and Retry resumes it', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;

  // The host has a Project, hosts and shows a pairing code; the viewer pairs with it.
  await host.pickNext('studio-site');
  await host.page.getByTestId('add-project').click();
  await expect(host.page.getByTestId('current-project')).toContainText('studio-site');
  const hostDevices = await openDevices(host, 'Studio PC');
  const hosting = hostDevices.getByTestId('settings-hosting').getByRole('switch');
  await hosting.click();
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

  // A Remote Session with one Turn.
  const { page } = viewer;
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByTestId('project-option').filter({ hasText: 'studio-site' }).click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('device-chip')).toHaveText('Studio PC');
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Hello from the kitchen');
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello from the kitchen');
  await expect(page.getByTestId('device-offline-bar')).toBeHidden();

  // The host stops hosting: the viewer reaches it again, fast at first, and says so; the Transcript stays.
  await hosting.click();
  const bar = page.getByTestId('device-offline-bar');
  await expect(bar).toHaveAttribute('data-state', 'reconnecting');
  await expect(bar).toContainText(
    viewer.t({ en: 'Reconnecting to Studio PC', es: 'Reconectando con Studio PC' }),
  );
  await expect(composer).toBeDisabled();
  await expect(page.getByTestId('message-agent')).toHaveText('Hello from the kitchen');
  await viewer.shot('remote-session-reconnecting');

  // After a while (a minute; shortened under e2e) it shows Offline, still readable.
  await expect(bar).toHaveAttribute('data-state', 'offline', { timeout: 30_000 });
  await expect(bar).toContainText(
    viewer.t({ en: 'Studio PC is offline', es: 'Studio PC está desconectado' }),
  );
  await expect(page.getByTestId('message-user')).toHaveText('echo:Hello from the kitchen');
  await viewer.shot('remote-session-offline');

  // Hosting again, Retry reaches it at once and the Session resumes.
  await hosting.click();
  await portOf(host.page, host);
  await bar.getByTestId('device-retry').click();
  await expect(bar).toBeHidden();
  await expect(composer).toBeEnabled();
  await composer.fill('echo:Back again');
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText([
    'Hello from the kitchen',
    'Back again',
  ]);
});
