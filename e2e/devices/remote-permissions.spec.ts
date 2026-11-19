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

test('a Remote Permission request: the amber dot on its Device, answered from the viewer', async ({
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

  // A Session on the host, in Ask, asks before a Step.
  const { page } = viewer;
  await page.keyboard.press('ControlOrMeta+p');
  await page.getByTestId('project-option').nth(1).click();
  await expect(page.getByTestId('project-device')).toHaveText('Studio PC');
  await page.getByTestId('new-session').click();
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('permission-mode-ask').click();
  await expect(page.getByTestId('permission-mode')).toContainText(
    viewer.t({ en: 'Ask', es: 'Preguntar' }),
  );
  const composer = page.getByTestId('composer-input');
  await composer.fill('permit');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('dock')).toBeVisible();
  await expect(page.getByTestId('dock-title')).toHaveText('ls -la');

  // Its Device's group in the selector carries the amber dot; the Local one does not.
  await page.getByTestId('session-search').focus();
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByTestId('project-group-attention')).toHaveCount(1);
  await expect(
    page.getByTestId('project-group').nth(1).getByTestId('project-group-attention'),
  ).toBeVisible();
  await viewer.shot('remote-permission-needs-you', {
    mask: [page.getByTestId('project-path'), page.getByTestId('project-option-path')],
  });
  await page.keyboard.press('Escape');

  // Answered from the viewer, the Turn ends on the host and the dot goes.
  await page.getByTestId('dock-option').first().click();
  await expect(page.getByTestId('dock')).toBeHidden();
  await expect(page.getByTestId('message-agent')).toHaveText(/^permission \w+$/);
  await page.keyboard.press('ControlOrMeta+p');
  await expect(page.getByTestId('project-option')).toHaveCount(2);
  await expect(page.getByTestId('project-group-attention')).toHaveCount(0);
});
