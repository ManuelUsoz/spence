import { expect, test } from '../fixtures';

test.describe('5s cancel grace and Stop Agent recovery', () => {
  test('shows Stopping… for 5s, surfaces Stop Agent, kills cleanly when alone, and preserves Transcript', async ({
    spence,
  }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const composer = page.getByTestId('composer-input');
    await composer.fill('stall');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');

    await expect(page.getByTestId('message-agent')).toContainText('working');
    await expect(page.getByTestId('stop')).toBeVisible();

    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-waiting')).toBeVisible();
    await expect(page.getByTestId('stop-waiting')).toBeDisabled();

    // After 5s cancel grace, Stop Agent replaces the cancel slot.
    await expect(page.getByTestId('stop-agent')).toBeVisible({ timeout: 10_000 });
    const mask = [
      page.getByTestId('project-path'),
      page.locator('[data-testid="ticker"] .tabular-nums'),
    ];
    await spence.shot('stop-agent-ready', { mask });

    await page.getByTestId('stop-agent').click();
    await expect(page.getByTestId('outcome')).toContainText(
      spence.t({ en: 'Fake was stopped.', es: 'Fake se detuvo.' }),
    );
    await expect(page.getByTestId('message-agent')).toContainText('working');

    // Follow-up prompt reconnects cleanly on a fresh Agent process.
    await composer.fill('echo:recovered');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('message-agent').last()).toContainText('recovered');
  });

  test('confirms before stopping an Agent shared with another working Session', async ({
    spence,
  }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    // Tab 1: active Turn that stays running.
    await page.getByTestId('new-session').click();
    const composer = page.getByTestId('composer-input');
    await composer.fill('busy');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('plan-dock')).toBeVisible();

    // Tab 2: stalled Turn on the same Agent.
    await page.getByTestId('new-session').click();
    await expect(page.getByTestId('tab')).toHaveCount(2);
    await composer.fill('stall');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByTestId('message-agent')).toContainText('working');

    await page.getByTestId('stop').click();
    await expect(page.getByTestId('stop-agent')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('stop-agent').click();

    const dialog = page.getByTestId('stop-agent-confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(
      spence.t({
        en: 'Stopping Fake will also interrupt 1 other working Session.',
        es: 'Detener Fake también interrumpirá otra Sesión en curso.',
      }),
    );
    await spence.shot('stop-agent-confirm', {
      mask: [
        page.getByTestId('project-path'),
        page.locator('[data-testid="ticker"] .tabular-nums'),
      ],
    });

    await page.getByTestId('stop-agent-confirm-action').click();
    await expect(page.getByTestId('outcome')).toContainText(
      spence.t({ en: 'Fake was stopped.', es: 'Fake se detuvo.' }),
    );

    // Tab 1's active Turn also ended as interrupted.
    await page.getByTestId('tab').first().click();
    await expect(page.getByTestId('outcome')).toContainText(
      spence.t({ en: 'Fake was stopped.', es: 'Fake se detuvo.' }),
    );
  });
});
