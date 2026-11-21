import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

test('discards changes after showing the affected files, then reverts a commit from the history', async ({
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
  writeFileSync(path.join(repo, 'extra.txt'), 'extra\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Add extra');
  writeFileSync(path.join(repo, 'a.txt'), 'a\nunwanted\n');
  writeFileSync(path.join(repo, 'scratch.txt'), 'scratch\n');

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  // Wait for the Agent to be ready, or the message is not sent.
  await expect(page.getByTestId('model-picker')).toBeVisible();
  await page.getByTestId('composer-input').fill('echo:Hello');
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('composer-input').press('Enter');
  // The Turn has to be over for the Session to be kept: a draft may still move to another Worktree.
  await expect(page.getByTestId('message-agent')).toBeVisible();
  await expect(page.getByTestId('stop')).toBeHidden();
  // The line under the composer shows the branch and the number of changed files, and opens Changes.
  await expect(page.getByTestId('composer-status-branch')).toContainText('main');
  await expect(page.getByTestId('composer-status-added')).toHaveText('+2');
  await expect(page.getByTestId('composer-status-removed')).toHaveText('−0');
  await spence.shot('composer-status', { mask: [page.getByTestId('project-path')] });
  await page.getByTestId('composer-status-changes').click();
  await expect(page.getByTestId('worktree-current')).toBeVisible();
  await expect(page.getByTestId('worktree-new')).toHaveCount(0);
  await expect(page.getByTestId('change-row')).toHaveCount(2);

  // Nothing is discarded until the shown list is confirmed.
  await page.getByTestId('change-more').click();
  await page.getByTestId('discard-all-button').click();
  await expect(page.getByTestId('discard-file')).toHaveCount(2);
  await expect(page.getByTestId('discard-heading')).toContainText('2');
  expect(readFileSync(path.join(repo, 'a.txt'), 'utf8')).toContain('unwanted');
  await spence.shot('changes-discard', { mask: [page.getByTestId('project-path')] });

  await page.getByTestId('discard-confirm-button').click();
  await expect(page.getByTestId('discard-outcome')).toContainText('30');
  await expect(page.getByTestId('changes-empty')).toBeVisible();
  expect(readFileSync(path.join(repo, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('a\n');
  expect(existsSync(path.join(repo, 'scratch.txt'))).toBe(false);

  await page.getByTestId('history-tab').click();
  await expect(page.getByTestId('commit-row')).toHaveCount(2);
  await page.getByTestId('commit-row').first().click();
  // Revert sits in the header of the selected commit.
  await page.getByTestId('revert-button').click();
  await page.getByTestId('revert-confirm-button').click();
  await expect(page.getByTestId('revert-outcome').first()).toContainText(
    spence.t({ en: 'New commit', es: 'Nuevo commit' }),
  );
  const back = page.getByTestId('changes-viewer-back');
  if (await back.isVisible()) await back.click();
  await expect(page.getByTestId('commit-row')).toHaveCount(3);
  await expect(page.getByTestId('commit-row').first()).toContainText('Revert');
  expect(existsSync(path.join(repo, 'extra.txt'))).toBe(false);
});
