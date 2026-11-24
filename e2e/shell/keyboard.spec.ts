import { expect, test } from '../fixtures';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test('Mod+N creates a draft, Enter sends, and Esc stops a running Turn', async ({ spence }) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  await page.keyboard.press(`${MOD}+n`);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible();
  await expect(composer).toBeFocused();

  await composer.fill('hold');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('message-agent')).toContainText('working');
  await expect(page.getByTestId('stop')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByText(spence.t({ en: 'Stopped.', es: 'Detenido.' }))).toBeVisible();
  await expect(page.getByTestId('stop')).toBeHidden();
});

test('Sidebar rows switch Sessions and restore the unsent draft, type-to-focus works, and Dock 1-4 answers permissions', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // Session 1.
  await page.keyboard.press(`${MOD}+n`);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeFocused();
  await composer.fill('echo:First');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('message-agent')).toContainText('First');

  // Session 2 with unsent draft.
  await page.keyboard.press(`${MOD}+n`);
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(composer).toBeFocused();
  await page.keyboard.type('unsent draft');
  await expect(composer).toHaveValue('unsent draft');

  // The sidebar row switches to Session 1.
  await page.getByTestId('session-row').first().click();
  await expect(page.getByTestId('message-agent')).toContainText('First');

  // Type-to-focus: clicking thread prose leaves Composer; typing focuses Composer and inserts text.
  await page.getByTestId('message-agent').click();
  await expect(composer).not.toBeFocused();
  await page.keyboard.type('hi');
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('hi');

  // Mod+N returns to the unsent draft of Session 2 and restores its text.
  await page.keyboard.press(`${MOD}+n`);
  await expect(composer).toHaveValue('unsent draft');
  await composer.focus();

  // Toggle Permission mode with Mod+Shift+A, send 'permit', and answer Dock with '1'.
  await composer.fill('');
  await page.keyboard.press(`${MOD}+Shift+A`);
  await expect(page.getByTestId('permission-mode')).toContainText(
    spence.t({ en: 'Ask', es: 'Preguntar' }),
  );
  await composer.fill('permit');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('dock')).toBeVisible();
  await spence.shot('keyboard-dock-hints', {
    mask: [page.getByTestId('project-path'), page.getByTestId('dock-cwd')],
  });

  await page.keyboard.press('1');
  await expect(page.getByTestId('dock')).toBeHidden();
  await expect(page.getByTestId('message-agent')).toContainText('permission allow');
  await expect(page.getByTestId('stop')).toBeHidden();
});

test('Sidebar roving focus: arrows, Enter, Shift+arrows, Mod+A, F2 rename, and Delete archive with Undo', async ({
  spence,
}) => {
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  for (const [index, label] of ['echo:One', 'echo:Two', 'echo:Three'].entries()) {
    await page.keyboard.press(`${MOD}+n`);
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await expect(page.getByTestId('session-row')).toHaveCount(index);
    await expect(page.getByTestId('message-agent')).toHaveCount(0);
    const composer = page.getByTestId('composer-input');
    await expect(composer).toBeFocused();
    await composer.fill(label);
    await expect(page.getByTestId('send')).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('message-agent').last()).toContainText(label.slice(5));
  }

  const rows = page.getByTestId('session-row');
  await expect(rows).toHaveCount(3);
  await rows.first().focus();
  await expect(rows.first()).toHaveAttribute('tabindex', '0');

  // ArrowDown moves roving focus without changing active Session; Enter opens it.
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute('tabindex', '0');
  await expect(rows.first()).toHaveAttribute('tabindex', '-1');
  await spence.shot('keyboard-roving-focus', { mask: [page.getByTestId('project-path')] });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText('Two');

  // Shift+ArrowDown extends selection; Escape clears selection.
  await rows.first().focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(rows.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="session-row"][aria-selected="true"]')).toHaveCount(0);

  // Mod+A selects all Sessions in the Project; Escape clears selection.
  await rows.first().focus();
  await page.keyboard.press(`${MOD}+a`);
  await expect(page.locator('[data-testid="session-row"][aria-selected="true"]')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="session-row"][aria-selected="true"]')).toHaveCount(0);

  // F2 renames inline and restores focus to the row on Enter.
  await rows.first().focus();
  await page.keyboard.press('F2');
  const renameInput = page.getByTestId('session-rename');
  await expect(renameInput).toBeFocused();
  await renameInput.fill('Renamed via keyboard');
  await renameInput.press('Enter');
  await expect(rows.first()).toContainText('Renamed via keyboard');
  await expect(rows.first()).toBeFocused();

  // Delete archives the focused row and shows an Undo toast.
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('archived-fold')).toContainText(
    spence.t({ en: 'Archived (1)', es: 'Archivadas (1)' }),
  );
  await expect(
    page.getByRole('button', { name: spence.t({ en: 'Undo', es: 'Deshacer' }) }),
  ).toBeVisible();
});
