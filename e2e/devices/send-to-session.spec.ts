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

/** Starts a Session in the current Project with one echoed Turn. */
const sessionWithTurn = async (page: Page, text: string) => {
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill(`echo:${text}`);
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText(text);
};

test('Send to another Session: a person hands work to a Session on another Device, which shows where it came from', async ({
  spence,
}) => {
  const host = await spence.peer();
  const viewer = spence;

  // The host has a Project with a Session, and shows a pairing code.
  await host.pickNext('studio-site');
  await host.page.getByTestId('add-project').click();
  await expect(host.page.getByTestId('current-project')).toContainText('studio-site');
  await sessionWithTurn(host.page, 'Render the site');
  const hostDevices = await openDevices(host, 'Studio PC');
  await hostDevices.getByTestId('settings-hosting').getByRole('switch').click();
  const port = await portOf(host.page, host);
  await hostDevices.getByTestId('pairing-start').click();
  const code = hostDevices.getByTestId('pairing-code');
  await expect(code).toHaveText(/^\d{6}$/);

  // The viewer pairs, then works in a Local Session.
  await viewer.page.getByTestId('add-project').click();
  await expect(viewer.page.getByTestId('current-project')).toContainText('demo-project');
  const viewerDevices = await openDevices(viewer, 'Kitchen laptop');
  await viewerDevices.getByTestId('pair-address').fill(`127.0.0.1:${port}`);
  await viewerDevices.getByTestId('pair-code').fill((await code.textContent()) ?? '');
  await viewerDevices.getByTestId('pair-submit').click();
  await expect(viewerDevices.getByTestId('paired-device-name')).toHaveText('Studio PC');
  await viewer.page.keyboard.press('Escape');
  await expect(viewer.page.getByTestId('settings-page')).toBeHidden();
  await host.page.keyboard.press('Escape');
  await expect(host.page.getByTestId('settings-page')).toBeHidden();
  const { page } = viewer;
  await sessionWithTurn(page, 'Plan the release');

  // ⋯ > Send to another Session…: targets grouped by Device, with the Provenance the receiver will see.
  await page.getByTestId('session-actions-trigger').click();
  await page.getByTestId('menu-send-to-session').click();
  const dialog = page.getByTestId('send-to-session-dialog');
  await expect(dialog.getByTestId('send-device-name')).toHaveText([
    viewer.t({ en: 'This Device', es: 'Este Dispositivo' }),
    'Studio PC',
  ]);
  const target = dialog.getByTestId('send-target-session').filter({ hasText: 'Render the site' });
  await expect(target).toHaveCount(1);
  await target.click();
  await dialog.getByTestId('send-text').fill('echo:Please render it again');
  await expect(dialog.getByTestId('send-provenance-preview')).toContainText('Kitchen laptop');
  await expect(dialog.getByTestId('send-submit')).toBeEnabled();
  await viewer.shot('send-to-session-picker');
  await dialog.getByTestId('send-submit').click();
  await expect(dialog).toBeHidden();

  // The host's Session runs it, and says it came from a person on the Kitchen laptop.
  const provenance = host.page.getByTestId('message-provenance');
  await expect(provenance).toHaveText(
    host.t({
      en: /From you · Kitchen laptop · .*Plan the release.* in demo-project/,
      es: /De ti · Kitchen laptop · .*Plan the release.* en demo-project/,
    }),
  );
  await expect(host.page.getByTestId('message-agent').last()).toHaveText('Please render it again');
  await expect(host.page.getByTestId('session-row')).toHaveCount(1);
  await host.shot('cross-device-provenance', { mask: [host.page.getByTestId('project-path')] });
});
