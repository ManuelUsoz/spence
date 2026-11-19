import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('a Session started in a new worktree shows that worktree in Changes and lets you browse its files', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  mkdirSync(path.join(repo, 'src'));
  writeFileSync(path.join(repo, 'README.md'), '# Demo\n');
  writeFileSync(path.join(repo, 'src', 'index.ts'), 'export const demo = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Initial files');

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();

  // Start the Session in a new worktree; it is created when the first message is sent.
  await page.getByTestId('composer-status-branch').click();
  await page.getByTestId('mode-new').click();
  await page.getByTestId('composer-status-worktree-name').fill('feature/e2e');
  await page.getByTestId('composer-input').fill('echo:Hello');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello');
  await expect(page.getByTestId('stop')).toBeHidden();

  await page.getByTestId('composer-status-changes').click();
  await expect(page.getByTestId('worktree-current')).toContainText('feature/e2e');

  await page.getByTestId('files-tab-button').click();
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await page.getByTestId('file-row').filter({ hasText: 'README.md' }).click();
  await expect(page.getByTestId('file-content').locator('h1')).toHaveText('Demo');
  await spence.shot('changes-files-markdown-rendered', {
    mask: [page.getByTestId('project-path')],
  });
  await page.getByTestId('markdown-source').click();
  await expect(page.getByTestId('file-content')).toContainText('# Demo');
  await spence.shot('changes-files-markdown-source', { mask: [page.getByTestId('project-path')] });
  await page.getByTestId('file-row').filter({ hasText: 'src' }).click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'index.ts' })).toBeVisible();
  const separator = page.getByRole('separator', { name: /Resize file tree|Cambiar el ancho/ });
  await separator.focus();
  await separator.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '298');
  const dividerBox = await separator.boundingBox();
  if (dividerBox === null) throw new Error('File divider has no layout');
  await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 40, dividerBox.y + 20);
  await page.mouse.up();
  await expect(separator).toHaveAttribute('aria-valuenow', '338');
  const contentBox = await page.getByTestId('file-content').boundingBox();
  const panelBox = await page.getByTestId('changes-page').boundingBox();
  expect(contentBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  if (contentBox === null || panelBox === null) throw new Error('Files panel has no layout');
  expect(contentBox.height).toBeGreaterThan(400);
  expect(contentBox.width).toBeGreaterThan(400);
  await spence.shot('changes-files', { mask: [page.getByTestId('project-path')] });
  await page.getByTestId('file-row').filter({ hasText: 'index.ts' }).click();
  await expect(page.locator('.file-token').first()).toBeVisible();
  await spence.shot('changes-files-highlighted', { mask: [page.getByTestId('project-path')] });
});
