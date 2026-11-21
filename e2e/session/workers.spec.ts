import { expect, test, type Page } from '../fixtures';

const parentPanel = (page: Page) =>
  page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .filter({ hasNot: page.getByTestId('worker-parent') });

const workerPanel = (page: Page) =>
  page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .filter({ has: page.getByTestId('worker-parent') });

const workersPanel = (page: Page) =>
  page.locator('[data-testid="panel-frame"][data-panel-kind="Workers"]');

/** Starts a Session whose Agent delegates a busy Worker, and opens the Workers panel on it. */
const openPanel = async (page: Page) => {
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('delegate:busy');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('workers-toggle')).toContainText('1');
  await page.getByTestId('workers-toggle').click();
  await expect(workersPanel(page)).toBeVisible();
  await expect(workersPanel(page).getByTestId('worker-row')).toBeVisible();
};

/**
 * Back on the Parent Session once the Parent's own Turn has ended. Stopping the Worker ends the Parent's Turn a moment
 * later, and quitting while it still runs opens main's quit confirmation, which nothing answers.
 */
const returnToParent = async (page: Page) => {
  const worker = workerPanel(page);
  const parent = parentPanel(page);
  await worker.getByTestId('worker-parent').click();
  await expect(parent).toHaveAttribute('data-focused', 'true');
  // Only the Parent's own prompt is there; it stays separate from the Worker's thread.
  await expect(parent.getByTestId('message-user')).toHaveCount(1);
  await expect(parent.getByTestId('message-user')).toContainText('delegate:busy');
  await expect(parent.getByTestId('stop')).toBeHidden();
};

const stopWorker = async (page: Page) => {
  const worker = workerPanel(page);
  await worker.getByTestId('stop').click();
  await expect(worker.getByTestId('stop')).toBeHidden();
};

test('opens an active owned Worker and returns to its Parent Session', async ({ spence }) => {
  const page = spence.page;
  await openPanel(page);
  const workers = workersPanel(page);
  await expect(workers.getByTestId('workers-running')).toContainText('1');
  await expect(workers.getByTestId('worker-see-session')).toBeVisible();
  await spence.shot('workers-panel', { mask: [page.getByTestId('worker-meta')] });

  await workers.getByTestId('worker-row').click();
  const worker = workerPanel(page);
  await expect(worker).toBeVisible();
  await expect(worker).toHaveAttribute('data-focused', 'true');
  await expect(worker.getByTestId('worker-parent')).toBeVisible();
  await expect(worker.getByTestId('worker-hint')).toBeVisible();
  await expect(worker.getByTestId('message-user')).toContainText('busy');
  await expect(page.getByTestId('session-row').first()).toHaveAttribute('aria-current', 'page');
  await expect(workers).toBeVisible();
  await spence.shot('worker-session', { mask: [worker.getByTestId('worker-working')] });

  await stopWorker(page);
  const composer = worker.getByTestId('composer-input');
  await composer.fill('echo:Worker follow-up');
  await expect(worker.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(worker.getByTestId('message-agent')).toContainText('Worker follow-up');
  await returnToParent(page);
  await expect(worker).toHaveAttribute('data-focused', 'false');
});

test('records the started Worker in a quiet thread line and opens it from its menu', async ({
  spence,
}) => {
  const page = spence.page;
  await openPanel(page);
  const line = page.getByTestId('workers-line');
  await expect(line).toContainText(/Started 1 worker|Iniciados: 1 Worker/);
  await spence.shot('workers-line', { mask: [page.getByTestId('worker-meta')] });
  await line.click();
  await expect(page.getByTestId('workers-line-item')).toBeVisible();
  await spence.shot('workers-line-menu', { mask: [page.getByTestId('workers-panel')] });
  await page.getByTestId('workers-line-item').click();
  await expect(workerPanel(page).getByTestId('worker-parent')).toBeVisible();
  await stopWorker(page);
  await returnToParent(page);
});

test.describe('in the light theme', () => {
  test.use({ spenceSettings: { theme: 'light' } });

  test('shows the panel and the Worker view', async ({ spence }) => {
    const page = spence.page;
    await openPanel(page);
    await spence.shot('workers-panel-light', { mask: [page.getByTestId('worker-meta')] });
    await workersPanel(page).getByTestId('worker-row').click();
    const worker = workerPanel(page);
    await expect(worker.getByTestId('worker-hint')).toBeVisible();
    await spence.shot('worker-session-light', { mask: [worker.getByTestId('worker-working')] });
    await stopWorker(page);
    await returnToParent(page);
  });

  test('shows the thread line and its menu', async ({ spence }) => {
    const page = spence.page;
    await openPanel(page);
    await spence.shot('workers-line-light', { mask: [page.getByTestId('worker-meta')] });
    await page.getByTestId('workers-line').click();
    await expect(page.getByTestId('workers-line-item')).toBeVisible();
    await spence.shot('workers-line-menu-light', { mask: [page.getByTestId('workers-panel')] });
    await page.getByTestId('workers-line-item').click();
    await expect(workerPanel(page).getByTestId('worker-parent')).toBeVisible();
    await stopWorker(page);
    await returnToParent(page);
  });
});
