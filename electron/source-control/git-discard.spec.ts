import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import { vi } from 'vitest';
import { execFile as execFileCb } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  discardChanges,
  prepareDiscard,
  pruneRecoveries,
  RECOVERY_DAYS,
  revertCommit,
} from './git-discard';
import { inspectGitStatus } from './git-status-diff';

// Each test runs many real git commands; the 5 s default is too tight while the whole suite runs.
vi.setConfig({ testTimeout: 60_000 });

const execFile = promisify(execFileCb);
const tempDirs: string[] = [];
const pathEnv = process.env['PATH'] ?? '';
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

let templateDir = '';

beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-discard-tpl-')));
  tempDirs.push(base);
  const dir = path.join(base, 'app');
  await mkdir(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'a.txt'), 'a\n');
  await writeFile(path.join(dir, 'b.txt'), 'b\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  templateDir = dir;
});

const makeRepo = async (): Promise<{ dir: string; recovery: string }> => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), 'spence-discard-')));
  tempDirs.push(parent);
  const dir = path.join(parent, 'app');
  await cp(templateDir, dir, { recursive: true });
  return { dir, recovery: path.join(parent, 'recovery') };
};

/** Reads a file with Windows line endings (autocrlf) folded to \n, so tests do not depend on the machine. */
const readLf = async (file: string): Promise<string> =>
  (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');

const changedPaths = async (dir: string): Promise<string[]> => {
  const status = await inspectGitStatus(dir, 'git', pathEnv);
  if (status._tag !== 'Available') throw new Error('expected Available');
  return status.files.map((file) => file.path).sort();
};

/** Plans and confirms in one go, as the dialog does: what was shown is what is discarded. */
const discard = async (
  dir: string,
  recovery: string,
  targets: Array<{ path: string; previousPath?: string }>,
) => {
  const plan = await prepareDiscard(dir, targets, 'git', pathEnv);
  if (plan._tag !== 'Ready') throw new Error(`not ready: ${plan._tag}`);
  return discardChanges(dir, targets, plan.token, recovery, NOW, 'git', pathEnv);
};

afterAll(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
});

describe.concurrent('prepareDiscard', () => {
  it('lists what each file would lose and ignores files that are no longer changed', async () => {
    const { dir } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await writeFile(path.join(dir, 'new.txt'), 'n\n');

    const plan = await prepareDiscard(
      dir,
      [{ path: 'a.txt' }, { path: 'new.txt' }, { path: 'b.txt' }],
      'git',
      pathEnv,
    );

    expect(plan._tag).toBe('Ready');
    if (plan._tag !== 'Ready') return;
    expect(plan.files.map((file) => [file.path, file.effect])).toEqual([
      ['a.txt', 'Restore'],
      ['new.txt', 'Remove'],
    ]);
  });

  it('refuses when nothing selected is changed, a file is in conflict, or a merge is in progress', async () => {
    const { dir } = await makeRepo();

    expect(await prepareDiscard(dir, [{ path: 'b.txt' }], 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'NothingSelected',
    });

    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    const gitDir = (await git(dir, 'rev-parse', '--absolute-git-dir')).trim();
    await writeFile(path.join(gitDir, 'MERGE_HEAD'), (await git(dir, 'rev-parse', 'HEAD')).trim());
    expect(await prepareDiscard(dir, [{ path: 'a.txt' }], 'git', pathEnv)).toMatchObject({
      _tag: 'Rejected',
      reason: 'IntegrationInProgress',
    });
  });
});

describe.concurrent('discardChanges', () => {
  it('restores modified and deleted files and removes new ones, leaving unselected changes', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    await rm(path.join(dir, 'b.txt'));
    await writeFile(path.join(dir, 'new.txt'), 'n\n');
    await writeFile(path.join(dir, 'keep.txt'), 'k\n');

    const result = await discard(dir, recovery, [
      { path: 'a.txt' },
      { path: 'b.txt' },
      { path: 'new.txt' },
    ]);

    expect(result).toMatchObject({ _tag: 'Discarded', count: 3 });
    expect(await readLf(path.join(dir, 'a.txt'))).toBe('a\n');
    expect(await readLf(path.join(dir, 'b.txt'))).toBe('b\n');
    expect(await changedPaths(dir)).toEqual(['keep.txt']);
  });

  it('discards a staged new file and a staged rename completely', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'added.txt'), 'x\n');
    await git(dir, 'add', 'added.txt');
    await git(dir, 'mv', 'a.txt', 'renamed.txt');

    const result = await discard(dir, recovery, [
      { path: 'added.txt' },
      { path: 'renamed.txt', previousPath: 'a.txt' },
    ]);

    expect(result._tag).toBe('Discarded');
    expect(await changedPaths(dir)).toEqual([]);
    expect(await readLf(path.join(dir, 'a.txt'))).toBe('a\n');
    expect((await git(dir, 'ls-files')).trim().split('\n')).toEqual(['a.txt', 'b.txt']);
  });

  it('keeps a copy of what was thrown away, with a note of where it came from', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nprecious\n');
    await writeFile(path.join(dir, 'new.txt'), 'brand new\n');

    const result = await discard(dir, recovery, [{ path: 'a.txt' }, { path: 'new.txt' }]);

    expect(result._tag).toBe('Discarded');
    if (result._tag !== 'Discarded') return;
    expect(await readFile(path.join(result.recovery.folder, 'files', 'a.txt'), 'utf8')).toBe(
      'a\nprecious\n',
    );
    expect(await readFile(path.join(result.recovery.folder, 'files', 'new.txt'), 'utf8')).toBe(
      'brand new\n',
    );
    expect(await readFile(path.join(result.recovery.folder, 'changes.patch'), 'utf8')).toContain(
      '+precious',
    );
    const manifest = JSON.parse(
      await readFile(path.join(result.recovery.folder, 'manifest.json'), 'utf8'),
    ) as { cwd: string; createdAt: number; files: Array<{ path: string }> };
    expect(manifest.cwd).toBe(dir);
    expect(manifest.createdAt).toBe(NOW);
    expect(manifest.files.map((file) => file.path)).toEqual(['a.txt', 'new.txt']);
  });

  it('refuses, changing nothing, when a file changed after the plan was shown', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    const targets = [{ path: 'a.txt' }];
    const plan = await prepareDiscard(dir, targets, 'git', pathEnv);
    if (plan._tag !== 'Ready') throw new Error('expected Ready');

    await writeFile(path.join(dir, 'a.txt'), 'a\nthe Agent kept editing\n');
    const result = await discardChanges(dir, targets, plan.token, recovery, NOW, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'Stale' });
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('a\nthe Agent kept editing\n');
    expect(await readdir(recovery).catch(() => [])).toEqual([]);
  });

  it('refuses when another file joined the selection after the plan was shown', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'a.txt'), 'a\nmore\n');
    const targets = [{ path: 'a.txt' }, { path: 'b.txt' }];
    const plan = await prepareDiscard(dir, targets, 'git', pathEnv);
    if (plan._tag !== 'Ready') throw new Error('expected Ready');

    await writeFile(path.join(dir, 'b.txt'), 'b\nedited later\n');
    const result = await discardChanges(dir, targets, plan.token, recovery, NOW, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'Stale' });
    expect(await readFile(path.join(dir, 'b.txt'), 'utf8')).toBe('b\nedited later\n');
  });

  it('treats file names as names, not patterns', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'page[id].txt'), 'x\n');
    await writeFile(path.join(dir, 'pagei.txt'), 'y\n');

    const result = await discard(dir, recovery, [{ path: 'page[id].txt' }]);

    expect(result._tag).toBe('Discarded');
    expect(await changedPaths(dir)).toEqual(['pagei.txt']);
  });
});

describe.concurrent('pruneRecoveries', () => {
  it('deletes copies older than the retention period and keeps newer ones', async () => {
    const { dir, recovery } = await makeRepo();
    await writeFile(path.join(dir, 'new.txt'), 'n\n');
    const result = await discard(dir, recovery, [{ path: 'new.txt' }]);
    if (result._tag !== 'Discarded') throw new Error('expected Discarded');
    const day = 24 * 60 * 60 * 1000;

    await pruneRecoveries(recovery, NOW + (RECOVERY_DAYS - 1) * day);
    expect(await readdir(recovery)).toHaveLength(1);

    await pruneRecoveries(recovery, NOW + (RECOVERY_DAYS + 1) * day);
    expect(await readdir(recovery)).toEqual([]);
  });

  it('never touches folders that are not recovery copies', async () => {
    const { recovery } = await makeRepo();
    await mkdir(path.join(recovery, 'someone-elses'), { recursive: true });
    await utimes(path.join(recovery, 'someone-elses'), 1, 1);

    await pruneRecoveries(recovery, NOW + 400 * 24 * 60 * 60 * 1000);

    expect(await readdir(recovery)).toEqual(['someone-elses']);
  });
});

describe.concurrent('revertCommit', () => {
  const addCommit = async (dir: string, file: string, content: string, message: string) => {
    await writeFile(path.join(dir, file), content);
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', message);
    return (await git(dir, 'rev-parse', 'HEAD')).trim();
  };

  it('reverts an ordinary commit with a new commit', async () => {
    const { dir } = await makeRepo();
    const sha = await addCommit(dir, 'c.txt', 'c\n', 'Add c');

    const result = await revertCommit(dir, sha, 'git', pathEnv);

    expect(result._tag).toBe('Reverted');
    expect((await git(dir, 'log', '--format=%s')).trim().split('\n')[0]).toBe('Revert "Add c"');
    expect(await changedPaths(dir)).toEqual([]);
    await expect(readFile(path.join(dir, 'c.txt'), 'utf8')).rejects.toThrow();
  });

  it('refuses a merge commit, an unknown commit, and a commit outside this branch', async () => {
    const { dir } = await makeRepo();
    await git(dir, 'checkout', '-b', 'side');
    const sideSha = await addCommit(dir, 's.txt', 's\n', 'Side work');
    await git(dir, 'checkout', 'main');
    await addCommit(dir, 'm.txt', 'm\n', 'Main work');
    await git(dir, 'merge', '--no-ff', '-m', 'Merge side', 'side');
    const mergeSha = (await git(dir, 'rev-parse', 'HEAD')).trim();
    await git(dir, 'checkout', '-b', 'other', 'HEAD~1');
    await addCommit(dir, 'o.txt', 'o\n', 'Other work');
    await git(dir, 'checkout', 'main');
    const otherSha = (await git(dir, 'rev-parse', 'other')).trim();

    expect(await revertCommit(dir, mergeSha, 'git', pathEnv)).toMatchObject({
      reason: 'MergeCommit',
    });
    expect(await revertCommit(dir, '0'.repeat(40), 'git', pathEnv)).toMatchObject({
      reason: 'UnknownCommit',
    });
    expect(await revertCommit(dir, otherSha, 'git', pathEnv)).toMatchObject({
      reason: 'NotInBranch',
    });
    expect(await revertCommit(dir, 'not a sha; rm -rf', 'git', pathEnv)).toMatchObject({
      reason: 'UnknownCommit',
    });
    expect(sideSha).not.toBe(mergeSha);
  });

  it('refuses while tracked files have changes, leaving them alone', async () => {
    const { dir } = await makeRepo();
    const sha = await addCommit(dir, 'c.txt', 'c\n', 'Add c');
    await writeFile(path.join(dir, 'a.txt'), 'a\nunsaved work\n');

    const result = await revertCommit(dir, sha, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'DirtyTree' });
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('a\nunsaved work\n');
  });

  it('backs out cleanly when the revert would conflict', async () => {
    const { dir } = await makeRepo();
    const sha = await addCommit(dir, 'a.txt', 'a\nfirst change\n', 'First change');
    await addCommit(dir, 'a.txt', 'a\nfirst change\nsecond change\n', 'Second change');
    await writeFile(path.join(dir, 'a.txt'), 'x\n');
    await git(dir, 'commit', '-am', 'Rewrite a');

    const result = await revertCommit(dir, sha, 'git', pathEnv);

    expect(result).toMatchObject({ _tag: 'Rejected', reason: 'Conflict' });
    expect(await changedPaths(dir)).toEqual([]);
    expect((await git(dir, 'log', '--format=%s')).trim().split('\n')[0]).toBe('Rewrite a');
  });
});
