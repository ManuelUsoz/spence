import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

test('attaches an image, sends it, and previews it in the thread', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill('What do you see?');

  const imagePath = path.join(spence.userData, 'test-image.png');
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas unavailable');
    context.fillStyle = '#4169a1';
    context.fillRect(0, 0, 320, 200);
    context.fillStyle = '#e9c46a';
    context.fillRect(48, 40, 224, 120);
    return canvas.toDataURL('image/png').split(',')[1] ?? '';
  });
  writeFileSync(imagePath, Buffer.from(png, 'base64'));
  await page.setInputFiles('[data-testid="attach-input"]', imagePath);

  await expect(page.getByTestId('composer-images')).toBeVisible();
  await spence.shot('composer-images', { mask: [page.getByTestId('project-path')] });

  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');

  await expect(page.getByTestId('message-user')).toContainText('What do you see?');
  await expect(page.getByTestId('message-images')).toBeVisible();

  await page.getByTestId('message-images').locator('button').first().click();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();
  await spence.shot('lightbox', { mask: [page.getByTestId('project-path')] });
});
