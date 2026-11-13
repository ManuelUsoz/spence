import { expect, test } from '../fixtures';

test('a new Session sends a Message and shows the Agent reply', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  // The fake Agent echoes what follows `echo:`, in three chunks.
  await composer.fill('echo:Hello from the fake Agent, with `code` inside.');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toHaveText(
    'echo:Hello from the fake Agent, with `code` inside.',
  );
  await expect(page.getByTestId('message-agent')).toHaveText(
    'Hello from the fake Agent, with code inside.',
  );
  await expect(page.getByTestId('send')).toBeDisabled();
  await expect(page.getByTestId('stop')).toBeHidden();
  await expect(composer).toHaveValue('');
  // The Project path is a fresh temp folder each run.
  await spence.shot('session-reply', { mask: [page.getByTestId('project-path')] });
});
