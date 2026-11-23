import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const prompt = async (page: Page, message: string) => {
  const input = page.getByTestId('composer-input');
  await expect(input).toBeVisible();
  await input.fill(message);
  await expect(page.getByTestId('send')).toBeEnabled();
  await input.press('Enter');
};

test('an Agent starts a Session in another Project and both Threads link to each other', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await prompt(page, 'echo:Cross-project work');
  await expect(page.getByTestId('message-agent').last()).toContainText('Cross-project work');

  await spence.pickNext('second-project');
  await page.getByTestId('current-project').click();
  await page
    .getByRole('menuitem', { name: spence.t({ en: 'Add Project', es: 'Añadir Proyecto' }) })
    .click();
  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await page.getByTestId('current-project').click();
  await page.getByTestId('project-option').filter({ hasText: 'demo-project' }).click();
  await page.getByTestId('tab-item').first().click();

  await prompt(page, 'mcp:list_sessions:{}');
  const discovery = page.getByTestId('message-agent').last();
  await expect(discovery).toContainText('second-project');
  const targets = JSON.parse(await discovery.innerText()) as {
    readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  };
  const destination = targets.projects.find((project) => project.name === 'second-project');
  if (destination === undefined)
    throw new Error('The Agent did not discover the destination Project');
  await prompt(
    page,
    `mcp:start_session:${JSON.stringify({
      project: destination.id,
      text: 'echo:Destination result',
      requestId: 'start-destination',
    })}`,
  );

  const sent = page.getByTestId('message-sent');
  await expect(sent).toContainText('echo:Destination result');
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await expect(page.getByTestId('tab-item')).toHaveCount(1);
  await page.getByTestId('current-project').click();
  await page.getByTestId('project-option').filter({ hasText: 'second-project' }).click();
  await expect(page.getByTestId('tab-item')).toHaveCount(1);

  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await expect(page.getByTestId('message-agent').last()).toContainText('Destination result');
  const received = page.getByTestId('message-from');
  await expect(received).toContainText('demo-project');
  await expect(page.getByTestId('context-divider')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await spence.shot('session-collaboration');
  await received.getByRole('button').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await expect(sent).toBeVisible();
  await sent.getByRole('button').click();
  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await expect(page.getByTestId('tab-item')).toHaveCount(1);
});
