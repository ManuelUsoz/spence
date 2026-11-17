import { expect, test } from '../fixtures';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const createSession = async (
  page: import('@playwright/test').Page,
  message: string,
  reply: string,
): Promise<void> => {
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText(reply);
};

test('multi-select with Ctrl/Cmd, Shift range, Escape clear, and bulk Archive Undo / Delete', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await createSession(page, 'echo:One', 'One');
  await createSession(page, 'echo:Two', 'Two');
  await createSession(page, 'echo:Three', 'Three');

  const rows = page.getByTestId('session-row');
  await expect(rows).toHaveCount(3);

  // Ctrl/Cmd-click toggles without changing active Tab.
  await rows.nth(0).click({ modifiers: [MOD] });
  await rows.nth(2).click({ modifiers: [MOD] });
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'false');
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');

  // Escape clears selection.
  await rows.nth(2).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="session-row"][aria-selected="true"]')).toHaveCount(0);

  // Shift-click selects contiguous range 0..2.
  await rows.nth(0).click({ modifiers: [MOD] });
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect(page.locator('[data-testid="session-row"][aria-selected="true"]')).toHaveCount(3);

  // Right-click inside selection shows ONLY Archive 3 / Delete 3...
  await rows.nth(1).click({ button: 'right' });
  await expect(page.getByTestId('menu-open')).toHaveCount(0);
  await expect(page.getByTestId('menu-rename')).toHaveCount(0);
  await expect(page.getByTestId('menu-archive-bulk')).toContainText(
    spence.t({ en: 'Archive 3', es: 'Archivar 3' }),
  );
  await expect(page.getByTestId('menu-delete-bulk')).toContainText(
    spence.t({ en: 'Delete 3…', es: 'Eliminar 3…' }),
  );

  // Bulk Archive -> one toast with one Undo.
  await page.getByTestId('menu-archive-bulk').click();
  await expect(page.getByTestId('archived-fold')).toContainText(
    spence.t({ en: 'Archived (3)', es: 'Archivadas (3)' }),
  );

  const undo = page.locator('button', { hasText: spence.t({ en: 'Undo', es: 'Deshacer' }) });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('archived-fold')).toHaveCount(0);

  // Select 2 and bulk Delete -> one confirm dialog deletes both.
  await rows.nth(0).click({ modifiers: [MOD] });
  await rows.nth(1).click({ modifiers: [MOD] });
  await rows.nth(0).click({ button: 'right' });
  await page.getByTestId('menu-delete-bulk').click();
  await expect(page.getByTestId('confirm-title')).toHaveText(
    spence.t({ en: 'Delete 2 Sessions?', es: '¿Eliminar 2 Sesiones?' }),
  );
  await page.getByTestId('confirm-action').click();

  await expect(rows).toHaveCount(1);
});
