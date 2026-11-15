import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, args: ReadonlyArray<string>): void => {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
};

test('discovers Git Worktrees via Electron utility worker and refreshes on demand', async ({
  spence,
}) => {
  const repoDir = await spence.pickNext('wt-repo');
  const linkedDir = path.join(path.dirname(repoDir), 'wt-linked');
  const addedDir = path.join(path.dirname(repoDir), 'wt-added');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@spence.dev']);
  git(repoDir, ['config', 'user.name', 'Spence']);
  writeFileSync(path.join(repoDir, 'README.md'), 'worktree e2e\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'initial']);
  git(repoDir, ['worktree', 'add', '-b', 'feature/wt-e2e', linkedDir]);

  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('wt-repo');

  await page.getByTestId('new-session').click();
  const pill = page.getByTestId('worktree-pill');
  await expect(pill).toHaveText('main');

  await pill.click();
  const dialog = page.getByTestId('worktree-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    spence.t({ en: 'Session Worktree', es: 'Worktree de la Sesión' }),
  );
  const entries = dialog.getByTestId('worktree-entry');
  await expect(entries).toHaveCount(2);
  await expect(dialog).toContainText('feature/wt-e2e');

  // Create another linked Worktree on disk and verify explicit Refresh re-queries the worker.
  git(repoDir, ['worktree', 'add', '-b', 'feature/added-after', addedDir]);
  await dialog.getByTestId('worktree-refresh').click();
  await expect(entries).toHaveCount(3);
  await expect(dialog).toContainText('feature/added-after');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(pill).toBeFocused();
});
