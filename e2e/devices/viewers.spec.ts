import type { Page } from '@playwright/test';
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

const listeningOn = (page: Page, spence: Spence) =>
  page.getByText(spence.t({ en: /Listening on port \d+\./, es: /Escuchando en el puerto \d+\./ }));

test('a host lists its connected viewers, shows a quiet chip, and keeps serving with its window closed', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;

  const hostDevices = await openDevices(host, 'Studio PC');
  await hostDevices.getByTestId('settings-hosting').getByRole('switch').click();
  const listening = listeningOn(host.page, host);
  await expect(listening).toBeVisible();
  const port = /(\d+)/.exec((await listening.textContent()) ?? '')?.[1];
  await expect(hostDevices.getByTestId('viewers-empty')).toBeVisible();
  await hostDevices.getByTestId('pairing-start').click();
  const code = hostDevices.getByTestId('pairing-code');
  await expect(code).toHaveText(/^\d{6}$/);

  const viewerDevices = await openDevices(viewer, 'Kitchen laptop');
  await viewerDevices.getByTestId('pair-address').fill(`127.0.0.1:${port ?? ''}`);
  await viewerDevices.getByTestId('pair-code').fill((await code.textContent()) ?? '');
  await viewerDevices.getByTestId('pair-submit').click();

  // The host lists the viewer by name once it connects, and says so quietly in the top bar.
  const viewerRow = hostDevices.getByTestId('viewer');
  await expect(viewerRow.getByTestId('viewer-name')).toHaveText('Kitchen laptop');
  await expect(host.page.getByTestId('host-chip')).toHaveText(
    host.t({ en: 'Serving 1 Remote device', es: 'Sirviendo a 1 Dispositivo remoto' }),
  );
  await expect(hostDevices.getByTestId('settings-viewers')).toHaveScreenshot(
    host.shotFile('devices-viewers'),
  );
  await expect(host.page.getByTestId('host-chip')).toHaveScreenshot(host.shotFile('host-chip'));

  // Closing the host's window asks nothing and leaves it running, still serving its viewer.
  await host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await expect
    .poll(() => host.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0);
  const hostRow = viewerDevices.getByTestId('paired-device');
  await hostRow.getByTestId('paired-device-check').click();
  await expect(hostRow.getByTestId('paired-device-status')).toHaveText(
    viewer.t({ en: 'Reachable.', es: 'Accesible.' }),
  );
});
