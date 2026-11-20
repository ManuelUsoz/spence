import { afterEach, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getCommitDetail, getCommitFileDiff } from './git-commits';
import type { WorkerCommitDetail, WorkerCommitDetailResult } from './worker-protocol';

// Each test runs many real git commands; the 5 s default is too tight while the whole suite runs.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

const makeRepo = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-commits-')));
  tempDirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
};

const commitAll = async (dir: string, message: string): Promise<string> => {
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-m', message);
  return (await git(dir, 'rev-parse', 'HEAD')).trim();
};

const detailOf = (result: WorkerCommitDetailResult): WorkerCommitDetail => {
  if (result._tag !== 'Detail') throw new Error(`expected Detail, got ${result._tag}`);
  return result.commit;
};

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

describe('getCommitDetail', () => {
  it('treats a historical filename as a literal Git path', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, '[a].txt'), 'literal\n');
    await writeFile(path.join(dir, 'a.txt'), 'other\n');
    const sha = await commitAll(dir, 'files');

    const result = await getCommitFileDiff(dir, sha, '[a].txt', 'git', pathEnv);
    expect(result).toMatchObject({
      _tag: 'Available',
      preview: { _tag: 'Patch', path: '[a].txt', additions: 1 },
    });
    if (result._tag !== 'Available' || result.preview._tag !== 'Patch') return;
    expect(JSON.stringify(result.preview.hunks)).toContain('literal');
    expect(JSON.stringify(result.preview.hunks)).not.toContain('other');
  });

  it('lists the message and changed files of an ordinary commit', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'one\ntwo\n');
    await writeFile(path.join(dir, 'gone.txt'), 'x\n');
    await commitAll(dir, 'first');
    await writeFile(path.join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    await writeFile(path.join(dir, 'new.txt'), 'n\n');
    await rm(path.join(dir, 'gone.txt'));
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-m', 'second subject', '-m', 'The body\nof the message.');
    const sha = (await git(dir, 'rev-parse', 'HEAD')).trim();

    const commit = detailOf(await getCommitDetail(dir, sha.slice(0, 8), 'git', pathEnv));

    expect(commit.sha).toBe(sha);
    expect(commit.subject).toBe('second subject');
    expect(commit.body).toBe('The body\nof the message.');
    expect(commit.authorName).toBe('Spence Test');
    expect(commit.isMerge).toBe(false);
    expect(
      commit.files.map((file) => [file.path, file.status, file.additions, file.deletions]),
    ).toEqual([
      ['a.txt', 'Modified', 2, 1],
      ['gone.txt', 'Deleted', 0, 1],
      ['new.txt', 'Added', 1, 0],
    ]);
  });

  it('reports a rename with its previous path', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'old.txt'), 'line 1\nline 2\nline 3\nline 4\n');
    await commitAll(dir, 'first');
    await rename(path.join(dir, 'old.txt'), path.join(dir, 'renamed.txt'));
    const sha = await commitAll(dir, 'rename');

    const commit = detailOf(await getCommitDetail(dir, sha, 'git', pathEnv));

    expect(commit.files).toEqual([
      {
        path: 'renamed.txt',
        previousPath: 'old.txt',
        status: 'Renamed',
        additions: 0,
        deletions: 0,
      },
    ]);
  });

  it('counts a binary file as null', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    await commitAll(dir, 'first');
    await writeFile(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    const sha = await commitAll(dir, 'binary');

    const commit = detailOf(await getCommitDetail(dir, sha, 'git', pathEnv));

    expect(commit.files).toEqual([
      { path: 'blob.bin', status: 'Added', additions: null, deletions: null },
    ]);
    const diff = await getCommitFileDiff(dir, sha, 'blob.bin', 'git', pathEnv);
    expect(diff).toMatchObject({
      _tag: 'Available',
      preview: { _tag: 'Unavailable', reason: 'Binary' },
    });
  });

  it('lists a merge commit against its first parent', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'base.txt'), 'base\n');
    await commitAll(dir, 'base');
    await git(dir, 'switch', '-c', 'side');
    await writeFile(path.join(dir, 'side.txt'), 'side\n');
    await commitAll(dir, 'side work');
    await git(dir, 'switch', 'main');
    await writeFile(path.join(dir, 'main.txt'), 'main\n');
    await commitAll(dir, 'main work');
    await git(dir, 'merge', '--no-ff', '-m', 'merge side', 'side');
    const sha = (await git(dir, 'rev-parse', 'HEAD')).trim();

    const commit = detailOf(await getCommitDetail(dir, sha, 'git', pathEnv));

    expect(commit.isMerge).toBe(true);
    expect(commit.files.map((file) => [file.path, file.status])).toEqual([['side.txt', 'Added']]);
    const diff = await getCommitFileDiff(dir, sha, 'side.txt', 'git', pathEnv);
    expect(diff).toMatchObject({ _tag: 'Available', preview: { _tag: 'Patch', additions: 1 } });
  });

  it('lists every file of a root commit as added', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nb\n');
    const sha = await commitAll(dir, 'root');

    const commit = detailOf(await getCommitDetail(dir, sha, 'git', pathEnv));

    expect(commit.files).toEqual([{ path: 'a.txt', status: 'Added', additions: 2, deletions: 0 }]);
    const diff = await getCommitFileDiff(dir, sha, 'a.txt', 'git', pathEnv);
    expect(diff).toMatchObject({
      _tag: 'Available',
      preview: { _tag: 'Patch', additions: 2, deletions: 0, truncated: false },
    });
  });

  it('refuses an unknown, unreachable or malformed id', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    await commitAll(dir, 'first');
    await git(dir, 'switch', '-c', 'other');
    await writeFile(path.join(dir, 'other.txt'), 'o\n');
    const elsewhere = await commitAll(dir, 'only on other');
    await git(dir, 'switch', 'main');

    expect(await getCommitDetail(dir, 'f'.repeat(40), 'git', pathEnv)).toMatchObject({
      _tag: 'UnknownCommit',
    });
    expect(await getCommitDetail(dir, elsewhere, 'git', pathEnv)).toMatchObject({
      _tag: 'UnknownCommit',
      detail: 'That commit is not part of the current branch.',
    });
    expect(await getCommitDetail(dir, 'HEAD; rm -rf', 'git', pathEnv)).toMatchObject({
      _tag: 'UnknownCommit',
      detail: 'That is not a commit id.',
    });
    expect(await getCommitDetail(dir, 'abc', 'git', pathEnv)).toMatchObject({
      _tag: 'UnknownCommit',
    });
    expect(await getCommitFileDiff(dir, elsewhere, 'other.txt', 'git', pathEnv)).toMatchObject({
      _tag: 'InvalidPath',
    });
  });

  it('refuses unsafe paths for a file diff', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\n');
    const sha = await commitAll(dir, 'first');

    expect(await getCommitFileDiff(dir, sha, '../a.txt', 'git', pathEnv)).toMatchObject({
      _tag: 'InvalidPath',
    });
    expect(await getCommitFileDiff(dir, sha, 'a.txt', 'git', pathEnv, '.git/x')).toMatchObject({
      _tag: 'InvalidPath',
    });
  });

  it('diffs a renamed file against its previous path and truncates a huge diff', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'old.txt'), 'line 1\nline 2\nline 3\nline 4\n');
    await commitAll(dir, 'first');
    await rename(path.join(dir, 'old.txt'), path.join(dir, 'new.txt'));
    await writeFile(path.join(dir, 'new.txt'), 'line 1\nline two\nline 3\nline 4\n');
    const renamed = await commitAll(dir, 'rename and edit');
    await writeFile(
      path.join(dir, 'big.txt'),
      Array.from({ length: 6000 }, (_, index) => `row ${String(index)}`).join('\n') + '\n',
    );
    const big = await commitAll(dir, 'big');

    const diff = await getCommitFileDiff(dir, renamed, 'new.txt', 'git', pathEnv, 'old.txt');
    expect(diff).toMatchObject({
      _tag: 'Available',
      preview: { _tag: 'Patch', previousPath: 'old.txt', additions: 1, deletions: 1 },
    });

    const truncated = await getCommitFileDiff(dir, big, 'big.txt', 'git', pathEnv);
    expect(truncated).toMatchObject({
      _tag: 'Available',
      preview: { _tag: 'Patch', truncated: true },
    });
  });

  it('reports a missing folder and a non-repository as unavailable', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-commits-plain-')));
    tempDirs.push(dir);

    expect(await getCommitDetail(dir, 'a'.repeat(40), 'git', pathEnv)).toMatchObject({
      _tag: 'NonGit',
    });
    expect(await getCommitDetail(path.join(dir, 'nope'), 'a'.repeat(40), 'git', pathEnv)).toEqual(
      expect.objectContaining({ _tag: 'MissingPath' }),
    );
  });
});
