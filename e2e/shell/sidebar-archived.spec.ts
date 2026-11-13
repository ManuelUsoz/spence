import { expect, test } from '../fixtures';

const createSession = async (
  page: import('@playwright/test').Page,
  message: string,
  reply: string,
): Promise<void> => {
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible();
  await composer.fill(message);
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText(reply);
};

test('Archived fold is collapsed by default, prompt unarchives, and fold menu acts on all', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await createSession(page, 'echo:First note', 'First note');
  await createSession(page, 'echo:Second note', 'Second note');

  // Archive both Sessions individually.
  for (let i = 0; i < 2; i += 1) {
    await page.getByTestId('session-row').first().click({ button: 'right' });
    await page.getByTestId('menu-archive').click();
  }

  // Fold is collapsed by default.
  const fold = page.getByTestId('archived-fold');
  await expect(fold).toContainText('Archived (2)');
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('archived-list')).toHaveCount(0);

  // Expanding shows muted archived rows.
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  const archivedRows = page.locator('[data-testid="session-row"][data-archived="true"]');
  await expect(archivedRows).toHaveCount(2);

  // Opening an archived Session and sending a Message unarchives it.
  await archivedRows.first().click();
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible();
  await composer.fill('echo:Awake again');
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText('Awake again');

  await expect(fold).toContainText('Archived (1)');

  // Archived fold context menu: Unarchive all (1).
  await fold.click({ button: 'right' });
  await expect(page.getByTestId('archived-menu-unarchive-all')).toContainText('Unarchive all (1)');
  await page.getByTestId('archived-menu-unarchive-all').click();
  await expect(fold).toHaveCount(0);
  await expect(page.getByTestId('session-row')).toHaveCount(2);

  // Archive both via Project menu, then Delete all (2)... via Archived fold menu.
  await page.getByTestId('current-project').click({ button: 'right' });
  await page.getByTestId('project-menu-archive-all').click();
  await expect(fold).toContainText('Archived (2)');

  await fold.click({ button: 'right' });
  await page.getByTestId('archived-menu-delete-all').click();
  await expect(page.getByTestId('confirm-description')).toContainText('removed from Spence');
  await page.getByTestId('confirm-action').click();
  await expect(fold).toHaveCount(0);
  await expect(page.getByTestId('sessions-empty')).toBeVisible();
});
