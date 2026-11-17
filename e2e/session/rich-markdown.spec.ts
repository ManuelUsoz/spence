import { expect, test, type Page } from '../fixtures';

const openSession = async (page: Page) => {
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();
};

const send = async (page: Page, text: string) => {
  await page.getByTestId('composer-input').fill(text);
  await page.getByTestId('composer-input').press('Enter');
};

const heap = async (page: Page) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const { metrics } = await session.send('Performance.getMetrics');
  await session.detach();
  return metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? 0;
};

test('streams a long Markdown reply without losing selection, scroll or code copy', async ({
  spence,
}) => {
  test.setTimeout(90_000);
  const page = spence.page;
  await openSession(page);

  const heapBefore = await heap(page);
  const startedAt = Date.now();
  await send(page, 'markdown:long');

  await expect(page.getByRole('heading', { name: 'Section 1', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: 'Section 10', exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Select readable text while the reply is still arriving.
  const selected = await page.evaluate(() => {
    const paragraph = document.querySelector('[data-testid="message-agent"] p');
    if (!paragraph) return '';
    const node = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT).nextNode();
    if (!node || node.nodeType !== Node.TEXT_NODE) return '';
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(9, node.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() ?? '';
  });
  expect(selected.length).toBeGreaterThan(0);
  const scrollBefore = await page.evaluate(() => window.scrollY);

  // The reader is still reading: incoming text must not clear the selection.
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ''), {
      timeout: 5_000,
    })
    .toBe(selected);

  await expect(page.getByRole('heading', { name: 'Final section complete.' })).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(300);
  const elapsedMs = Date.now() - startedAt;
  const heapAfter = await heap(page);
  const scrollAfter = await page.evaluate(() => window.scrollY);

  expect(scrollAfter).toBe(scrollBefore);

  // Copy the first fenced block exactly, without fences or a label. Spy on the renderer clipboard so the assertion
  // does not depend on a real system clipboard being available in CI.
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          (window as unknown as { __copiedText?: string }).__copiedText = text;
        },
      },
    });
  });
  const firstCode = page.getByTestId('markdown-code').first();
  await firstCode.hover();
  await firstCode.getByTestId('markdown-copy').click();
  const copied = await page.evaluate(
    () => (window as unknown as { __copiedText?: string }).__copiedText,
  );
  expect(copied).toBe('const value = 1;');
  test.info().annotations.push({
    type: 'metrics',
    description: JSON.stringify({
      scenario: 'long Markdown stream',
      elapsedMs,
      heapBefore,
      heapAfter,
      heapDelta: heapAfter - heapBefore,
      selectionPreserved: true,
      scrollPreserved: scrollAfter === scrollBefore,
    }),
  });
});

test('renders a large structured Agent image with a bounded thumbnail and a full-size lightbox', async ({
  spence,
}) => {
  test.setTimeout(60_000);
  const page = spence.page;
  await openSession(page);

  const heapBefore = await heap(page);
  await send(page, 'image:reply');
  await expect(page.getByTestId('image-thumbnail')).toBeVisible({ timeout: 20_000 });

  // The thumbnail exists without a full-size <img> being shown yet.
  await expect(page.getByTestId('lightbox')).toBeHidden();
  const thumbnailSrc = await page.getByTestId('image-thumbnail').locator('img').getAttribute('src');
  expect(thumbnailSrc).toMatch(/^blob:/);
  const heapThumbnail = await heap(page);

  await page.getByTestId('image-thumbnail').click();
  await expect(page.getByTestId('lightbox-image')).toBeVisible();
  const decoded = await page.getByTestId('lightbox-image').evaluate((image) => ({
    width: (image as HTMLImageElement).naturalWidth,
    height: (image as HTMLImageElement).naturalHeight,
  }));
  expect(decoded).toEqual({ width: 1_600, height: 1_200 });
  const heapLightbox = await heap(page);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('lightbox')).toBeHidden();
  test.info().annotations.push({
    type: 'metrics',
    description: JSON.stringify({
      scenario: 'large structured image',
      heapBefore,
      heapThumbnail,
      heapLightbox,
      decoded,
    }),
  });
});
