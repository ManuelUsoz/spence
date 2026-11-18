import { expect, test, type Spence } from '../fixtures';

/** Starts a Session whose Agent delegates a busy Worker, and opens the Workers panel on it. */
const openPanel = async (spence: Spence) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('delegate:busy');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('workers-toggle')).toContainText('1');
  await page.getByTestId('workers-toggle').click();
  await expect(page.getByTestId('worker-row')).toBeVisible();
};

/**
 * Back on the Parent Session once the Parent's own Turn has ended. Stopping the Worker ends the Parent's Turn a moment
 * later, and quitting while it still runs opens main's quit confirmation, which nothing answers.
 */
const returnToParent = async (spence: Spence) => {
  const page = spence.page;
  await page.getByTestId('worker-parent').click();
  await expect(page.getByTestId('worker-parent')).toBeHidden();
  // Only the Parent's own prompt is there once its thread has replaced the Worker's.
  await expect(page.getByTestId('message-user')).toHaveCount(1);
  await expect(page.getByTestId('stop')).toBeHidden();
};

const stopWorker = async (spence: Spence) => {
  const page = spence.page;
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('stop')).toBeHidden();
};

test('opens an active owned Worker and returns to its Parent Session', async ({ spence }) => {
  const page = spence.page;
  await openPanel(spence);
  await expect(page.getByTestId('workers-running')).toContainText('1');
  await expect(page.getByTestId('worker-see-session')).toBeVisible();
  await spence.shot('workers-panel', { mask: [page.getByTestId('worker-meta')] });

  await page.getByTestId('worker-row').click();
  await expect(page.getByTestId('worker-parent')).toBeVisible();
  await expect(page.getByTestId('worker-hint')).toBeVisible();
  await expect(page.getByTestId('message-user')).toContainText('busy');
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('workers-sidebar')).toBeHidden();
  await spence.shot('worker-session', { mask: [page.getByTestId('worker-working')] });

  await stopWorker(spence);
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Worker follow-up');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toContainText('Worker follow-up');
  await returnToParent(spence);
  // Until the Parent is open the thread still shows the Worker's two Messages (its task and the follow-up).
  await expect(page.getByTestId('message-user')).toContainText('delegate:busy');
});

test('records the started Worker in a quiet thread line and opens it from its menu', async ({
  spence,
}) => {
  const page = spence.page;
  await openPanel(spence);
  const line = page.getByTestId('workers-line');
  await expect(line).toContainText(/Started 1 worker|Iniciados: 1 Worker/);
  await spence.shot('workers-line', { mask: [page.getByTestId('worker-meta')] });
  await line.click();
  await expect(page.getByTestId('workers-line-item')).toBeVisible();
  await spence.shot('workers-line-menu', { mask: [page.getByTestId('workers-sidebar')] });
  await page.getByTestId('workers-line-item').click();
  await expect(page.getByTestId('worker-parent')).toBeVisible();
  await stopWorker(spence);
  await returnToParent(spence);
});

test.describe('in the light theme', () => {
  test.use({ spenceSettings: { theme: 'light' } });

  test('shows the panel and the Worker view', async ({ spence }) => {
    const page = spence.page;
    await openPanel(spence);
    await spence.shot('workers-panel-light', { mask: [page.getByTestId('worker-meta')] });
    await page.getByTestId('worker-row').click();
    await expect(page.getByTestId('worker-hint')).toBeVisible();
    await spence.shot('worker-session-light', { mask: [page.getByTestId('worker-working')] });
    await stopWorker(spence);
    await returnToParent(spence);
  });

  test('shows the thread line and its menu', async ({ spence }) => {
    const page = spence.page;
    await openPanel(spence);
    await spence.shot('workers-line-light', { mask: [page.getByTestId('worker-meta')] });
    await page.getByTestId('workers-line').click();
    await expect(page.getByTestId('workers-line-item')).toBeVisible();
    await spence.shot('workers-line-menu-light', { mask: [page.getByTestId('workers-sidebar')] });
    await page.getByTestId('workers-line-item').click();
    await expect(page.getByTestId('worker-parent')).toBeVisible();
    await stopWorker(spence);
    await returnToParent(spence);
  });
});
