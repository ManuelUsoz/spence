import { expect, test } from '../fixtures';

test('adding a folder lists it; adding it again shows a toast', async ({ spence }) => {
  const page = spence.page;
  await expect(page.getByTestId('no-projects')).toBeVisible();

  await page.getByTestId('add-project').click();
  const projects = page.getByTestId('project-list').getByTestId('project');
  await expect(projects).toHaveText(['demo-project']);
  await spence.shot('projects-added');

  await page.getByTestId('add-project').click();
  await expect(page.getByText('This folder is already in Spence as demo-project.')).toBeVisible();
  await expect(projects).toHaveCount(1);
  await spence.shot('projects-already-added');
});
