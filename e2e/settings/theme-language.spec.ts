import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

const prefersDark = (page: Page) =>
  page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
const background = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('switching the Theme changes the rendered colors', async ({ spence }) => {
  const { page } = spence;
  await expect(page.getByTestId('no-projects')).toBeVisible();

  await spence.updateSettings({ theme: 'light' });
  await expect.poll(() => prefersDark(page)).toBe(false);
  const light = await background(page);
  await spence.shot('settings-theme-light');

  await spence.updateSettings({ theme: 'dark' });
  await expect.poll(() => prefersDark(page)).toBe(true);
  const dark = await background(page);
  await spence.shot('settings-theme-dark');

  expect(dark).not.toBe(light);
});

test('switching the Language reloads into the selected locale', async ({ spence }) => {
  const { page } = spence;
  const target = spence.locale === 'es' ? 'en' : 'es';
  await expect(page.locator('html')).toHaveAttribute('lang', spence.locale);

  await spence.updateSettings({ language: target });

  await expect(page.locator('html')).toHaveAttribute('lang', target);
  await expect(page.getByTestId('no-projects')).toHaveText(
    target === 'es' ? 'Aún no hay Proyectos.' : 'No Projects yet.',
  );
});
