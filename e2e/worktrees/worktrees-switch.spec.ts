import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
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

test('switches Session Worktree via reviewed Summary handoff, displays changes, and requires confirmation to rebind', async ({
  spence,
}) => {
  const repoDir = await spence.pickNext('wt-switch-repo');
  const linkedDir = path.join(path.dirname(repoDir), 'wt-switch-linked');
  const otherDir = path.join(path.dirname(repoDir), 'wt-other-repo');

  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'test@spence.dev']);
  git(repoDir, ['config', 'user.name', 'Spence']);
  writeFileSync(path.join(repoDir, 'README.md'), 'worktree switch e2e\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-m', 'initial']);
  git(repoDir, ['worktree', 'add', '-b', 'feat/e2e-switch', linkedDir]);

  mkdirSync(otherDir, { recursive: true });
  git(otherDir, ['init', '-b', 'other-branch']);
  git(otherDir, ['config', 'user.email', 'test@spence.dev']);
  git(otherDir, ['config', 'user.name', 'Spence']);
  writeFileSync(path.join(otherDir, 'OTHER.md'), 'other repo\n');
  git(otherDir, ['add', 'OTHER.md']);
  git(otherDir, ['commit', '-m', 'other initial']);

  const page = spence.page;
  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('wt-switch-repo');
  await page.getByTestId('new-session').click();

  // Send one prompt so switching becomes a reviewed Summary handoff.
  const composer = page.getByTestId('composer-input');
  await composer.fill('echo:Work before switch');
  await expect(page.getByTestId('send')).toBeEnabled();
  await composer.press('Enter');
  await expect(page.getByTestId('message-agent')).toHaveText('Work before switch');

  // Edit a tracked file and refresh to see working-tree diff summary in pill & modal.
  writeFileSync(path.join(repoDir, 'README.md'), 'worktree switch e2e\nadded line\n');
  const pill = page.getByTestId('worktree-pill');
  await pill.click();
  const wtDialog = page.getByTestId('worktree-dialog');
  await expect(wtDialog).toBeVisible();
  await expect(pill.getByTestId('worktree-pill-changes')).toContainText('+1 −0');
  await expect(wtDialog.getByTestId('worktree-entry-sessions').first()).toContainText('1');

  // Trigger Worktree switch on the linked Worktree.
  await wtDialog.getByTestId('worktree-switch').click();
  const handoffDialog = page.getByTestId('handoff-dialog');
  await expect(handoffDialog).toBeVisible();
  await expect(handoffDialog.getByTestId('handoff-target-worktree')).toContainText(
    'feat/e2e-switch',
  );
  await expect(handoffDialog.getByTestId('handoff-summary-input')).not.toHaveValue('');
  await handoffDialog.getByTestId('handoff-confirm').click();
  await expect(handoffDialog).toBeHidden();

  await expect(page.getByTestId('handoff-boundary')).toBeVisible();
  await expect(pill).toContainText('feat/e2e-switch');

  // Locating a different Git repository requires explicit user confirmation before rebinding.
  await spence.app.evaluate((_electron, value) => {
    process.env['SPENCE_E2E_PICK_FOLDER'] = value;
  }, otherDir);
  await pill.click();
  await expect(wtDialog).toBeVisible();
  await wtDialog.getByTestId('worktree-locate').click();
  await expect(wtDialog.getByTestId('worktree-rebind-confirm')).toBeVisible();
  await wtDialog.getByTestId('worktree-rebind-confirm-btn').click();
  await expect(wtDialog.getByTestId('worktree-rebind-confirm')).toBeHidden();
  await expect(pill).toContainText('other-branch');
});
