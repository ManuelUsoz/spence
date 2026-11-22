import { expect, test } from '../fixtures';

test('the full Session pane scrolls the thread above the fixed composer', async ({ spence }) => {
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
  const panel = page.getByTestId('panel-body');
  const panelBounds = await panel.boundingBox();
  const viewport = await scroller.boundingBox();
  if (panelBounds === null || viewport === null) throw new Error('Missing Session viewport');
  expect(viewport.x).toBeCloseTo(panelBounds.x, 0);
  expect(viewport.width).toBeCloseTo(panelBounds.width, 0);

  const composerBefore = await composer.boundingBox();
  await scroller.evaluate((element) => (element.scrollTop = 0));
  await page.mouse.move(viewport.x + 8, viewport.y + viewport.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  expect(await composer.boundingBox()).toEqual(composerBefore);

  const latest = page.getByTestId('scroll-to-bottom');
  await latest.click();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThan(1);

  const header = page.locator('app-panel-header').first();
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
