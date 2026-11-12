import { expect, test } from '../fixtures';

test('the renderer reads app info from main through DesktopApi', async ({ spence }) => {
  await expect(spence.page.getByTestId('load-info')).toBeVisible();
  await spence.page.getByTestId('load-info').click();
  await expect(spence.page.getByTestId('info')).toContainText('spence');
  await spence.shot('app-info-loaded');
});
