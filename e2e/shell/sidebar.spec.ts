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
  await expect(page.getByTestId('tab-label')).toHaveText('My Session');
});

test('two Projects: switch between them and open a Tab in each', async ({ spence }) => {
  const page = spence.page;
  const current = page.getByTestId('current-project');
  const tabs = page.getByTestId('tab-label');
  const draftRow = page.getByTestId('draft-row');
  // The Project path is a fresh temp folder each run.
  const mask = [page.getByTestId('project-path')];

  await page.getByTestId('add-project').click();
  await expect(current).toContainText('demo-project');
  await expect(page.getByTestId('sessions-empty')).toHaveText('No Sessions in demo-project yet.');
  await spence.shot('sidebar-empty', { mask });

  await spence.pickNext('second-project');
  await current.click();
  await page.getByRole('menuitem', { name: 'Add Project' }).click();
  await expect(current).toContainText('second-project');

  await page.getByTestId('new-session').click();
  await expect(draftRow).toHaveText('New Session');
  await expect(tabs).toHaveText(['New Session']);

  await current.click();
  await expect(page.getByTestId('project-option')).toHaveText(['second-project', 'demo-project']);
  await page.getByTestId('project-option').filter({ hasText: 'demo-project' }).click();
  await expect(current).toContainText('demo-project');
  await expect(draftRow).toHaveCount(0);

  await page.getByTestId('new-session').click();
  await expect(tabs).toHaveText(['New Session', 'New Session']);
  await expect(page.getByTestId('session-placeholder')).toContainText('demo-project');
  // The draft's Session view (its Composer) shows once main has started the Session.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await spence.shot('sidebar-one-project', { mask });

  // The current Project follows the active Tab.
  await tabs.first().click();
  await expect(current).toContainText('second-project');
  await expect(page.getByTestId('session-placeholder')).toContainText('second-project');

  // Closing a draft's Tab removes its placeholder row.
  await page.getByTestId('tab-close').first().click();
  await expect(tabs).toHaveCount(1);
  await expect(current).toContainText('demo-project');
  await current.click();
  await page.getByTestId('project-option').filter({ hasText: 'second-project' }).click();
  await expect(draftRow).toHaveCount(0);
  await expect(page.getByTestId('sessions-empty')).toHaveText('No Sessions in second-project yet.');
});

test('the gear opens Settings', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('settings-dialog')).toBeHidden();
});

test('All Projects layout switches at once, lists Sessions, sorts and filters', async ({
  spence,
}) => {
  const page = spence.page;

  // Add two Projects and start a kept Session in the second one.
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await spence.pickNext('alpha-project');
  await page.getByTestId('current-project').click();
  await page.getByRole('menuitem', { name: 'Add Project' }).click();
  await expect(page.getByTestId('current-project')).toContainText('alpha-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:First task');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('First task');

  // Switch to All Projects in Settings: applies at once without reload.
  await page.getByTestId('open-settings').click();
  await page.getByTestId('sidebar-allProjects').click();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('all-projects-filter')).toBeVisible();
  const headings = page.getByTestId('project-heading');
  await expect(headings).toHaveText(['alpha-project', 'demo-project']);
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(page.getByTestId('session-age')).toHaveText(['now']);

  // Start a draft in demo-project and capture the layout.
  await page.getByTestId('project-new-session').nth(1).click();
  await expect(page.getByTestId('draft-row')).toHaveText('New Session');
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await spence.shot('sidebar-all-projects');

  // Sort Projects by name (desc then asc) via the sidebar sort control.
  await page.getByTestId('project-order-trigger').click();
  await page.getByTestId('sort-by-name').click();
  await expect(headings).toHaveText(['demo-project', 'alpha-project']);
  await page.getByTestId('project-order-trigger').click();
  await page.getByTestId('sort-direction-asc').click();
  await expect(headings).toHaveText(['alpha-project', 'demo-project']);

  // Filter across Project names and Session titles.
  const filter = page.getByTestId('all-projects-filter');
  await filter.fill('demo');
  await expect(headings).toHaveText(['demo-project']);
  await expect(page.getByTestId('draft-row')).toHaveCount(1);

  await filter.fill('');
  await expect(headings).toHaveText(['alpha-project', 'demo-project']);
});
