import { expect, test } from '../fixtures';

test('renames a Session inline', async ({ spence }) => {
  const page = spence.page;
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('echo:First message');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  const row = page.getByTestId('session-row');
  await expect(row).toContainText('echo:First message');
  await row.dblclick();
  const editor = page.getByTestId('session-rename');
  await editor.fill('My Session');
  await spence.shot('sidebar-rename', { mask: [page.getByTestId('project-path')] });
  await editor.press('Enter');
  await expect(row).toContainText('My Session');
  await expect(page.getByTestId('panel-title')).toHaveText('My Session');
});

test('two Projects: switch between them and start a Session in each', async ({ spence }) => {
  const page = spence.page;
  const current = page.getByTestId('current-project');
  const title = page.getByTestId('panel-title');
  // The Project path is a fresh temp folder each run.
  const mask = [page.getByTestId('project-path')];

  const addProjectLabel = spence.t({ en: 'Add Project', es: 'Añadir Proyecto' });
  const newSessionLabel = spence.t({ en: 'New Session', es: 'Nueva Sesión' });

  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.getByTestId('add-project').click();
  await expect(current).toContainText('demo-project');
  await expect(page.getByTestId('sessions-empty')).toHaveText(
    spence.t({
      en: 'No Sessions in demo-project yet.',
      es: 'Aún no hay Sesiones en demo-project.',
    }),
  );
  await spence.shot('sidebar-empty', { mask });

  await spence.pickNext('second-project');
  await current.click();
  await page.getByRole('menuitem', { name: addProjectLabel }).click();
  await expect(current).toContainText('second-project');

  await page.getByTestId('new-session').click();
  await expect(title).toHaveText(newSessionLabel);

  await current.click();
  await expect(page.getByTestId('project-option-name')).toHaveText([
    'second-project',
    'demo-project',
  ]);
  await page.getByTestId('project-option').filter({ hasText: 'demo-project' }).click();
  await expect(current).toContainText('demo-project');

  await page.getByTestId('new-session').click();
  await expect(title).toHaveText(newSessionLabel);
  await expect(page.getByTestId('greeting')).toContainText('demo-project');
  // The draft's Session view (its Composer) shows once main has started the Session.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await spence.shot('sidebar-one-project', { mask });

  // Choosing the other Project makes it current.
  await current.click();
  await page.getByTestId('project-option').filter({ hasText: 'second-project' }).click();
  await expect(current).toContainText('second-project');
});

test('the gear opens Settings and the permanent rail stays unobstructed across sidebar collapse/expand', async ({
  spence,
}) => {
  const page = spence.page;
  const rail = page.getByTestId('workspace-rail');
  const railBox = await rail.boundingBox();
  expect(railBox).not.toBeNull();
  expect(railBox!.width).toBe(50);

  // Rail is visible and clickable even while the Sessions sidebar starts collapsed.
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await expect(page.getByTestId('settings-header')).toContainText(
    spence.t({ en: 'Settings', es: 'Ajustes' }),
  );

  // Clicking Sessions on the rail closes Settings and returns to the workspace.
  await page.getByTestId('rail-nav-sessions').click();
  await expect(page.getByTestId('settings-page')).toBeHidden();

  // Expanding the Sessions sidebar places it beside the 50px rail without overlapping it.
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await expect
    .poll(async () => (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.x)
    .toBe(50);
  const containerBox = await page.locator('[data-slot="sidebar-container"]').boundingBox();
  expect(containerBox).not.toBeNull();
  expect(containerBox!.width).toBe(256);

  // Settings on the rail remains clickable while the Sessions sidebar is expanded.
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  await page.getByTestId('settings-back').click();
  await expect(page.getByTestId('settings-page')).toBeHidden();

  // Collapsing via Mod+B tucks the Sessions sidebar behind the 50px rail without hiding the rail.
  await page.keyboard.press('ControlOrMeta+b');
  await expect
    .poll(async () => (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.x)
    .toBe(-206);
  await expect(rail).toBeVisible();
});

test('rail app icon has no background fill, shows Project Sessions tooltip, and returns to active Project Sessions without opening Switch Project', async ({
  spence,
}) => {
  const page = spence.page;
  const mark = page.getByTestId('rail-brand');
  const markImg = mark.locator('img');

  const markBox = await mark.boundingBox();
  expect(markBox).not.toBeNull();
  expect(markBox!.width).toBe(30);
  expect(markBox!.height).toBe(30);
  await expect(markImg).toBeVisible();
  await expect(markImg).toHaveAttribute('src', 'icon.png');
  await expect
    .poll(async () =>
      markImg.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0),
    )
    .toBe(true);
  await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(mark).toHaveText('');

  // Quiet fallback tooltip & no-op click when no Project exists yet.
  await mark.hover();
  await expect(page.getByRole('tooltip')).toContainText(
    spence.t({ en: 'Spence — No Project yet', es: 'Spence — Aún no hay Proyecto' }),
  );
  await mark.click();
  await expect(page.getByTestId('project-menu')).toBeHidden();
  await expect(page.locator('hlm-sidebar')).toHaveAttribute('data-state', 'collapsed');
  await page.mouse.move(400, 400);

  // Expand sidebar and add demo-project -> app icon remains with Project Sessions tooltip and no background fill.
  await page.locator('[data-slot="sidebar-trigger"]').click();
  await page.getByTestId('add-project').click();
  await expect(markImg).toHaveAttribute('src', 'icon.png');
  await expect(mark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(mark).toHaveText('');
  await mark.hover();
  await expect(
    page.getByRole('tooltip', {
      name: spence.t({
        en: 'demo-project — Sessions',
        es: 'demo-project — Sesiones',
      }),
    }),
  ).toBeVisible();
  await page.mouse.move(400, 400);

  // Collapse the Sessions sidebar, open Settings, then click the rail app icon to return to Sessions
  // without expanding the sidebar or opening Switch Project.
  await page.keyboard.press('ControlOrMeta+b');
  await expect
    .poll(async () => (await page.locator('[data-slot="sidebar-container"]').boundingBox())?.x)
    .toBe(-206);
  await page.getByTestId('open-settings').click();
  await expect(page.getByTestId('settings-header')).toBeVisible();

  await mark.click();
  await expect(page.getByTestId('settings-header')).toBeHidden();
  await expect(page.getByTestId('tab-strip')).toBeVisible();
  await expect(page.locator('hlm-sidebar')).toHaveAttribute('data-state', 'collapsed');
  await expect(page.getByTestId('project-menu')).toBeHidden();
});
