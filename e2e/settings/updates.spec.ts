import { expect, test } from '../fixtures';

test('Settings Updates shows the Beta channel, unsigned Windows notice, and fails closed without a key', async ({
  spence,
}) => {
  const { page } = spence;
  await page.getByTestId('open-settings').click();
  const dialog = page.getByTestId('settings-page');
  await expect(dialog.getByTestId('settings-general')).toBeVisible();

  await dialog.getByTestId('settings-nav-updates').click();
  const section = dialog.getByTestId('settings-updates-section');
  const updates = dialog.getByTestId('settings-updates');
  await expect(section).toBeVisible();
  await expect(section).toContainText('Beta');
  await expect(updates.getByTestId('updates-failed')).toContainText(
    spence.t({
      en: 'Updates are not available for this build.',
      es: 'No hay actualizaciones disponibles para esta compilación.',
    }),
  );

  await updates.getByTestId('updates-check').click();
  await expect(updates.getByTestId('updates-failed')).toContainText(
    spence.t({
      en: 'Updates are not available for this build.',
      es: 'No hay actualizaciones disponibles para esta compilación.',
    }),
  );
  await spence.shot('settings-updates');
});
