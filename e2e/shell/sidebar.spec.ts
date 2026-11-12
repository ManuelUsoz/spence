import { expect, test } from '../fixtures';

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
