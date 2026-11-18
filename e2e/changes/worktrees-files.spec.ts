import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('a draft Session moves into a new Worktree, browses its files, and keeps that Worktree once it has messages', async ({
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
  await page.getByTestId('open-changes').click();

  const bar = page.getByTestId('worktree-bar');
  await expect(bar).toContainText('main');
  await page.getByTestId('worktree-new').click();
  await page.getByTestId('worktree-branch').fill('feature/e2e');
  await page.getByTestId('worktree-create').click();
  await expect(page.getByTestId('worktree-select-trigger')).toContainText('feature/e2e');

  await page.getByTestId('files-tab-button').click();
  await expect(page.getByTestId('file-row')).toHaveCount(2);
  await page.getByTestId('file-row').filter({ hasText: 'README.md' }).click();
  await expect(page.getByTestId('file-content')).toContainText('# Demo');
  await page.getByTestId('file-row').filter({ hasText: 'src' }).click();
  await expect(page.getByTestId('file-row').filter({ hasText: 'index.ts' })).toBeVisible();
  await spence.shot('changes-files', { mask: [page.getByTestId('project-path')] });

  // After its first message the Session keeps its Worktree: it is shown, not offered.
  await page.getByTestId('changes-back').click();
  await page.getByTestId('composer-input').fill('echo:Hello');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello');
  await expect(page.getByTestId('stop')).toBeHidden();
  await page.getByTestId('open-changes').click();
  await expect(page.getByTestId('worktree-current')).toContainText('feature/e2e');
  await expect(page.getByTestId('worktree-select')).toHaveCount(0);
  await expect(page.getByTestId('worktree-new')).toHaveCount(0);
});
