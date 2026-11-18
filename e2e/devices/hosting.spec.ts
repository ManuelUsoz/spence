import { expect, test } from '../fixtures';

test.use({ spenceSettings: { theme: 'light' } });

test('Settings > Devices: hosting is off until turned on, then shows its port', async ({
  spence,
}) => {
  const { page } = spence;
  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings-page');
  await dialog.getByTestId('settings-nav-devices').click();
  const devices = dialog.getByTestId('settings-devices');
  const hosting = devices.getByRole('switch');

  await expect(hosting).toHaveAttribute('aria-checked', 'false');
  await expect(
    devices.getByText(
      spence.t({
        en: 'Not reachable from other Devices.',
        es: 'Otros Dispositivos no pueden conectarse.',
      }),
    ),
  ).toBeVisible();
  // The default name is this machine's hostname; the port is the first free one from the default.
  const name = devices.getByTestId('settings-device-name');
  await expect(name).not.toHaveValue('');
  // The section only: the rest of the page lists the Agents this machine has installed.
  await expect(devices).toHaveScreenshot(spence.shotFile('devices-hosting-off'), { mask: [name] });

  await hosting.click();
  await expect(hosting).toHaveAttribute('aria-checked', 'true');
  const listening = devices.getByText(
    spence.t({ en: /Listening on port \d+\./, es: /Escuchando en el puerto \d+\./ }),
  );
  await expect(listening).toBeVisible();
  await expect(devices).toHaveScreenshot(spence.shotFile('devices-hosting-on'), {
    mask: [name, listening],
  });

  await hosting.click();
  await expect(hosting).toHaveAttribute('aria-checked', 'false');
});
