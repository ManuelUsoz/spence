import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

test('inspects external changes and browses Git history in a draft Session', async ({ spence }) => {
  const repo = await spence.pickNext('changes-repo');
  git(repo, ['init', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@spence.dev']);
  git(repo, ['config', 'user.name', 'Spence']);
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\n');
  git(repo, ['add', 'tracked.txt']);
  git(repo, ['commit', '-m', 'Initial commit']);
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\nstaged\n');
  git(repo, ['add', 'tracked.txt']);
  writeFileSync(path.join(repo, 'tracked.txt'), 'base\nstaged\nexternal edit\n');
  writeFileSync(path.join(repo, 'new.txt'), 'untracked content\n');

  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('worktree-pill')).toContainText('main');
  const toggle = page.getByTestId('inspector-toggle');
  await toggle.click();
  const panel = page.getByTestId('inspector-panel');
  const tracked = panel.locator('[data-testid="change-row"][data-path="tracked.txt"]');
  await expect(tracked).toBeVisible();
  await expect(panel.locator('[data-testid="change-row"][data-path="new.txt"]')).toBeVisible();
  await tracked.getByTestId('change-row-toggle').click();
  await expect(tracked).toContainText('external edit');
  await tracked.getByTestId('diff-scope-staged').click();
  await expect(tracked).toContainText('staged');
  await expect(tracked).not.toContainText('external edit');

  await panel.getByTestId('inspector-menu-trigger').click();
  await page.getByTestId('inspector-menu-history').click();
  const commit = panel.getByTestId('commit-row').filter({ hasText: 'Initial commit' });
  await expect(commit).toBeVisible();
  await commit.click();
  const detail = panel.getByTestId('commit-detail-panel');
  await expect(detail).toContainText('tracked.txt');
  await detail.getByTestId('commit-file-row').click();
  await expect(detail).toContainText('base');
  await panel.getByTestId('inspector-back-to-changes').click();

  git(repo, ['switch', '-c', 'external-branch']);
  await panel.getByTestId('changes-refresh').click();
  await expect(panel).toContainText('external-branch');
  await page.getByTestId('inspector-close').click();
  await expect(toggle).toBeFocused();
});
