import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Spence } from '../fixtures';

test.use({ spencePauseWorktreeCreate: true });

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const journal = (spence: Spence): { snapshot: { phase: string; outcome?: string } } | null => {
  const root = path.join(spence.userData, 'spence', 'operations');
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root);
  if (dirs.length !== 1 || dirs[0] === undefined) return null;
  const file = path.join(root, dirs[0], 'journal.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
};

const startCreation = async (spence: Spence, branch: string) => {
  const repo = await spence.pickNext(`repo-${branch}`);
  const destination = path.join(path.dirname(repo), `created-${branch}`);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@spence.dev');
  git(repo, 'config', 'user.name', 'Spence');
  writeFileSync(path.join(repo, 'README.md'), 'committed\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'initial');
  const page = spence.page;
  await page.getByTestId('add-project').click();
  await page.getByTestId('new-session').click();
  await page.getByTestId('worktree-pill').click();
  await page.getByTestId('worktree-create').click();
  await page.getByTestId('worktree-create-branch').fill(branch);
  await page.getByTestId('worktree-create-destination').fill(destination);
  await page.getByTestId('worktree-create-submit').click();
  const marker = path.join(spence.userData, 'worktree-paused.json');
  await expect.poll(() => existsSync(marker), { timeout: 20_000 }).toBe(true);
  expect(journal(spence)?.snapshot.phase).toBe('Applying');
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(`refs/heads/${branch}`);
  const markerData: { pid: number } = JSON.parse(readFileSync(marker, 'utf8'));
  return { repo, destination, workerPid: markerData.pid };
};

test('reconciles a worker death after creation without replaying Git', async ({ spence }) => {
  const { repo, destination, workerPid } = await startCreation(spence, 'worker-death');
  process.kill(workerPid);
  await expect.poll(() => journal(spence)?.snapshot.outcome, { timeout: 20_000 }).toBe('Unknown');
  const dialog = spence.page.getByTestId('worktree-dialog');
  await expect(dialog.getByTestId('worktree-operation-recovery')).toBeVisible();
  await dialog.getByTestId('worktree-op-reconcile').click();
  await expect.poll(() => journal(spence)?.snapshot.outcome, { timeout: 20_000 }).toBe('Succeeded');
  expect(readFileSync(path.join(spence.userData, 'worktree-requests.txt'), 'utf8')).toBe(
    'create\n',
  );
  expect(
    git(repo, 'worktree', 'list', '--porcelain').match(/refs\/heads\/worker-death/g),
  ).toHaveLength(1);
  expect(git(destination, 'status', '--porcelain')).toBe('');
});

test('reconciles an interrupted creation at app restart without replaying Git', async ({
  spence,
}) => {
  const { repo, destination, workerPid } = await startCreation(spence, 'restart');
  const executablePath = await spence.app.evaluate(() => process.execPath);
  const mainPid = await spence.app.evaluate(() => process.pid);
  const exited = once(spence.app.process(), 'exit');
  process.kill(mainPid);
  await exited;
  try {
    process.kill(workerPid);
  } catch {
    // The utility process may already have exited with its parent.
  }
  const restarted = await electron.launch({
    executablePath,
    args: process.env['SPENCE_E2E_EXECUTABLE'] === undefined ? [process.cwd()] : [],
    env: {
      ...process.env,
      SPENCE_E2E: '1',
      SPENCE_USER_DATA: spence.userData,
      SPENCE_LOCALE: spence.locale,
      SPENCE_E2E_PICK_FOLDER: spence.pickFolder,
      SPENCE_E2E_AGENT_BIN: path.join(spence.userData, 'bin'),
      SPENCE_E2E_WORKTREE_TRACE: path.join(spence.userData, 'worktree-requests.txt'),
    },
  });
  try {
    await restarted.firstWindow();
    await expect
      .poll(() => journal(spence)?.snapshot.outcome, { timeout: 20_000 })
      .toBe('Succeeded');
    expect(readFileSync(path.join(spence.userData, 'worktree-requests.txt'), 'utf8')).toBe(
      'create\n',
    );
    expect(
      git(repo, 'worktree', 'list', '--porcelain').match(/refs\/heads\/restart/g),
    ).toHaveLength(1);
    expect(git(destination, 'status', '--porcelain')).toBe('');
  } finally {
    await restarted.close();
  }
});
