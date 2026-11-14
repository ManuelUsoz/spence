import { expect, test } from '../fixtures';

test('Context usage ring updates from Agent reports, shows hover/focus details, and invalidates on Model change and Clear', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();

  const ring = page.getByTestId('context-ring');
  const track = page.getByTestId('context-ring-track');
  const arc = page.getByTestId('context-ring-arc');
  const tooltip = page.getByRole('tooltip');

  // 1. Starts unavailable with a neutral dotted ring and hover details.
  await expect(ring).toBeVisible();
  await expect(track).toHaveAttribute('stroke-dasharray', '2 3');
  await expect(arc).toHaveCount(0);
  await ring.hover();
  await expect(tooltip).toContainText(
    spence.t({ en: 'Context usage unavailable', es: 'Uso de contexto no disponible' }),
  );
  await page.mouse.move(0, 0);
  await expect(tooltip).toHaveCount(0);

  // 2. Agent reports 24,000 / 200,000 -> measured arc + keyboard-focus tooltip details.
  await page.getByTestId('composer-input').fill('usage:24000/200000');
  await page.getByTestId('composer-input').press('Enter');
  await expect(arc).toBeVisible();
  await expect(arc).toHaveAttribute('stroke-dashoffset', '88');
  await expect(arc).not.toHaveClass(/text-destructive/);

  await ring.focus();
  await expect(tooltip).toContainText(spence.t({ en: '12.00%', es: '12,00%' }));
  await expect(tooltip).toContainText(
    spence.t({ en: '24,000 / 200,000 tokens.', es: '24.000 / 200.000 tokens.' }),
  );
  await expect(tooltip).toContainText(
    spence.t({
      en: 'Latest report; not a live counter.',
      es: 'Último reporte; no es un contador en vivo.',
    }),
  );
  await spence.shot('context-ring-reported-tooltip', { mask: [page.getByTestId('project-path')] });

  // 3. Over-capacity (>100%) caps the SVG arc at 100% with destructive color, keeping un-clamped %.
  await page.getByTestId('composer-input').fill('usage:210000/200000');
  await page.getByTestId('composer-input').press('Enter');
  await expect(arc).toHaveAttribute('stroke-dashoffset', '0');
  await expect(arc).toHaveClass(/text-destructive/);
  await ring.focus();
  await expect(tooltip).toContainText(spence.t({ en: '105.00%', es: '105,00%' }));

  // 4. Missing/zero capacity renders count-only dotted ring without percentage.
  await page.getByTestId('composer-input').fill('usage:12500/0');
  await page.getByTestId('composer-input').press('Enter');
  await expect(arc).toHaveCount(0);
  await expect(track).toHaveAttribute('stroke-dasharray', '2 3');
  await ring.focus();
  await expect(tooltip).toContainText(
    spence.t({ en: 'capacity unknown', es: 'capacidad desconocida' }),
  );

  // 5. Changing Model immediately invalidates the prior reading.
  await page.locator('#model-picker').selectOption('large');
  await expect(ring).toHaveAttribute(
    'aria-label',
    spence.t({ en: /Context usage unavailable/, es: /Uso de contexto no disponible/ }),
  );

  // 6. Reporting again then clearing context immediately invalidates back to unavailable.
  await page.getByTestId('composer-input').fill('usage:24000/200000');
  await page.getByTestId('composer-input').press('Enter');
  await expect(arc).toBeVisible();
  await page.getByTestId('clear-context').click();
  await expect(page.getByTestId('context-divider')).toBeVisible();
  await expect(arc).toHaveCount(0);
  await expect(track).toHaveAttribute('stroke-dasharray', '2 3');
});
