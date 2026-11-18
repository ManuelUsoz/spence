import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

test('commits the ticked files and pushes them, leaving the unticked change in the list', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  const origin = path.join(mkdtempSync(path.join(tmpdir(), 'spence-e2e-origin-')), 'origin.git');
  git(path.dirname(origin), 'init', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  writeFileSync(path.join(repo, 'a.txt'), 'a\nmore\n');
  writeFileSync(path.join(repo, 'b.txt'), 'b\nmore\n');

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('hello');
  await page.getByTestId('composer-input').press('Enter');
  await page.getByTestId('open-changes').click();

  // Once the message is sent the Session keeps its Worktree: wait for that so the screenshot is stable.
  await expect(page.getByTestId('worktree-new')).toHaveCount(0);
  const rows = page.getByTestId('change-row');
  await expect(rows).toHaveCount(2);
  // Untick b.txt, so only a.txt goes into the commit.
  await rows.filter({ hasText: 'b.txt' }).getByTestId('change-check').uncheck();
  await expect(page.getByTestId('commit-count')).toContainText('1 / 2');
  await expect(page.getByTestId('commit-button')).toBeDisabled();
  await page.getByTestId('commit-message').fill('Extend a');
  await spence.shot('changes-commit', { mask: [page.getByTestId('project-path')] });

  await page.getByTestId('commit-push-button').click();
  await expect(page.getByTestId('commit-outcome')).toContainText(
    spence.t({ en: 'and pushed', es: 'hizo push' }),
  );
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('b.txt');

  await page.getByTestId('history-tab').click();
  await expect(page.getByTestId('commit-row').first()).toContainText('Extend a');
  expect(git(origin, 'log', '--format=%s', 'main').trim().split('\n')).toEqual([
    'Extend a',
    'Start',
  ]);
});
