import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, type Locator, type Page } from '@playwright/test';
import { expect, sandboxArgs, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const createKeptSessionInCurrentTab = async (
  page: Page,
  prompt: string,
  expectedReply: string,
): Promise<void> => {
  const composer = page.getByTestId('composer-input').first();
  await expect(composer).toBeVisible();
  await composer.fill(prompt);
  await expect(page.getByTestId('send').first()).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent').last()).toContainText(expectedReply);
};

const dragBetween = async (
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  beforeDrop?: () => Promise<void>,
): Promise<void> => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  if (beforeDrop !== undefined) await beforeDrop();
  await page.mouse.up();
};

const boxCenter = async (locator: Locator): Promise<{ readonly x: number; readonly y: number }> => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('Expected element to have a bounding box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

test('per-Project Tab strips switch independently while keeping background Tabs and running Sessions alive', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');

  // Tab 1 in Project A: kept Session with custom Tab rename.
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Alpha', 'Alpha');
  await page.getByTestId('tab-item').first().dblclick();
  const tabRename = page.getByTestId('tab-rename-input');
  await expect(tabRename).toBeFocused();
  await tabRename.fill('Alpha Tab');
  await tabRename.press('Enter');
  await expect(page.getByTestId('tab-title').first()).toHaveText('Alpha Tab');

  // Tab 2 in Project A: kept Session with a running Turn ('hold').
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Background', 'Background');
  const composer = page.getByTestId('composer-input');
  await composer.fill('hold');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('stop')).toBeVisible();
  await expect(page.getByTestId('tab-item')).toHaveCount(2);

  // Add Project B and switch to it: independent empty Tab strip, Project A keeps running in background.
  await spence.pickNext('second-project');
  await page.getByTestId('current-project').click();
  await page
    .getByRole('menuitem', { name: spence.t({ en: 'Add Project', es: 'Añadir Proyecto' }) })
    .click();
  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await expect(page.getByTestId('tab-item')).toHaveCount(0);
  await expect(page.getByTestId('empty-workspace')).toBeVisible();

  await page.getByTestId('empty-new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Beta', 'Beta');
  await expect(page.getByTestId('tab-title')).toHaveText(['echo:Beta']);

  // Project switcher shows running indicator on demo-project while Project B is active.
  await page.getByTestId('current-project').click();
  const demoOption = page.getByTestId('project-option').filter({ hasText: 'demo-project' });
  await expect(demoOption.getByTestId('session-running')).toBeVisible();
  await demoOption.click();

  // Project A's Tabs, custom title, and running Session survived intact.
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await expect(page.getByTestId('tab-title')).toHaveText(['Alpha Tab', 'echo:Background']);
  await expect(page.getByTestId('stop')).toBeVisible();

  // Cleanly stop the running Turn before teardown.
  await page.getByTestId('stop').click();
  await expect(page.getByTestId('stop')).toBeHidden();
});

test('splits up to 4 Panes, disables splitting at cap, and resizes Pane dividers with pointer drag', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Main', 'Main');

  // Split into 2x2 = 4 Panes.
  await page.getByTestId('panel-split-trigger').first().click();
  await page.getByTestId('panel-split-right').click();
  await expect(page.getByTestId('pane-view')).toHaveCount(2);

  await page.getByTestId('panel-split-trigger').nth(0).click();
  await page.getByTestId('panel-split-down').click();
  await expect(page.getByTestId('pane-view')).toHaveCount(3);

  await page.getByTestId('panel-split-trigger').nth(2).click();
  await page.getByTestId('panel-split-down').click();
  await expect(page.getByTestId('pane-view')).toHaveCount(4);

  // At 4 Panes, Split right / Split down are disabled with an explanation.
  await page.getByTestId('panel-split-trigger').first().click();
  await expect(page.getByTestId('panel-split-right')).toBeDisabled();
  await expect(page.getByTestId('panel-split-down')).toBeDisabled();
  await expect(page.getByTestId('panel-split-reason').first()).toBeVisible();
  await page.keyboard.press('Escape');

  // Drag horizontal Pane divider right by 90px and verify branch widths change.
  const hDivider = page.locator('[data-testid="pane-resize-divider"][data-direction="horizontal"]');
  const rootBranches = page
    .locator('[data-testid="pane-split"][data-direction="horizontal"]')
    .first()
    .locator('> [data-testid="pane-branch"]');
  const firstBefore = await rootBranches.nth(0).boundingBox();
  const secondBefore = await rootBranches.nth(1).boundingBox();
  if (firstBefore === null || secondBefore === null) throw new Error('Missing pane branches');

  const hCenter = await boxCenter(hDivider);
  await dragBetween(page, hCenter, { x: hCenter.x + 90, y: hCenter.y });

  const firstAfter = await rootBranches.nth(0).boundingBox();
  const secondAfter = await rootBranches.nth(1).boundingBox();
  if (firstAfter === null || secondAfter === null) throw new Error('Missing resized branches');
  expect(firstAfter.width).toBeGreaterThan(firstBefore.width + 40);
  expect(secondAfter.width).toBeLessThan(secondBefore.width - 40);

  // Drag first vertical Pane divider down by 55px and verify branch heights change.
  const vDivider = page
    .locator('[data-testid="pane-resize-divider"][data-direction="vertical"]')
    .first();
  const vBranches = page
    .locator('[data-testid="pane-split"][data-direction="vertical"]')
    .first()
    .locator('> [data-testid="pane-branch"]');
  const topBefore = await vBranches.nth(0).boundingBox();
  const bottomBefore = await vBranches.nth(1).boundingBox();
  if (topBefore === null || bottomBefore === null) throw new Error('Missing vertical branches');

  const vCenter = await boxCenter(vDivider);
  await dragBetween(page, vCenter, { x: vCenter.x, y: vCenter.y + 55 });

  const topAfter = await vBranches.nth(0).boundingBox();
  const bottomAfter = await vBranches.nth(1).boundingBox();
  if (topAfter === null || bottomAfter === null) throw new Error('Missing resized vertical');
  expect(topAfter.height).toBeGreaterThan(topBefore.height + 25);
  expect(bottomAfter.height).toBeLessThan(bottomBefore.height - 25);

  await spence.shot('workspace-split-panes', { mask: [page.getByTestId('project-path')] });
});

test('stacks Panels, enforces at-least-one expanded invariant, and resizes stack dividers with pointer drag', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Upper stack panel', 'Upper stack panel');

  await page.getByTestId('session-actions-trigger').click();
  await page.getByTestId('panel-add-to-stack').click();

  const pane = page.getByTestId('pane-view');
  await expect(pane).toHaveAttribute('data-stacked', 'true');
  const frames = pane.getByTestId('panel-frame');
  await expect(frames).toHaveCount(2);
  await expect(pane.getByTestId('stack-resize-divider')).toHaveCount(1);

  // Collapse first Panel -> second (last expanded) Panel's collapse toggle disables.
  await frames.nth(0).getByTestId('panel-collapse-toggle').click();
  await expect(frames.nth(0)).toHaveAttribute('data-collapsed', 'true');
  await expect(frames.nth(0).getByTestId('panel-body')).toHaveCount(0);
  await expect(frames.nth(1).getByTestId('panel-collapse-toggle')).toBeDisabled();

  // Re-expand first Panel -> both expanded, stack divider returns.
  await frames.nth(0).getByTestId('panel-collapse-toggle').click();
  await expect(frames.nth(0)).toHaveAttribute('data-collapsed', 'false');
  await expect(frames.nth(1).getByTestId('panel-collapse-toggle')).toBeEnabled();

  // Drag stack-resize-divider vertically and assert bounding-box height change.
  const upperBefore = await frames.nth(0).boundingBox();
  const lowerBefore = await frames.nth(1).boundingBox();
  if (upperBefore === null || lowerBefore === null) throw new Error('Missing stacked frames');

  const dividerCenter = await boxCenter(pane.getByTestId('stack-resize-divider'));
  await dragBetween(page, dividerCenter, { x: dividerCenter.x, y: dividerCenter.y + 70 });

  const upperAfter = await frames.nth(0).boundingBox();
  const lowerAfter = await frames.nth(1).boundingBox();
  if (upperAfter === null || lowerAfter === null) throw new Error('Missing resized stack');
  expect(upperAfter.height).toBeGreaterThan(upperBefore.height + 30);
  expect(lowerAfter.height).toBeLessThan(lowerBefore.height - 30);

  await spence.shot('workspace-panel-stack', { mask: [page.getByTestId('project-path')] });
});

test('supports real pointer drag-and-drop for Tab strip reordering and Panel split/stack moves', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();

  // Create 3 named Tabs and drag Tab 1 onto Tab 3 to reorder.
  for (const label of ['echo:One', 'echo:Two', 'echo:Three']) {
    await page.getByTestId('new-tab').click();
    await createKeptSessionInCurrentTab(page, label, label.slice(5));
  }
  await expect(page.getByTestId('tab-title')).toHaveText(['echo:One', 'echo:Two', 'echo:Three']);

  const firstTabCenter = await boxCenter(page.getByTestId('tab-item').nth(0));
  const lastTabCenter = await boxCenter(page.getByTestId('tab-item').nth(2));
  await dragBetween(page, firstTabCenter, lastTabCenter);
  await expect(page.getByTestId('tab-title')).toHaveText(['echo:Two', 'echo:Three', 'echo:One']);

  // Split the active Tab right -> 2 horizontal Panes.
  await page.getByTestId('panel-split-trigger').click();
  await page.getByTestId('panel-split-right').click();
  await expect(page.getByTestId('pane-view')).toHaveCount(2);
  await expect(page.locator('[data-testid="pane-split"][data-direction="horizontal"]')).toHaveCount(
    1,
  );

  // Drag Pane 2's Panel header onto Pane 1's bottom edge -> converts to vertical split (source collapses).
  const pane0Box = await page.getByTestId('pane-view').nth(0).boundingBox();
  if (pane0Box === null) throw new Error('Missing target pane');
  const pane1HeaderTitle = page.getByTestId('pane-view').nth(1).getByTestId('panel-title');
  await dragBetween(
    page,
    await boxCenter(pane1HeaderTitle),
    { x: pane0Box.x + pane0Box.width * 0.5, y: pane0Box.y + pane0Box.height * 0.88 },
    async () => {
      await expect(
        page.locator('[data-testid="pane-drop-zone"][data-drop-zone="bottom"]'),
      ).toBeVisible();
    },
  );
  await expect(page.getByTestId('pane-view')).toHaveCount(2);
  await expect(page.locator('[data-testid="pane-split"][data-direction="vertical"]')).toHaveCount(
    1,
  );

  // Drag Pane 2's Panel header onto Pane 1's center -> merges into a single stacked Pane.
  const topPaneBox = await page.getByTestId('pane-view').nth(0).boundingBox();
  if (topPaneBox === null) throw new Error('Missing top pane');
  const bottomHeaderTitle = page.getByTestId('pane-view').nth(1).getByTestId('panel-title');
  await dragBetween(
    page,
    await boxCenter(bottomHeaderTitle),
    { x: topPaneBox.x + topPaneBox.width * 0.5, y: topPaneBox.y + topPaneBox.height * 0.5 },
    async () => {
      await expect(
        page.locator('[data-testid="pane-drop-zone"][data-drop-zone="center"]'),
      ).toBeVisible();
    },
  );
  await expect(page.getByTestId('pane-view')).toHaveCount(1);
  await expect(page.getByTestId('pane-view')).toHaveAttribute('data-stacked', 'true');
  await expect(page.getByTestId('panel-frame')).toHaveCount(2);
});

test('opens Session-pinned Changes and Workers Panels, re-binds via picker, and opens Worker row', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  writeFileSync(path.join(repo, 'readme.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Init');
  writeFileSync(path.join(repo, 'readme.txt'), 'one\ntwo\n');

  await page.getByTestId('add-project').click();

  // Session A in Tab 1.
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Session A', 'Session A');

  // Session B in Tab 2 delegating a busy Worker.
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Session B', 'Session B');
  const composerB = page.getByTestId('composer-input');
  await composerB.fill('delegate:busy');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composerB.press('Enter');
  await expect(page.getByTestId('open-workers-count')).toHaveText('1');

  // Open Workers Panel from PanelHeader and open Worker row in a split Pane.
  await page.getByTestId('open-workers').click();
  const workersPanel = page.locator('[data-testid="panel-frame"][data-panel-kind="Workers"]');
  await expect(workersPanel).toBeVisible();
  await expect(workersPanel.getByTestId('panel-bound-session')).toHaveText('echo:Session B');
  await workersPanel.getByTestId('worker-row').click();

  const workerPanel = page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .filter({ has: page.getByTestId('worker-parent') });
  await expect(workerPanel).toBeVisible();
  await workerPanel.getByTestId('stop').click();
  await expect(workerPanel.getByTestId('stop')).toBeHidden();

  // Switch to Tab 1 (Session A): open Changes Panel pinned to Session A, re-bind to Session B,
  // then open a second Changes Panel pinned to Session A.
  await page.getByTestId('tab-item').first().click();
  await page.getByTestId('open-changes').click();
  const changesPanels = page.locator('[data-testid="panel-frame"][data-panel-kind="Changes"]');
  await expect(changesPanels).toHaveCount(1);
  await expect(changesPanels.first().getByTestId('panel-bound-session')).toHaveText(
    'echo:Session A',
  );

  await changesPanels.first().getByTestId('panel-session-picker-trigger').click();
  await page.getByTestId('panel-session-option').filter({ hasText: 'echo:Session B' }).click();
  await expect(changesPanels.first().getByTestId('panel-bound-session')).toHaveText(
    'echo:Session B',
  );

  await page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .getByTestId('open-changes')
    .click();
  await expect(changesPanels).toHaveCount(2);
});

test('restores per-Project Tabs, custom title, split ratio, collapsed stack state, and pinned Panels across restart while dropping drafts', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Start');
  writeFileSync(path.join(repo, 'app.txt'), 'v2\n');

  await page.getByTestId('add-project').click();

  // Tab 1 in demo-project: kept Session, custom Tab title, pinned Changes + collapsed Workers stacked in right Pane.
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Primary Session', 'Primary Session');
  await page.getByTestId('tab-item').first().dblclick();
  await page.getByTestId('tab-rename-input').fill('Pinned Layout');
  await page.getByTestId('tab-rename-input').press('Enter');
  await expect(page.getByTestId('tab-title').first()).toHaveText('Pinned Layout');

  await page.getByTestId('open-changes').click();
  await expect(
    page.locator('[data-testid="panel-frame"][data-panel-kind="Changes"]'),
  ).toBeVisible();

  await page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .getByTestId('open-workers')
    .click();
  await expect(
    page.locator('[data-testid="panel-frame"][data-panel-kind="Workers"]'),
  ).toBeVisible();

  // Stack Workers onto Changes Pane by dragging Workers header onto Changes center.
  const changesPane = page.getByTestId('pane-view').filter({
    has: page.locator('[data-panel-kind="Changes"]'),
  });
  const changesPaneBox = await changesPane.boundingBox();
  if (changesPaneBox === null) throw new Error('Missing Changes pane');
  const workersTitle = page
    .locator('[data-testid="panel-frame"][data-panel-kind="Workers"]')
    .getByTestId('panel-title');
  await dragBetween(page, await boxCenter(workersTitle), {
    x: changesPaneBox.x + changesPaneBox.width * 0.5,
    y: changesPaneBox.y + changesPaneBox.height * 0.5,
  });
  await expect(page.getByTestId('pane-view')).toHaveCount(2);
  await expect(page.getByTestId('pane-view').nth(1)).toHaveAttribute('data-stacked', 'true');

  // Collapse Workers Panel in the stack.
  const workersPanel = page.locator('[data-testid="panel-frame"][data-panel-kind="Workers"]');
  await workersPanel.getByTestId('panel-collapse-toggle').click();
  await expect(workersPanel).toHaveAttribute('data-collapsed', 'true');

  // Resize the horizontal split divider so ratio is clearly non-default (~0.35 / 0.65).
  const hDivider = page.locator('[data-testid="pane-resize-divider"][data-direction="horizontal"]');
  const hCenter = await boxCenter(hDivider);
  await dragBetween(page, hCenter, { x: hCenter.x - 100, y: hCenter.y });

  const preSplitBox = await page.getByTestId('pane-split').first().boundingBox();
  const preFirstPaneBox = await page.getByTestId('pane-view').nth(0).boundingBox();
  if (preSplitBox === null || preFirstPaneBox === null) throw new Error('Missing split boxes');
  const preLeftRatio = preFirstPaneBox.width / preSplitBox.width;
  expect(preLeftRatio).toBeLessThan(0.45);

  // Tab 2 in demo-project: unsent draft (must be dropped on restart).
  await page.getByTestId('new-tab').click();
  await page.getByTestId('composer-input').fill('unsent draft before restart');
  await expect(page.getByTestId('tab-item')).toHaveCount(2);

  // Project 2: kept Session Tab.
  await spence.pickNext('second-project');
  await page.getByTestId('current-project').click();
  await page
    .getByRole('menuitem', { name: spence.t({ en: 'Add Project', es: 'Añadir Proyecto' }) })
    .click();
  await expect(page.getByTestId('current-project')).toContainText('second-project');
  await page.getByTestId('empty-new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Project B Tab', 'Project B Tab');

  // Switch back to demo-project and focus Tab 1 before restart.
  await page.getByTestId('current-project').click();
  await page.getByTestId('project-option').filter({ hasText: 'demo-project' }).click();
  await page.getByTestId('tab-item').first().click();
  await expect(page.getByTestId('tab-title').first()).toHaveText('Pinned Layout');
  // Let the Tabs.update IPC flush to Store before closing the app.
  await page.waitForTimeout(200);

  const executablePath = await spence.app.evaluate(() => process.execPath);
  await spence.app.close();
  const restarted = await electron.launch({
    executablePath,
    args: [process.cwd(), ...sandboxArgs],
    colorScheme: null,
    env: {
      ...process.env,
      SPENCE_E2E: '1',
      SPENCE_USER_DATA: spence.userData,
      SPENCE_LOCALE: spence.locale,
      SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
      SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
    },
  });
  const restartedPage = await restarted.firstWindow();
  await restartedPage.waitForLoadState('domcontentloaded');

  // Active Project, kept Tab, custom title, and dropped draft.
  await expect(restartedPage.getByTestId('current-project')).toContainText('demo-project');
  await expect(restartedPage.getByTestId('tab-item')).toHaveCount(1);
  await expect(restartedPage.getByTestId('tab-title')).toHaveText('Pinned Layout');

  // Split Panes, ratio, stacked Panels, collapsed state, and pinned Changes/Workers restored.
  await expect(restartedPage.getByTestId('pane-view')).toHaveCount(2);
  await expect(restartedPage.getByTestId('pane-view').nth(1)).toHaveAttribute(
    'data-stacked',
    'true',
  );
  const restoredChanges = restartedPage.locator(
    '[data-testid="panel-frame"][data-panel-kind="Changes"]',
  );
  const restoredWorkers = restartedPage.locator(
    '[data-testid="panel-frame"][data-panel-kind="Workers"]',
  );
  await expect(restoredChanges).toHaveAttribute('data-collapsed', 'false');
  await expect(restoredChanges.getByTestId('panel-bound-session')).toHaveText(
    'echo:Primary Session',
  );
  await expect(restoredChanges.getByTestId('change-row')).toHaveCount(1);
  await expect(restoredChanges.getByTestId('change-row')).toContainText('app.txt');
  await expect(restoredWorkers).toHaveAttribute('data-collapsed', 'true');
  await expect(restoredWorkers.getByTestId('panel-bound-session')).toHaveText(
    'echo:Primary Session',
  );

  const postSplitBox = await restartedPage.getByTestId('pane-split').first().boundingBox();
  const postFirstPaneBox = await restartedPage.getByTestId('pane-view').nth(0).boundingBox();
  if (postSplitBox === null || postFirstPaneBox === null) throw new Error('Missing post split');
  const postLeftRatio = postFirstPaneBox.width / postSplitBox.width;
  expect(Math.abs(postLeftRatio - preLeftRatio)).toBeLessThan(0.03);

  await expect(restartedPage).toHaveScreenshot(spence.shotFile('workspace-restored'), {
    mask: [restartedPage.getByTestId('project-path')],
  });

  // Project B's Tab also restored across restart.
  await restartedPage.getByTestId('current-project').click();
  await restartedPage.getByTestId('project-option').filter({ hasText: 'second-project' }).click();
  await expect(restartedPage.getByTestId('tab-item')).toHaveCount(1);
  await expect(restartedPage.getByTestId('tab-title')).toHaveText('echo:Project B Tab');

  await restarted.close();
});
