import { afterEach, describe, expect, it } from '@effect/vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  commitChanges,
  fetchRemote,
  listRemotes,
  pullFastForward,
  pushBranch,
} from './git-actions';
import { inspectGitStatus } from './git-status-diff';

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

const configure = async (dir: string): Promise<void> => {
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
};

/** A repository with one commit, inside its own temp parent. */
const makeRepo = async (): Promise<{ parent: string; dir: string }> => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-actions-')));
  tempDirs.push(parent);
  const dir = path.join(parent, 'app');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await configure(dir);
  await writeFile(path.join(dir, 'a.txt'), 'a\n');
  await writeFile(path.join(dir, 'b.txt'), 'b\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return { parent, dir };
};

/** The same, with a bare `origin` the branch tracks, and a second clone to play another person. */
const makeRepoWithRemote = async () => {
  const { parent, dir } = await makeRepo();
  const origin = path.join(parent, 'origin.git');
  await git(parent, 'init', '--bare', '-b', 'main', origin);
  await git(dir, 'remote', 'add', 'origin', origin);
  await git(dir, 'push', '-u', 'origin', 'main');
  const other = path.join(parent, 'other');
  await git(parent, 'clone', origin, other);
  await configure(other);
  return { parent, dir, origin, other };
};

const subjects = async (cwd: string, ref = 'HEAD'): Promise<string[]> =>
  (await git(cwd, 'log', '--format=%s', ref)).trim().split('\n');

const changedPaths = async (dir: string): Promise<string[]> => {
  const status = await inspectGitStatus(dir, 'git', pathEnv);
  if (status._tag !== 'Available') throw new Error('expected Available');
  return status.files.map((file) => file.path).sort();
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('commitChanges', () => {
  it('commits only the selected files and leaves the others changed', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await writeFile(path.join(dir, 'b.txt'), 'b\nmore\n');

    const result = await commitChanges(dir, 'Update a', [{ path: 'a.txt' }], false, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Committed', pushed: 'NotRequested' });
    expect(await subjects(dir)).toEqual(['Update a', 'initial']);
    expect(await changedPaths(dir)).toEqual(['b.txt']);
  });

  it('commits a new file and a deleted one', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'fresh.txt'), 'new\n');
    await rm(path.join(dir, 'b.txt'));

    const result = await commitChanges(
      dir,
      'Add fresh, drop b',
      [{ path: 'fresh.txt' }, { path: 'b.txt' }],
      false,
      'git',
      pathEnv,
    );

    expect(result._tag).toBe('Committed');
    expect(await changedPaths(dir)).toEqual([]);
    expect((await git(dir, 'ls-files')).trim().split('\n')).toEqual(['a.txt', 'fresh.txt']);
  });

  it('commits a rename as one change when both paths are given', async () => {
    const { dir } = await makeRepo();
    await git(dir, 'mv', 'a.txt', 'renamed.txt');

    const result = await commitChanges(
      dir,
      'Rename a',
      [{ path: 'renamed.txt', previousPath: 'a.txt' }],
      false,
      'git',
      pathEnv,
    );

    expect(result._tag).toBe('Committed');
    expect(await changedPaths(dir)).toEqual([]);
    expect(await git(dir, 'show', '--name-status', '--format=', 'HEAD')).toMatch(
      /^R\d*\s+a\.txt\s+renamed\.txt/,
    );
  });

  it('keeps other staged changes staged', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await writeFile(path.join(dir, 'b.txt'), 'b\nmore\n');
    await git(dir, 'add', 'b.txt');

    await commitChanges(dir, 'Only a', [{ path: 'a.txt' }], false, 'git', pathEnv);

    expect((await git(dir, 'diff', '--cached', '--name-only')).trim()).toBe('b.txt');
  });

  it('refuses an empty message, no files, and a merge in progress without committing', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');

    expect(
      await commitChanges(dir, '   ', [{ path: 'a.txt' }], false, 'git', pathEnv),
    ).toMatchObject({
      _tag: 'Rejected',
      reason: 'EmptyMessage',
    });
    expect(await commitChanges(dir, 'msg', [], false, 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'NothingSelected',
    });
    const gitDir = (await git(dir, 'rev-parse', '--absolute-git-dir')).trim();
    await writeFile(path.join(gitDir, 'MERGE_HEAD'), (await git(dir, 'rev-parse', 'HEAD')).trim());
    expect(
      await commitChanges(dir, 'msg', [{ path: 'a.txt' }], false, 'git', pathEnv),
    ).toMatchObject({
      _tag: 'Rejected',
      reason: 'IntegrationInProgress',
    });
    expect(await subjects(dir)).toEqual(['initial']);
  });

  it('shows what a failing pre-commit hook said and commits nothing', async () => {
    const { dir } = await makeRepo();
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "lint failed: no TODOs" >&2\nexit 1\n', { mode: 0o755 });
    await writeFile(path.join(dir, 'a.txt'), 'a\nTODO\n');

    const result = await commitChanges(dir, 'Add todo', [{ path: 'a.txt' }], false, 'git', pathEnv);

    expect(result._tag).toBe('Failed');
    if (result._tag !== 'Failed') return;
    expect(result.detail).toContain('lint failed: no TODOs');
    expect(await subjects(dir)).toEqual(['initial']);
  });

  it('commits and pushes to the branch upstream', async () => {
    const { dir, origin } = await makeRepoWithRemote();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');

    const result = await commitChanges(dir, 'Ship it', [{ path: 'a.txt' }], true, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Committed', pushed: 'Pushed' });
    expect(await subjects(origin, 'main')).toEqual(['Ship it', 'initial']);
  });

  it('refuses to commit and push when there is nowhere to push, before committing', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');

    const result = await commitChanges(dir, 'Ship it', [{ path: 'a.txt' }], true, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'NoRemote' });
    expect(await subjects(dir)).toEqual(['initial']);
  });

  it('keeps the commit and says so when the push is rejected', async () => {
    const { dir, other } = await makeRepoWithRemote();
    await writeFile(path.join(other, 'c.txt'), 'c\n');
    await git(other, 'add', '.');
    await git(other, 'commit', '-m', 'from other');
    await git(other, 'push');
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');

    const result = await commitChanges(dir, 'Mine', [{ path: 'a.txt' }], true, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Committed', pushed: 'Failed' });
    expect(await subjects(dir)).toEqual(['Mine', 'initial']);
  });
});

describe('remotes', () => {
  it('lists the remotes of the repository', async () => {
    const { dir } = await makeRepoWithRemote();

    expect(await listRemotes(dir, 'git', pathEnv)).toEqual(['origin']);
  });

  it('pushes a branch with no upstream to a chosen remote and tracks it', async () => {
    const { parent, dir } = await makeRepo();
    const origin = path.join(parent, 'origin.git');
    await git(parent, 'init', '--bare', '-b', 'main', origin);
    await git(dir, 'remote', 'add', 'origin', origin);

    expect(await pushBranch(dir, undefined, 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'NeedsRemote',
    });
    expect(await pushBranch(dir, 'nope', 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'UnknownRemote',
    });
    expect(await pushBranch(dir, 'origin', 'git', pathEnv)).toMatchObject({ _tag: 'Done' });

    expect(await subjects(origin, 'main')).toEqual(['initial']);
    expect((await git(dir, 'rev-parse', '--abbrev-ref', '@{u}')).trim()).toBe('origin/main');
  });

  it('says the branch is behind when a push would lose the others work', async () => {
    const { dir, other } = await makeRepoWithRemote();
    await writeFile(path.join(other, 'c.txt'), 'c\n');
    await git(other, 'add', '.');
    await git(other, 'commit', '-m', 'from other');
    await git(other, 'push');
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await git(dir, 'commit', '-am', 'mine');

    expect(await pushBranch(dir, undefined, 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'Behind',
    });
  });

  it('fetches new commits, then fast-forwards the branch to them', async () => {
    const { dir, other } = await makeRepoWithRemote();
    await writeFile(path.join(other, 'c.txt'), 'c\n');
    await git(other, 'add', '.');
    await git(other, 'commit', '-m', 'from other');
    await git(other, 'push');

    expect(await fetchRemote(dir, 'git', pathEnv)).toMatchObject({ _tag: 'Done' });
    const status = await inspectGitStatus(dir, 'git', pathEnv);
    expect(status._tag === 'Available' && status.aheadBehind?.behind).toBe(1);
    expect(await subjects(dir)).toEqual(['initial']);

    expect(await pullFastForward(dir, 'git', pathEnv)).toMatchObject({ _tag: 'Done' });
    expect(await subjects(dir)).toEqual(['from other', 'initial']);
    expect(await readFile(path.join(dir, 'c.txt'), 'utf8')).toContain('c');
  });

  it('refuses a pull that is not a fast-forward and leaves the branch alone', async () => {
    const { dir, other } = await makeRepoWithRemote();
    await writeFile(path.join(other, 'c.txt'), 'c\n');
    await git(other, 'add', '.');
    await git(other, 'commit', '-m', 'from other');
    await git(other, 'push');
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await git(dir, 'commit', '-am', 'mine');

    const result = await pullFastForward(dir, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'Diverged' });
    expect(await subjects(dir)).toEqual(['mine', 'initial']);
  });

  it('explains a branch with no upstream or a repository with no remote', async () => {
    const { dir } = await makeRepo();

    expect(await fetchRemote(dir, 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'NoRemote',
    });
    expect(await pullFastForward(dir, 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'NoUpstream',
    });
  });
});
