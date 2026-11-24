import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

test('live Ticker stays collapsed by default, streams live Step tails and touched-file diffs when expanded, and auto-collapses into Receipt on Turn end', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('ticker-live');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  const ticker = page.getByTestId('ticker');
  const toggle = page.getByTestId('ticker-toggle');
  await expect(ticker).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('ticker-drawer')).toHaveCount(0);

  // Wait until the live execute Step has started before expanding.
  await expect(ticker).toContainText('node live-task');
  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const drawer = page.getByTestId('ticker-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).not.toContainText('Hidden live reasoning prose');

  const steps = drawer.getByTestId('ticker-step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0).getByTestId('ticker-step-title')).toHaveText('src/view.ts');
  await expect(steps.nth(1).getByTestId('ticker-step-title')).toHaveText('src/live.ts');
  await expect(steps.nth(2).getByTestId('ticker-step-title')).toHaveText('node live-task');
  await expect(steps.nth(2).getByTestId('ticker-step-status')).toHaveText(
    spence.t({ en: 'Running', es: 'Ejecutando' }),
  );
  await expect(steps.nth(0).getByTestId('ticker-step-duration')).toBeVisible();
  await expect(steps.nth(2).getByTestId('ticker-step-duration')).toBeVisible();

  // Expand the running execute Step to watch live terminal output stream via StepDelta.
  await steps.nth(2).click();
  await expect(steps.nth(2)).toHaveAttribute('aria-expanded', 'true');
  const liveOutput = drawer.getByTestId('ticker-step-output');
  await expect(liveOutput).toContainText('live-chunk-1');

  writeFileSync(path.join(spence.pickFolder, '.ticker-step2'), 'go');
  await expect(liveOutput).toContainText('live-chunk-2');
  await expect(drawer.getByTestId('ticker-step-exit-code')).toContainText('0');

  // Inspect touched files and toggle inline diff mid-Turn.
  const touched = drawer.getByTestId('ticker-touched-files');
  await expect(touched).toContainText('view.ts');
  await expect(touched).toContainText('live.ts');
  await touched.getByRole('button', { name: /live\.ts/ }).click();
  const inlineDiff = drawer.getByTestId('ticker-file-diff');
  await expect(inlineDiff).toBeVisible();
  await expect(inlineDiff).toContainText('const x = 1;');
  await expect(inlineDiff).toContainText('const x = 2;');

  // Let the Turn finish and verify clean transition into a collapsed Receipt.
  writeFileSync(path.join(spence.pickFolder, '.ticker-finish'), 'done');
  await expect(ticker).toBeHidden();
  await expect(page.getByTestId('message-agent')).toContainText('All live checks passed.');
  const receipt = page.getByTestId('receipt').last();
  await expect(receipt).toBeVisible();
  await expect(receipt.locator('[hlmTraceCollapsibleTrigger]').first()).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});
