import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

test('Receipt keeps Steps collapsed by default, highlights slow Steps >= 10s, and toggles structured Step details', async ({
  spence,
}) => {
  const { page } = spence;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('step-details-slow');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  const receipt = page.getByTestId('receipt').last();
  await expect(receipt).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('message-agent')).toContainText('done');

  const stepsTrigger = receipt.locator('[hlmTraceCollapsibleTrigger]').first();
  const stepsContent = receipt.locator('hlm-trace-collapsible-content').first();
  await expect(stepsTrigger).toContainText(spence.t({ en: '2 steps', es: '2 pasos' }));
  await expect(stepsTrigger).toHaveAttribute('aria-expanded', 'false');
  await expect(stepsContent).toHaveAttribute('data-state', 'closed');
  expect((await stepsContent.boundingBox())?.height ?? 0).toBe(0);

  await stepsTrigger.click();
  await expect(stepsTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(stepsContent).toHaveAttribute('data-state', 'open');

  const stepRows = receipt.getByTestId('receipt-step');
  await expect(stepRows).toHaveCount(2);
  await expect(stepRows.nth(0)).toBeVisible();

  const durations = receipt.getByTestId('receipt-step-duration');
  await expect(durations).toHaveCount(2);
  await expect(durations.nth(0)).toHaveAttribute('data-slow', 'true');
  await expect(durations.nth(0)).toContainText(/\b1\d(\.\d)?s/);
  await expect(durations.nth(1)).not.toHaveAttribute('data-slow', 'true');

  // Inspect slow failed execute Step: cwd, input, truncated output, exitCode.
  await stepRows.nth(0).click();
  await expect(stepRows.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(receipt.getByTestId('receipt-step-cwd')).toContainText('pkg');
  await expect(receipt.getByTestId('receipt-step-input')).toContainText('npm test -- --run');
  await expect(receipt.getByTestId('receipt-step-output')).toContainText('TAIL_END');
  await expect(receipt.getByTestId('receipt-step-truncated')).toContainText(
    spence.t({ en: 'Showing the last 32 KB.', es: 'Mostrando los últimos 32 KB.' }),
  );
  await expect(receipt.getByTestId('receipt-step-exit-code')).toContainText('2');

  // Inspect edit Step inline diff.
  await stepRows.nth(1).click();
  await expect(stepRows.nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(receipt.getByTestId('receipt-step-diff')).toContainText('const a = 2;');
});

test('Sidebar and Tab calm marks and hover tooltips show live action, ticking elapsed time, and blockedTarget', async ({
  spence,
}) => {
  const { page } = spence;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // Session 1: live execute Step -> calm running marks + ticking hover tooltip.
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('ticker-live');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('ticker')).toContainText('node live-task');
  const firstRow = page.getByTestId('session-row').first();
  const firstTab = page.getByTestId('tab-item').first();
  await expect(firstRow.getByTestId('session-running')).toBeVisible();
  await expect(firstTab.getByTestId('tab-activity-indicator')).toBeVisible();

  const runningVerb = spence.t({ en: 'running', es: 'ejecutando' });
  await firstRow.hover();
  const tooltip = page.locator('[role="tooltip"][data-state="open"]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText('ticker-live');
  await expect(tooltip).toContainText(`${runningVerb} node live-task`);

  const readSeconds = async (): Promise<number> => {
    const text = (await tooltip.textContent()) ?? '';
    const match = /·\s*(\d+)\s*s/.exec(text);
    return match ? Number(match[1]) : -1;
  };
  const t0 = await readSeconds();
  expect(t0).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await readSeconds()) > t0, { timeout: 4_000 }).toBe(true);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  await firstTab.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(`${runningVerb} node live-task`);
  const tabT0 = await readSeconds();
  expect(tabT0).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await readSeconds()) > tabT0, { timeout: 4_000 }).toBe(true);

  // Session 2: pending Permission request -> blockedTarget in Sidebar and Tab tooltips,
  // while Session 1 remains a background Tab with its live running tooltip.
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('message-user')).toHaveCount(0);
  await page.getByTestId('permission-mode').click();
  await page.getByTestId('permission-mode-ask').click();
  await page.getByTestId('composer-input').fill('permit');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('dock')).toBeVisible();

  const blockedRow = page
    .getByTestId('session-row')
    .filter({ has: page.getByTestId('attention-needsAnswer') });
  await expect(blockedRow).toHaveCount(1);

  const blockedPrefix = spence.t({
    en: 'waiting for permission: ls -la',
    es: 'esperando permiso: ls -la',
  });
  await blockedRow.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(blockedPrefix);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  const tabs = page.getByTestId('tab-item');
  await expect(tabs).toHaveCount(2);
  await tabs.nth(1).hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(blockedPrefix);

  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  // Unfocused background Tab (Session 1) still shows live running micro-status.
  await tabs.nth(0).hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(`${runningVerb} node live-task`);

  // Cleanly finish both running Turns before teardown.
  await page.getByTestId('dock-option').first().click();
  await expect(page.getByTestId('dock')).toBeHidden();
  await tabs.nth(0).click();
  writeFileSync(path.join(spence.pickFolder, '.ticker-step2'), 'go');
  writeFileSync(path.join(spence.pickFolder, '.ticker-finish'), 'done');
  await expect(page.getByTestId('ticker')).toBeHidden();
});
