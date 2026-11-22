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

test('a Remote Session: Projects grouped by Device, the Device chip, and a Turn run on the host', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;

  // The host has a Project of its own and shows a pairing code.
  await host.pickNext('studio-site');
  await host.page.getByTestId('add-project').click();
  await expect(host.page.getByTestId('current-project')).toContainText('studio-site');
  const hostDevices = await openDevices(host, 'Studio PC');
  await hostDevices.getByTestId('settings-hosting').getByRole('switch').click();
  const port = await portOf(host.page, host);
  await hostDevices.getByTestId('pairing-start').click();
  const code = hostDevices.getByTestId('pairing-code');
  await expect(code).toHaveText(/^\d{6}$/);

  // The viewer has a Local Project, then pairs with the host.
  await viewer.page.getByTestId('add-project').click();
  await expect(viewer.page.getByTestId('current-project')).toContainText('demo-project');
  const viewerDevices = await openDevices(viewer, 'Kitchen laptop');
  await viewerDevices.getByTestId('pair-address').fill(`127.0.0.1:${port}`);
  await viewerDevices.getByTestId('pair-code').fill((await code.textContent()) ?? '');
  await viewerDevices.getByTestId('pair-submit').click();
  await expect(viewerDevices.getByTestId('paired-device-name')).toHaveText('Studio PC');
  await viewer.page.keyboard.press('Escape');
  await expect(viewer.page.getByTestId('settings-page')).toBeHidden();

  // The selector groups Projects by Device: the Local device first, then the connected host.
  const { page } = viewer;
  // By keyboard, so no tooltip covers the screenshot.
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByTestId('project-group-name')).toHaveText([
    viewer.t({ en: 'This Device', es: 'Este Dispositivo' }),
    'Studio PC',
  ]);
  await expect(page.getByTestId('project-option-name')).toHaveText(['demo-project', 'studio-site']);
  await viewer.shot('remote-projects-grouped', {
    mask: [page.getByTestId('project-path'), page.getByTestId('project-option-path')],
  });

  // A Remote Project names its Device; a new Session there runs on the host.
  await page.getByTestId('project-option').nth(1).click();
  await expect(page.getByTestId('project-device')).toHaveText('Studio PC');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('device-chip')).toHaveText('Studio PC');
  const composer = page.getByTestId('composer-input');
  await expect(composer).toHaveAttribute(
    'placeholder',
    viewer.t({
      en: 'Message the Agent on Studio PC',
      es: 'Escribe al Agente en Studio PC',
    }),
  );
  await composer.fill('echo:Hello from the kitchen');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-user')).toHaveText('echo:Hello from the kitchen');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello from the kitchen');
  await expect(page.getByTestId('send')).toBeDisabled();
  await viewer.shot('remote-session-reply');

  // An image the Agent sends on the host is fetched by handle when it shows here.
  await composer.fill('image:reply');
  await composer.press('Enter');
  const image = page.getByTestId('message-agent').nth(1).getByTestId('image-thumbnail');
  await expect(image.locator('img')).toHaveAttribute('src', /^(blob:|data:image\/png)/);
  await viewer.shot('remote-session-image');

  // The Session and its Transcript live on the host.
  await host.page.keyboard.press('Escape');
  await expect(host.page.getByTestId('session-row')).toHaveCount(1);
});
