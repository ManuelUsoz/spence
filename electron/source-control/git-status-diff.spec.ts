import { afterEach, describe, expect, it } from '@effect/vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectGitDiff, inspectGitStatus } from './git-status-diff';

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
};

const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'spence-changes-'));
  tempDirs.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
};

const pathEnv = process.env['PATH'] ?? '';

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('inspectGitStatus', () => {
  it('lists modified and untracked files with line counts', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'tracked.txt'), 'one\ntwo\nthree\n');
    await writeFile(path.join(dir, 'fresh.txt'), 'a\nb\n');

    const result = await inspectGitStatus(dir, 'git', pathEnv);

    expect(result._tag).toBe('Available');
    if (result._tag !== 'Available') return;
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    expect(byPath.get('tracked.txt')).toMatchObject({
      status: 'Modified',
      additions: 1,
      deletions: 0,
      unstaged: true,
    });
    expect(byPath.get('fresh.txt')).toMatchObject({ status: 'Untracked', additions: 2 });
    expect(result.head).toMatchObject({ _tag: 'Branch', branch: 'main' });
  });

  it('reports a folder that is not a repository as NonGit', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-nongit-'));
    tempDirs.push(dir);

    const result = await inspectGitStatus(dir, 'git', pathEnv);

    expect(result._tag).toBe('NonGit');
  });
});

describe('inspectGitDiff', () => {
  it('returns hunks with added and deleted lines for a modified file', async () => {
    const dir = await makeRepo();
    await writeFile(path.join(dir, 'tracked.txt'), 'one\nTWO\n');

    const result = await inspectGitDiff(dir, 'tracked.txt', 'combined', 'git', pathEnv);

    expect(result._tag).toBe('Available');
    if (result._tag !== 'Available') return;
    expect(result.preview._tag).toBe('Patch');
    if (result.preview._tag !== 'Patch') return;
    const kinds = result.preview.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind));
    expect(kinds).toContain('add');
    expect(kinds).toContain('delete');
  });
});
