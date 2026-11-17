import { expect, test } from '../fixtures';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

test('Attention marks appear in Needs you and the other-project switcher dot', async ({
  spence,
}) => {
  const { page } = spence;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // First Tab: failed Turn -> error (run first because 'crash' exits the shared fake Agent process).
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('crash');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('attention-error')).toHaveCount(1);

  // Second Tab: pending Permission request -> needsAnswer (amber ?).
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('permission-mode-ask').click();
  await expect(page.getByTestId('permission-mode-ask')).toHaveAttribute('data-state', 'on');
  await page.getByTestId('composer-input').fill('permit');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('dock')).toBeVisible();

  // Third Session: running background Turn without Attention -> running mark.
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('composer-input').fill('hold');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');

  await expect(page.getByTestId('session-group').first()).toHaveText(
    spence.t({ en: 'Needs you', es: 'Te necesita' }),
  );
  await expect(page.getByTestId('session-row')).toHaveCount(3);
  const rows = page.getByTestId('session-row');
  await expect(rows.getByTestId('attention-needsAnswer')).toHaveCount(1);
  await expect(rows.getByTestId('attention-error')).toHaveCount(1);
  await expect(rows.getByTestId('session-running')).toHaveCount(1);

  await spence.shot('attention-marks', {
    mask: [
      page.getByTestId('project-path'),
      page.getByTestId('session-meta'),
      page.getByTestId('ticker'),
    ],
  });

  // Add a second Project and switch to it: the first Project still has Attention.
  await spence.pickNext('second-project');
  await page.getByTestId('current-project').click();
  await page
    .getByRole('menuitem', { name: spence.t({ en: 'Add Project', es: 'Añadir Proyecto' }) })
    .click();
  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await expect(page.getByTestId('other-project-attention')).toBeVisible();

  // Switcher menu shows Attention and running marks on demo-project.
  await page.getByTestId('current-project').click();
  const demoOption = page.getByTestId('project-option').filter({ hasText: 'demo-project' });
  await expect(demoOption.getByTestId('attention-needsAnswer')).toBeVisible();
  await expect(demoOption.getByTestId('session-running')).toBeVisible();
  await demoOption.click();
  await expect(page.getByTestId('other-project-attention')).toBeHidden();

  // Finish running Turns so teardown does not open the native quit-confirm dialog.
  await page
    .getByTestId('session-row')
    .filter({ has: page.getByTestId('session-running') })
    .click();
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('session-row').getByTestId('session-running')).toHaveCount(0);
  await page
    .getByTestId('session-row')
    .filter({ has: page.getByTestId('attention-needsAnswer') })
    .click();
  await page.getByTestId('dock-option').first().click();
  await expect(page.getByTestId('dock')).toBeHidden();
  await expect(page.getByTestId('stop')).toBeHidden();
});

test('Language reload keeps the kept Session and the draft, the open one, and unsent Composer text and Images', async ({
  spence,
}) => {
  const { page } = spence;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // Session 1: kept Session with unsent text + attached image.
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('echo:kept');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toContainText('kept');

  await page.getByTestId('composer-input').fill('unsent first tab');
  await page.getByTestId('composer-input').evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, TINY_PNG_BASE64);
  await expect(page.getByTestId('image-thumbnail')).toHaveCount(1);

  // Draft: unprompted draft left open with unsent text.
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await page.getByTestId('composer-input').fill('unsent draft tab');

  // Switch language to the other locale (reloads renderer in main process).
  const targetLocale = spence.locale === 'es' ? 'en' : 'es';
  await spence.updateSettings({ language: targetLocale });
  await expect(page.getByTestId('new-session')).toHaveAttribute(
    'aria-label',
    targetLocale === 'es' ? 'Nueva Sesión' : 'New Session',
  );
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await expect(page.getByTestId('composer-input')).toHaveValue('unsent draft tab');

  // Switch back to Session 1 and confirm both unsent text and image survived reload.
  await page.getByTestId('session-row').first().click();
  await expect(page.getByTestId('composer-input')).toHaveValue('unsent first tab');
  await expect(page.getByTestId('image-thumbnail')).toHaveCount(1);
});
