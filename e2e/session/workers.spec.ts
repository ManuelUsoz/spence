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
  await page.getByTestId('worker-parent').click();
  await expect(page.getByTestId('message-user')).toContainText('delegate:busy');
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
    await page.getByTestId('worker-parent').click();
    await expect(page.getByTestId('stop')).toBeHidden();
  });
});
