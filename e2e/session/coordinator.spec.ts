import { execFileSync } from 'node:child_process';
import { expect, test } from '../fixtures';

test.use({
  spenceSettings: {
    theme: 'dark',
    coordinator: {
      coordinator: { agentId: 'fake', model: 'large' },
      worker: { agentId: 'fake', model: 'small' },
      verifier: { agentId: 'fake', model: 'small' },
    },
  },
});

test('coordinates the next Turn and shows the verification result', async ({ spence }) => {
  const { page, pickFolder } = spence;
  execFileSync('git', ['init', '-q'], { cwd: pickFolder });
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();

  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEditable();
  await composer.fill('/coordinate');
  await composer.press('Enter');
  await expect(page.getByTestId('coordinate-armed')).toBeVisible();
  await spence.shot('coordinate-next-turn', { mask: [page.getByTestId('project-path')] });

  await composer.fill('coordinate-fixture');
  await composer.press('Enter');
  await expect(page.getByText('Verification passed', { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('coordinate-armed')).toHaveCount(0);
  await page.getByTestId('workers-line').click();
  const roles = page.getByTestId('workers-line-item');
  await expect(roles).toHaveCount(3);
  await expect(roles.filter({ hasText: 'Verifier' })).toBeVisible();
});

test('stops a workflow waiting for approval in the parent Session', async ({ spence }) => {
  const { page, pickFolder } = spence;
  execFileSync('git', ['init', '-q'], { cwd: pickFolder });
  await spence.updateSettings({ defaultPermissionMode: 'ask' });
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();

  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeEditable();
  await composer.fill('/coordinate');
  await composer.press('Enter');
  await expect(page.getByTestId('coordinate-armed')).toBeVisible();
  await composer.fill('coordinate-fixture:approval');
  await composer.press('Enter');

  await expect(page.getByTestId('workflow-permission-source')).toContainText('Worker', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('workflow-permission-source')).toContainText('Fake');
  await expect(page.getByTestId('dock-title')).toHaveText('Run checks');
  await spence.shot('coordinate-approval', { mask: [page.getByTestId('project-path')] });
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('workflow-permission-source')).toBeHidden();
  await expect(page.getByTestId('stop')).toBeHidden();
  await page.getByTestId('workers-line').click();
  await expect(page.getByTestId('workers-line-item')).toHaveCount(2);
});
