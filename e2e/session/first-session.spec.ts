import { expect, test } from '../fixtures';

test('a new Session sends a Message and shows the Agent reply', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('project-list').getByTestId('project')).toHaveText([
    'demo-project',
  ]);

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  // The fake Agent echoes what follows `echo:`, in three chunks.
  await composer.fill('echo:Hello from the fake Agent, with `code` inside.');
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
  await spence.shot('session-reply');
});
