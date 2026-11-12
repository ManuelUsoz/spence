import { expect, test } from '../fixtures';

test('Composer Model and Effort controls, / Commands, and Clear', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).not.toBeNull();

  // Wait for the Agent to be ready so the controls are rendered.
  await expect(page.getByTestId('model-picker')).toBeVisible();
  await expect(page.getByTestId('effort-picker')).toBeVisible();
  await expect(page.getByTestId('clear-context')).toBeVisible();
  await expect(page.getByTestId('compact')).toBeVisible();
  await spence.shot('composer-model-effort', { mask: [page.getByTestId('project-path')] });

  // Open the / Commands list.
  await page.getByTestId('composer-input').fill('/');
  await expect(page.getByTestId('commands-list')).toBeVisible();
  await expect(page.getByTestId('command-clear')).toBeVisible();
  await expect(page.getByTestId('command-compact')).toBeVisible();
  await expect(page.getByTestId('command-review')).toBeVisible();
  await spence.shot('composer-commands', { mask: [page.getByTestId('project-path')] });

  // A draft has no persisted transcript; send a turn before clearing its context.
  await page.getByTestId('composer-input').fill('echo:Hello');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello');
  await expect(page.getByTestId('stop')).toBeHidden();

  // Clear the context and wait for the divider.
  await page.getByTestId('clear-context').click();
  await expect(page.getByTestId('context-divider')).toBeVisible();
  await spence.shot('thread-context-cleared', { mask: [page.getByTestId('project-path')] });
});
