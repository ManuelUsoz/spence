import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  await page.goto(new URL('../docs/Spence — Vista de chat (calma).html', import.meta.url).href);
  await page.waitForTimeout(2000);
  console.warn(await page.locator('iframe').count());
  console.warn((await page.locator('body').innerText()).slice(0, 1500));
  for (const [index, frame] of page.frames().entries()) {
    if (index < 5) console.warn(index, (await frame.locator('body').innerText()).slice(0, 6000));
  }
  await page.screenshot({
    path: 'src/app/features/session/source-control-prototype/reference.png',
  });
  await page
    .locator('iframe')
    .nth(3)
    .screenshot({
      path: 'src/app/features/session/source-control-prototype/reference-changes.png',
    });
} finally {
  await browser.close();
}
