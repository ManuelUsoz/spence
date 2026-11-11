import { expect, test } from '../fixtures';

// Spanish screenshots come with the Spanish pass; this only checks that main opens the right build.
test.describe('in Spanish', () => {
  test.use({ spenceLocale: 'es' });

  test('main opens the Spanish build', async ({ spence }) => {
    await expect(spence.page.locator('html')).toHaveAttribute('lang', 'es');
    await expect(spence.page.getByTestId('no-chats')).toHaveText('Aún no hay chats.');
    await expect(spence.page.getByTestId('load-info')).toHaveText('Cargar información de la app');
  });
});

test('main opens the English build by default in e2e', async ({ spence }) => {
  await expect(spence.page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(spence.page.getByTestId('no-chats')).toHaveText('No chats yet.');
});
