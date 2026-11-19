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

const portOf = async (page: Page, spence: Spence): Promise<number> => {
  const listening = page.getByText(
    spence.t({ en: /Listening on port \d+\./, es: /Escuchando en el puerto \d+\./ }),
  );
  await expect(listening).toBeVisible();
  const port = /(\d+)/.exec((await listening.textContent()) ?? '')?.[1];
  if (port === undefined) throw new Error('no port shown');
  return Number(port);
};

test('Settings > Devices: pair two Devices with a code, then unpair from one side', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;

  // The hosting Device shows a code.
  const hostDevices = await openDevices(host, 'Studio PC');
  await hostDevices.getByTestId('settings-hosting').getByRole('switch').click();
  const port = await portOf(host.page, host);
  await hostDevices.getByTestId('pairing-start').click();
  const code = hostDevices.getByTestId('pairing-code');
  await expect(code).toHaveText(/^\d{6}$/);
  const listening = hostDevices.getByText(
    spence.t({ en: /Listening on port \d+\./, es: /Escuchando en el puerto \d+\./ }),
  );
  await expect(hostDevices).toHaveScreenshot(host.shotFile('devices-pairing-code'), {
    mask: [code, hostDevices.getByTestId('pairing-expires'), listening],
  });

  // The other Device types its address and the code: e2e announces nothing, so nothing shows nearby and the typed
  // address is what pairs.
  const viewerDevices = await openDevices(viewer, 'Kitchen laptop');
  await expect(viewerDevices.getByTestId('nearby-empty')).toBeVisible();
  await viewerDevices.getByTestId('pair-address').fill(`127.0.0.1:${port}`);
  await viewerDevices.getByTestId('pair-code').fill((await code.textContent()) ?? '');
  await viewerDevices.getByTestId('pair-submit').click();
  const hostRow = viewerDevices.getByTestId('paired-device');
  await expect(hostRow.getByTestId('paired-device-name')).toHaveText('Studio PC');
  await expect(hostRow.getByTestId('paired-device-status')).toHaveText(
    spence.t({ en: 'Reachable.', es: 'Accesible.' }),
  );
  await expect(viewerDevices).toHaveScreenshot(viewer.shotFile('devices-paired'));

  // Trust goes both ways: the host lists the viewer (not hosting, so not reachable from there).
  await expect(hostDevices.getByTestId('pairing-outcome')).toHaveText(
    spence.t({ en: 'Paired with Kitchen laptop.', es: 'Emparejado con Kitchen laptop.' }),
  );
  const viewerRow = hostDevices.getByTestId('paired-device');
  await expect(viewerRow.getByTestId('paired-device-name')).toHaveText('Kitchen laptop');
  await expect(viewerRow.getByTestId('paired-device-status')).toHaveText(
    spence.t({ en: 'Offline, or not hosting.', es: 'Sin conexión, o sin alojamiento.' }),
  );
  await expect(hostDevices).toHaveScreenshot(host.shotFile('devices-paired-host'), {
    mask: [listening],
  });

  // Agents from the viewer are not let in until the host allows them, per Paired device.
  const allowAgents = viewerRow.getByTestId('paired-device-allow-agents').getByRole('switch');
  await expect(allowAgents).toHaveAttribute('aria-checked', 'false');
  await allowAgents.click();
  await expect(allowAgents).toHaveAttribute('aria-checked', 'true');
  await expect(hostDevices).toHaveScreenshot(host.shotFile('devices-allow-agents'), {
    mask: [listening],
  });

  // The host unpairs; the viewer finds out at once (its live connection is refused), and can only remove it.
  await viewerRow.getByTestId('paired-device-unpair').click();
  await expect(hostDevices.getByTestId('paired-devices-empty')).toBeVisible();
  await expect(hostRow.getByTestId('paired-device-status')).toHaveText(
    spence.t({ en: 'Unpaired by the other side.', es: 'Desemparejado por el otro lado.' }),
  );
  await expect(hostRow.getByTestId('paired-device-unpair')).toHaveCount(0);
  await expect(viewerDevices).toHaveScreenshot(viewer.shotFile('devices-unpaired-by-other'));
  await hostRow.getByTestId('paired-device-remove').click();
  await expect(viewerDevices.getByTestId('paired-devices-empty')).toBeVisible();
});
