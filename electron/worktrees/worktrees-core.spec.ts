import { afterEach, describe, expect, it } from '@effect/vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createWorktree, listWorktrees } from './worktrees-core';

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

/** A repository inside its own temp parent, so the sibling `<repo>.worktrees` folder is cleaned up too. */
const makeRepo = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-worktrees-')));
  tempDirs.push(parent);
  const dir = path.join(parent, 'app');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'tracked.txt'), 'one\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('listWorktrees', () => {
  it('lists the primary Worktree with its branch and marks the one the folder is in', async () => {
    const dir = await makeRepo();

    const result = await listWorktrees(dir, 'git', pathEnv);

    expect(result._tag).toBe('Available');
    if (result._tag !== 'Available') return;
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      branch: 'main',
      detached: false,
      isPrimary: true,
      isCurrent: true,
      missing: false,
      folderName: 'app',
    });
  });

  it('finds a linked Worktree and marks it current when asked from inside it', async () => {
    const dir = await makeRepo();
    const linked = path.join(path.dirname(dir), 'linked');
    await git(dir, 'worktree', 'add', '-b', 'feature/x', linked);

    const fromLinked = await listWorktrees(linked, 'git', pathEnv);

    expect(fromLinked._tag).toBe('Available');
    if (fromLinked._tag !== 'Available') return;
    expect(fromLinked.entries.map((e) => [e.branch, e.isPrimary, e.isCurrent])).toEqual([
      ['main', true, false],
      ['feature/x', false, true],
    ]);
  });

  it('reports a Worktree whose folder was deleted as missing', async () => {
    const dir = await makeRepo();
    const linked = path.join(path.dirname(dir), 'gone');
    await git(dir, 'worktree', 'add', '-b', 'gone', linked);
    await rm(linked, { recursive: true, force: true });

    const result = await listWorktrees(dir, 'git', pathEnv);

    if (result._tag !== 'Available') throw new Error('expected Available');
    expect(result.entries.find((e) => e.branch === 'gone')?.missing).toBe(true);
  });

  it('reports a folder that is not a repository as NonGit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-nongit-'));
    tempDirs.push(dir);

    expect((await listWorktrees(dir, 'git', pathEnv))._tag).toBe('NonGit');
  });
});

describe('createWorktree', () => {
  it('adds a Worktree on a new branch in a sibling folder and returns it', async () => {
    const dir = await makeRepo();

    const result = await createWorktree(dir, 'feature/login', 'git', pathEnv);

    expect(result._tag).toBe('Created');
    if (result._tag !== 'Created') return;
    expect(result.entry.path).toBe(path.join(path.dirname(dir), 'app.worktrees', 'feature-login'));
    expect(result.entry).toMatchObject({ branch: 'feature/login', isPrimary: false });
    expect((await git(dir, 'branch', '--list', 'feature/login')).trim()).toContain('feature/login');
  });

  it('refuses a branch name that already exists and leaves the repository alone', async () => {
    const dir = await makeRepo();
    await git(dir, 'branch', 'taken');

    const result = await createWorktree(dir, 'taken', 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'BranchExists' });
    const after = await listWorktrees(dir, 'git', pathEnv);
    expect(after._tag === 'Available' && after.entries.length).toBe(1);
  });

  it('refuses a name git would not accept as a branch', async () => {
    const dir = await makeRepo();

    for (const name of ['', 'has space', '-flag', 'a..b', 'end.lock']) {
      expect(await createWorktree(dir, name, 'git', pathEnv)).toMatchObject({
        _tag: 'Rejected',
        reason: 'InvalidBranch',
      });
    }
  });

  it('refuses when the destination folder already exists', async () => {
    const dir = await makeRepo();
    await mkdir(path.join(path.dirname(dir), 'app.worktrees', 'busy'), { recursive: true });

    const result = await createWorktree(dir, 'busy', 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'DestinationExists' });
  });
});
