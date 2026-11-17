import { expect, test } from '../fixtures';

test('renames a Session inline', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('echo:First message');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  const row = page.getByTestId('session-row');
  await expect(row).toContainText('echo:First message');
  await row.dblclick();
  const editor = page.getByTestId('session-rename');
  await editor.fill('My Session');
  await spence.shot('sidebar-rename', { mask: [page.getByTestId('project-path')] });
  await editor.press('Enter');
  await expect(row).toContainText('My Session');
  await expect(page.getByTestId('topbar-title')).toHaveText('My Session');
});

test('two Projects: switch between them and start a Session in each', async ({ spence }) => {
  const page = spence.page;
  const current = page.getByTestId('current-project');
  const title = page.getByTestId('topbar-title');
  const draftRow = page.getByTestId('draft-row');
  // The Project path is a fresh temp folder each run.
  const mask = [page.getByTestId('project-path')];

  const addProjectLabel = spence.t({ en: 'Add Project', es: 'Añadir Proyecto' });
  const newSessionLabel = spence.t({ en: 'New Session', es: 'Nueva Sesión' });

  await page.getByTestId('add-project').click();
  await expect(current).toContainText('demo-project');
  await expect(page.getByTestId('sessions-empty')).toHaveText(
    spence.t({
      en: 'No Sessions in demo-project yet.',
      es: 'Aún no hay Sesiones en demo-project.',
    }),
  );
  await spence.shot('sidebar-empty', { mask });

  await spence.pickNext('second-project');
  await current.click();
  await page.getByRole('menuitem', { name: addProjectLabel }).click();
  await expect(current).toContainText('second-project');

  await page.getByTestId('new-session').click();
  await expect(draftRow).toHaveText(newSessionLabel);
  await expect(title).toHaveText(newSessionLabel);

  await current.click();
  await expect(page.getByTestId('project-option-name')).toHaveText([
    'second-project',
    'demo-project',
  ]);
  await page.getByTestId('project-option').filter({ hasText: 'demo-project' }).click();
  await expect(current).toContainText('demo-project');
  await expect(draftRow).toHaveCount(0);

  await page.getByTestId('new-session').click();
  await expect(title).toHaveText(newSessionLabel);
  await expect(page.getByTestId('greeting')).toContainText('demo-project');
  // The draft's Session view (its Composer) shows once main has started the Session.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await spence.shot('sidebar-one-project', { mask });

  // Opening the other Project's draft makes that Project current.
  await current.click();
  await page.getByTestId('project-option').filter({ hasText: 'second-project' }).click();
  await expect(draftRow).toHaveCount(1);
  await draftRow.click();
  await expect(current).toContainText('second-project');
  await expect(page.getByTestId('greeting')).toContainText('second-project');
});

test('the gear opens Settings', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page
    .getByRole('button', { name: spence.t({ en: 'Close', es: 'Cerrar' }) })
    .first()
    .click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});
