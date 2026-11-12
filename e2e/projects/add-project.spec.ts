import { expect, test } from '../fixtures';

test('adding a folder shows it; adding it again shows a toast', async ({ spence }) => {
  const page = spence.page;
  const current = page.getByTestId('current-project');
  // The Project path is a fresh temp folder each run.
  const mask = [page.getByTestId('project-path')];
  await expect(page.getByTestId('no-projects')).toBeVisible();

  await page.getByTestId('add-project').click();
  await expect(current).toContainText('demo-project');
  await spence.shot('projects-added', { mask });

  await current.click();
  await page.getByRole('menuitem', { name: 'Add Project' }).click();
  await expect(page.getByText('This folder is already in Spence as demo-project.')).toBeVisible();
  await current.click();
  await expect(page.getByTestId('project-option')).toHaveText(['demo-project']);
  await page.keyboard.press('Escape');
  await spence.shot('projects-already-added', { mask });
});
