import { expect, test } from '../fixtures';

const createSession = async (
  page: import('@playwright/test').Page,
  message: string,
  expectedReply?: string,
): Promise<void> => {
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('draft-row')).toHaveCount(1);
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  if (expectedReply !== undefined) {
    await expect(page.getByTestId('message-agent').last()).toContainText(expectedReply);
  }
};

test('session right-click Archive + Undo toast, running-Turn confirm, and Delete confirm', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // Create first kept Session (idle).
  await createSession(page, 'echo:Alpha', 'Alpha');
  await expect(page.getByTestId('session-row')).toHaveCount(1);

  // Archive idle Session via right-click context menu -> immediate, closes the Session, shows Undo toast.
  await page.getByTestId('session-row').first().click({ button: 'right' });
  await expect(page.getByTestId('menu-rename')).toBeEnabled();
  await page.getByTestId('menu-archive').click();

  const archivedOne = spence.t({ en: 'Archived (1)', es: 'Archivadas (1)' });
  const undoLabel = spence.t({ en: 'Undo', es: 'Deshacer' });

  await expect(page.getByTestId('session-actions-trigger')).toHaveCount(0);
  await expect(page.getByTestId('archived-fold')).toContainText(archivedOne);

  const undo = page.locator('button', { hasText: undoLabel });
  await expect(undo).toBeVisible();
  await undo.click();

  await expect(page.getByTestId('archived-fold')).toHaveCount(0);
  await expect(page.getByTestId('session-row')).toHaveCount(1);

  // Start a running Turn ("hold"), then Archive via context menu -> confirm dialog first.
  await page.getByTestId('session-row').first().click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('hold');
  await composer.press('Enter');
  await expect(page.getByTestId('stop')).toBeVisible();

  await page.getByTestId('session-row').first().click({ button: 'right' });
  await page.getByTestId('menu-archive').click();
  await expect(page.getByTestId('session-confirm-dialog')).toBeVisible();
  await expect(page.getByTestId('confirm-description')).toContainText(
    spence.t({ en: 'running', es: 'ejecutándose' }),
  );
  await page.getByTestId('confirm-action').click();

  await expect(page.getByTestId('session-actions-trigger')).toHaveCount(0);
  await expect(page.getByTestId('archived-fold')).toContainText(archivedOne);

  // Delete an archived Session -> alert-dialog promising "removed from Spence".
  await page.getByTestId('archived-fold').click();
  await page.locator('[data-testid="session-row"][data-archived="true"]').first().click({
    button: 'right',
  });
  await page.getByTestId('menu-delete').click();
  await expect(page.getByTestId('confirm-description')).toContainText(
    spence.t({ en: 'removed from Spence', es: 'eliminará permanentemente de Spence' }),
  );
  await expect(page.getByTestId('confirm-description')).not.toContainText(
    spence.t({ en: 'erased from the Agent', es: 'borrará del Agente' }),
  );
  await page.getByTestId('confirm-action').click();

  await expect(page.getByTestId('archived-fold')).toHaveCount(0);
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
});

test('top bar Session menu and Project switcher context menus', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await createSession(page, 'echo:First session', 'First session');

  // Top bar Session menu: Delete stops and removes the Session.
  await page.getByTestId('session-actions-trigger').click();
  await expect(page.getByTestId('session-actions-menu')).toBeVisible();
  await page.getByTestId('menu-delete').click();
  await page.getByTestId('confirm-action').click();
  await expect(page.getByTestId('session-actions-trigger')).toHaveCount(0);
  await expect(page.getByTestId('sessions-empty')).toBeVisible();

  // Project context menu: New Session, Rename, Project settings, Archive all, Remove Project.
  await page.getByTestId('current-project').click({ button: 'right' });
  await page.getByTestId('project-menu-new-session').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByTestId('composer-input').fill('echo:In project');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText('In project');

  await page.getByTestId('current-project').click({ button: 'right' });
  await page.getByTestId('project-menu-rename').click();
  const renameInput = page.getByTestId('project-rename-input');
  await renameInput.fill('renamed-project');
  await renameInput.press('Enter');
  await expect(page.getByTestId('current-project')).toContainText('renamed-project');

  await page.getByTestId('current-project').click({ button: 'right' });
  await page.getByTestId('project-menu-settings').click();
  await expect(page.getByTestId('project-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('project-settings')).toBeHidden();

  await page.getByTestId('current-project').click({ button: 'right' });
  await expect(page.getByTestId('project-menu-archive-all')).toContainText(
    spence.t({ en: 'Archive all (1)', es: 'Archivar todas (1)' }),
  );
  await page.getByTestId('project-menu-archive-all').click();
  await expect(page.getByTestId('archived-fold')).toContainText(
    spence.t({ en: 'Archived (1)', es: 'Archivadas (1)' }),
  );

  await page.getByTestId('current-project').click({ button: 'right' });
  await page.getByTestId('project-menu-remove').click();
  await expect(page.getByTestId('no-projects')).toBeVisible();
});
