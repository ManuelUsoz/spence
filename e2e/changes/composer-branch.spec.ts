import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

test('a new Session can start in a new worktree, from a chosen branch, created when the first message is sent', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Start');
  git(repo, 'checkout', '-b', 'develop');
  writeFileSync(path.join(repo, 'dev.txt'), 'dev\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Develop work');
  git(repo, 'checkout', 'main');

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('model-picker')).toBeVisible();

  // The current checkout is the default; its branch is named in the line under the composer.
  const chip = page.getByTestId('composer-status-branch');
  await expect(chip).toContainText('main');

  // Choose a new worktree: nothing is created yet.
  await chip.click();
  await page.getByTestId('mode-new').click();
  await expect(chip).toContainText(spence.t({ en: 'New worktree', es: 'Worktree nuevo' }));
  const from = page.getByTestId('composer-status-from').locator('input');
  await expect(from).toHaveValue('main');
  await from.fill('dev');
  await expect(page.getByTestId('composer-status-from-item')).toHaveCount(1);
  await spence.shot('composer-new-worktree', { mask: [page.getByTestId('project-path')] });
  await page.getByTestId('composer-status-from-item').click();
  await expect(from).toHaveValue('develop');
  await page.getByTestId('composer-status-worktree-name').fill('wt/e2e-side');
  expect(git(repo, 'worktree', 'list')).not.toContain('wt/e2e-side');

  // Sending the first message creates the worktree from develop and the Session works there.
  await page.getByTestId('composer-input').fill('echo:Hello');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Hello');
  await expect(page.getByTestId('stop')).toBeHidden();

  await expect(chip).toContainText('wt/e2e-side');
  await expect(page.getByTestId('composer-status-new-worktree')).toHaveCount(0);
  expect(git(repo, 'worktree', 'list')).toContain('wt/e2e-side');
  expect(git(repo, 'log', 'wt/e2e-side', '--format=%s')).toContain('Develop work');
  // The original checkout is untouched.
  expect(git(repo, 'branch', '--show-current').trim()).toBe('main');
});
