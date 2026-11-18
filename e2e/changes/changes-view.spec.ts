import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '../fixtures';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' });

test('Changes view lists edits made outside the Agent, opens a diff, and shows the history', async ({
  spence,
}) => {
  const page = spence.page;
  const repo = spence.pickFolder;
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'e2e@spence.local');
  git(repo, 'config', 'user.name', 'Spence E2E');
  writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Add notes');
  writeFileSync(path.join(repo, 'notes.txt'), 'one\nTWO\nthree\n');
  writeFileSync(path.join(repo, 'fresh.txt'), 'hello\n');

  await page.getByTestId('add-project').click();
  await expect(page.getByTestId('current-project')).toContainText('demo-project');
  await page.getByTestId('new-session').click();
  await page.getByTestId('composer-input').fill('hello');
  await page.getByTestId('composer-input').press('Enter');

  await page.getByTestId('open-changes').click();
  await expect(page.getByTestId('topbar-title')).toHaveText(
    spence.t({ en: 'Changes', es: 'Cambios' }),
  );
  const rows = page.getByTestId('change-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('fresh.txt');
  await expect(rows.nth(1)).toContainText('notes.txt');

  await rows.nth(1).getByRole('button').click();
  await expect(page.getByTestId('diff-line')).toHaveCount(4);
  await spence.shot('changes-diff', { mask: [page.getByTestId('project-path')] });

  await page.getByTestId('history-tab').click();
  await expect(page.getByTestId('commit-row')).toHaveCount(1);
  await expect(page.getByTestId('commit-row')).toContainText('Add notes');

  // The breadcrumb leads back to the Session's thread.
  await page.getByTestId('changes-back').click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});
