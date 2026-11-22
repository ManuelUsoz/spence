import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron as electron, type Locator, type Page } from '@playwright/test';
import { expect, sandboxArgs, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

const wallpaperData =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
const customWallpapers = ['One', 'Two', 'Three'].map((name) => ({
  id: `custom-${name.toLowerCase()}`,
  name,
  mimeType: 'image/png',
  data: wallpaperData,
}));
const testWithWallpapers = test.extend({
  spenceSettings: { theme: 'dark', customWallpapers },
});

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

test('opens Windows-style Ctrl+Tab MRU switcher and respects Chat background mode settings', async ({
  spence,
}) => {
  const page = spence.page;

  await page.getByTestId('add-project').click();
  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:First Tab', 'First Tab');
  await expect(page.getByTestId('session-wallpaper')).toHaveCount(0);

  await page.getByTestId('new-tab').click();
  await createKeptSessionInCurrentTab(page, 'echo:Second Tab', 'Second Tab');

  // Hold Control + tap Tab to open MRU switcher with preview cards; releasing Control commits selection.
  await page.keyboard.down('Control');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('tab-switcher')).toBeVisible();
  await expect(page.getByTestId('tab-switcher-card')).toHaveCount(2);
  await page.keyboard.up('Control');
  await expect(page.getByTestId('tab-switcher')).toBeHidden();
  await expect(page.getByTestId('tab-item').first()).toHaveAttribute('aria-selected', 'true');

  // A fresh gallery has no wallpaper. Importing images makes them available to open Sessions.
  await page.getByTestId('open-settings').click();
  await page.getByTestId('chat-bg-different').click();
  await expect(page.getByTestId('chat-bg-gallery')).toBeVisible();
  await expect(page.getByTestId('chat-bg-item')).toHaveCount(0);
  await page.getByTestId('chat-bg-file-input').setInputFiles({
    name: 'custom.png',
    mimeType: 'image/png',
    buffer: Buffer.from(wallpaperData, 'base64'),
  });
  await expect(page.getByTestId('chat-bg-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-wallpaper')).toBeVisible();

  await page.getByTestId('open-settings').click();
  await page.getByTestId('chat-bg-item').hover();
  await page.getByTestId('chat-bg-remove').click();
  await expect(page.getByTestId('chat-bg-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('session-wallpaper')).toHaveCount(0);
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

  // Drag Pane 2's Panel header onto Pane 1's center -> swaps the two Panes cleanly.
  const firstPanelId = await page
    .getByTestId('pane-view')
    .nth(0)
    .getByTestId('panel-frame')
    .getAttribute('data-panel-id');
  const secondPanelId = await page
    .getByTestId('pane-view')
    .nth(1)
    .getByTestId('panel-frame')
    .getAttribute('data-panel-id');
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
  await expect(page.getByTestId('pane-view')).toHaveCount(2);
  await expect(page.getByTestId('pane-view').nth(0).getByTestId('panel-frame')).toHaveAttribute(
    'data-panel-id',
    secondPanelId!,
  );
  await expect(page.getByTestId('pane-view').nth(1).getByTestId('panel-frame')).toHaveAttribute(
    'data-panel-id',
    firstPanelId!,
  );
});

test('opens full-Tab Changes and Workers overlays, re-binds via picker, and opens the Worker in its parent Pane', async ({
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

  // Open Workers overlay from PanelHeader and open the Worker in the parent Pane.
  await page.getByTestId('open-workers').click();
  await expect(page.getByTestId('tab-overlay-header')).toBeVisible();
  await expect(page.getByTestId('workers-panel')).toBeVisible();
  await expect(page.getByTestId('panel-bound-session')).toContainText('echo:Session B');
  await page.getByTestId('workers-panel').getByTestId('worker-row').click();
  await expect(page.getByTestId('tab-overlay-header')).toBeHidden();
  await expect(page.getByTestId('pane-view')).toHaveCount(1);

  const workerPanel = page
    .locator('[data-testid="panel-frame"][data-panel-kind="Session"]')
    .filter({ has: page.getByTestId('worker-parent') });
  await expect(workerPanel).toBeVisible();
  await workerPanel.getByTestId('stop').click();
  await expect(workerPanel.getByTestId('stop')).toBeHidden();

  // Switch to Tab 1 (Session A): open full-Tab Changes overlay, re-bind to Session B, then return via Back.
  await page.getByTestId('tab-item').first().click();
  await page.getByTestId('open-changes').click();
  await expect(page.getByTestId('tab-overlay-header')).toBeVisible();
  await expect(page.getByTestId('changes-page')).toBeVisible();
  await expect(page.getByTestId('panel-bound-session')).toContainText('echo:Session A');

  await page.getByTestId('panel-session-picker-trigger').click();
  await page.getByTestId('panel-session-option').filter({ hasText: 'echo:Session B' }).click();
  await expect(page.getByTestId('panel-bound-session')).toContainText('echo:Session B');

  await page.getByTestId('tab-overlay-back').click();
  await expect(page.getByTestId('tab-overlay-header')).toBeHidden();
  await expect(page.getByTestId('pane-view')).toHaveCount(1);
});

testWithWallpapers(
  'restores per-Project Tabs, custom title, split ratio, and sessionWallpapers across restart while dropping drafts',
  async ({ spence }) => {
    const page = spence.page;

    await page.getByTestId('add-project').click();

    // Tab 1 in demo-project: two split kept Sessions with custom Tab title.
    await page.getByTestId('new-tab').click();
    await createKeptSessionInCurrentTab(page, 'echo:Primary Session', 'Primary Session');
    await page.getByTestId('tab-item').first().dblclick();
    await page.getByTestId('tab-rename-input').fill('Pinned Layout');
    await page.getByTestId('tab-rename-input').press('Enter');
    await expect(page.getByTestId('tab-title').first()).toHaveText('Pinned Layout');

    await page.getByTestId('panel-split-trigger').click();
    await page.getByTestId('panel-split-right').click();
    await expect(page.getByTestId('pane-view')).toHaveCount(2);
    const rightComposer = page.getByTestId('pane-view').nth(1).getByTestId('composer-input');
    await expect(rightComposer).toBeVisible();
    await rightComposer.fill('echo:Secondary Session');
    await expect(page.getByTestId('pane-view').nth(1).getByTestId('send')).toBeEnabled();
    await rightComposer.press('Enter');
    await expect(
      page.getByTestId('pane-view').nth(1).getByTestId('message-agent').last(),
    ).toContainText('Secondary Session');

    // Resize the horizontal split divider so ratio is clearly non-default (< 0.45).
    const hDivider = page.locator(
      '[data-testid="pane-resize-divider"][data-direction="horizontal"]',
    );
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
    // Wait until Tabs.update flushes the expected workspace state to Store before closing the app.
    const statePath = path.join(spence.userData, 'spence', 'state.json');
    await expect
      .poll(() => {
        try {
          const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as {
            workspace?: {
              activeProjectId?: string;
              sessionWallpapers?: Record<string, string>;
              projects?: ReadonlyArray<{
                projectId: string;
                activeTabId?: string;
                tabs: ReadonlyArray<{
                  id: string;
                  customTitle?: string;
                  layout: {
                    nodes: ReadonlyArray<{
                      _tag: string;
                      ratio?: number;
                    }>;
                  };
                }>;
              }>;
            };
          };
          const ws = parsed.workspace;
          if (ws?.projects?.length !== 2) return false;
          const activeProj = ws.projects.find((p) => p.projectId === ws.activeProjectId);
          if (activeProj === undefined || activeProj.tabs.length !== 1) return false;
          const tab1 = activeProj.tabs[0];
          if (tab1 === undefined || tab1.customTitle !== 'Pinned Layout') return false;
          if (activeProj.activeTabId !== tab1.id) return false;
          const hasSplit = tab1.layout.nodes.some(
            (n) => n._tag === 'Split' && n.ratio !== undefined && n.ratio < 0.45,
          );
          const hasWallpapers = Object.keys(ws.sessionWallpapers ?? {}).length >= 3;
          return hasSplit && hasWallpapers;
        } catch {
          return false;
        }
      })
      .toBe(true);

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

    // Split Panes and ratio restored without stacks.
    await expect(restartedPage.getByTestId('pane-view')).toHaveCount(2);
    await expect(restartedPage.getByTestId('panel-title')).toHaveText([
      'echo:Primary Session',
      'echo:Secondary Session',
    ]);

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
  },
);
