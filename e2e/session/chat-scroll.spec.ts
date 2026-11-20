import { expect, test } from '../fixtures';

test('long messages stay between the topbar and composer', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  const composer = page.getByTestId('composer-input');
  await composer.fill(
    Array.from(
      { length: 80 },
      (_, index) => `Paragraph ${index}: a long conversation stays inside the message viewport.`,
    ).join('\n\n'),
  );
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('send').click();
  await expect(page.getByTestId('message-agent')).toBeVisible();
  const scroller = page.getByTestId('thread-scroller');
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  const header = page.locator('app-top-bar');
  const headerBefore = await header.boundingBox();
  for (const position of [0, 0.5, 1]) {
    await scroller.evaluate((element, fraction) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * fraction;
    }, position);
    const bounds = await scroller.boundingBox();
    const input = await composer.boundingBox();
    const top = await header.boundingBox();
    expect(bounds).not.toBeNull();
    expect(input).not.toBeNull();
    expect(top).toEqual(headerBefore);
    if (bounds === null || input === null || top === null) throw new Error('Missing chat layout');
    expect(bounds.y).toBeGreaterThanOrEqual(top.y + top.height);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(input.y);
    await expect(composer).toBeInViewport();
  }
});
