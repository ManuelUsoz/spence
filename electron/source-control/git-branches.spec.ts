import { afterEach, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { listBranches } from './git-branches';

// Each test runs real git commands; the 5 s default is too tight while the whole suite runs.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

const makeRepo = async (): Promise<{ parent: string; dir: string }> => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-branches-')));
  tempDirs.push(parent);
  const dir = path.join(parent, 'app');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'a.txt'), 'a\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return { parent, dir };
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

describe('listBranches', () => {
  it('lists local branches, marks the current one, and says where another is checked out', async () => {
    const { parent, dir } = await makeRepo();
    await git(dir, 'branch', 'feature/a');
    const linked = path.join(parent, 'linked');
    await git(dir, 'worktree', 'add', '-b', 'feature/b', linked);

    const result = await listBranches(dir, 'git', pathEnv);

    expect(result._tag).toBe('Available');
    if (result._tag !== 'Available') return;
    expect(result.branches.map((b) => [b.name, b.current, b.checkedOutAt !== undefined])).toEqual([
      ['feature/a', false, false],
      ['feature/b', false, true],
      ['main', true, false],
    ]);
  });

  it('reports a folder that is not a repository as NonGit', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-nongit-')));
    tempDirs.push(dir);

    expect((await listBranches(dir, 'git', pathEnv))._tag).toBe('NonGit');
  });
});
