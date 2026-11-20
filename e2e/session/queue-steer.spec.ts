import { expect, test } from '../fixtures';

/** `Mod` is ⌘ on macOS and Ctrl elsewhere, like the app's chords. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('Queue and Steer message modes', () => {
  test('steers a running Turn and drains a reordered, cleared Queue', async ({ spence }) => {
    const page = spence.page;
    await page.getByTestId('add-project').click();
    await expect(page.getByTestId('current-project')).toContainText('demo-project');

    await page.getByTestId('new-session').click();
    const composer = page.getByTestId('composer-input');
    await composer.fill('steer-hold');
    await expect(page.getByTestId('send')).toBeEnabled();
    await composer.press('Enter');

    await expect(page.getByTestId('message-agent')).toContainText('working');
    await expect(page.getByTestId('send-mode')).toBeVisible();

    await composer.fill('please adjust');
    await page.getByTestId('send-mode-steer').click();
    await composer.press(`${MOD}+Enter`);
    await expect(page.getByTestId('steered-badge')).toBeVisible();
    await expect(page.getByTestId('message-user').last()).toContainText('please adjust');
    await expect(page.getByTestId('message-agent').last()).toContainText('steered:please adjust');

    await composer.fill('echo:first');
    await page.getByTestId('send-mode-queue').click();
    await composer.press(`${MOD}+Enter`);
    await expect(page.getByTestId('queued-message')).toHaveCount(1);

    await composer.fill('echo:second');
    await composer.press(`${MOD}+Enter`);
    await expect(page.getByTestId('queued-message')).toHaveCount(2);
    await expect(page.getByTestId('queued-message').first()).toContainText('echo:first');
    await expect(page.getByTestId('queued-message').last()).toContainText('echo:second');

    await spence.shot('queue-steer', {
      mask: [
        page.getByTestId('project-path'),
        page.locator('[data-testid="ticker"] .tabular-nums'),
      ],
    });

    await page.getByTestId('queued-message').last().getByTestId('queue-up').click();
    await expect(page.getByTestId('queued-message').first()).toContainText('echo:second');

    await page.getByTestId('queued-message').last().getByTestId('queue-remove').click();
    await expect(page.getByTestId('queued-message')).toHaveCount(1);
    await expect(page.getByTestId('queued-message')).toContainText('echo:second');

    await page.getByTestId('clear-queue').click();
    await expect(page.getByTestId('queued-message')).toHaveCount(0);

    await composer.fill('echo:queued');
    await composer.press(`${MOD}+Enter`);
    await expect(page.getByTestId('queued-message')).toContainText('echo:queued');

    await page.getByTestId('stop').click();
    await expect(page.getByTestId('outcome')).toContainText(
      spence.t({ en: 'Stopped.', es: 'Detenido.' }),
    );
    await expect(page.getByTestId('queued-message')).toHaveCount(0);
    await expect(page.getByTestId('message-user').last()).toContainText('echo:queued');
    await expect(page.getByTestId('message-agent').last()).toContainText('queued');
  });
});
