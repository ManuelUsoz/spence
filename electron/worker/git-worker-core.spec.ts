import { afterEach, describe, expect, it } from '@effect/vitest';
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inspectCommitDetail, inspectCommitFileDiff, listGitCommits } from './git-commits';
import { inspectGitDiff, inspectGitStatus } from './git-status-diff';
import { handleWorkerRequest } from './git-worker-core';
import { fingerprintBytes } from './git-fingerprint';
import type {
  WorkerCommitDetailResult,
  WorkerCommitFileDiffResult,
  WorkerCommitsResult,
  WorkerDiffResult,
  WorkerGitStatusResult,
  WorkerRequest,
} from './worker-protocol';

const execFile = promisify(execFileCb);

const tempDirs: string[] = [];

const createTempDir = async (prefix = 'spence-git-worker-'): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const runGitCmd = async (cwd: string, args: ReadonlyArray<string>): Promise<string> => {
  const { stdout } = await execFile('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  return stdout.trim();
};

const initRepo = async (dir: string, initialBranch = 'main'): Promise<void> => {
  await runGitCmd(dir, ['init', '-b', initialBranch]);
  await runGitCmd(dir, ['config', 'user.email', 'test@spence.local']);
  await runGitCmd(dir, ['config', 'user.name', 'Spence Test']);
};

const commitFile = async (
  dir: string,
  relPath: string,
  content: string | Uint8Array,
  message: string,
): Promise<string> => {
  const fullPath = path.join(dir, relPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content);
  await runGitCmd(dir, ['add', '--', relPath]);
  await runGitCmd(dir, ['commit', '-m', message]);
  return runGitCmd(dir, ['rev-parse', 'HEAD']);
};

const resolveSystemGit = async (): Promise<{
  readonly executable: string;
  readonly pathEnv: string;
}> => {
  const pathEnv = process.env['PATH'] ?? '';
  const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
  const { stdout } = await execFile(whereCmd, ['git']);
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  expect(first).toBeDefined();
  return { executable: first ?? 'git', pathEnv };
};

const callTyped = async <T>(request: WorkerRequest): Promise<T> => {
  const response = await handleWorkerRequest(request);
  expect(response.ok).toBe(true);
  if (!response.ok) {
    return expect.fail(`Worker failed: ${response.detail}`);
  }
  return response.result as T;
};

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
});

describe('git-worker-core status, diff, and commits', () => {
  it('distinguishes saved contents with the same modified Git status', async () => {
    const repo = await createTempDir();
    await initRepo(repo);
    await commitFile(repo, 'tracked.txt', 'base\n', 'initial');
    const { executable, pathEnv } = await resolveSystemGit();
    const file = path.join(repo, 'tracked.txt');
    await writeFile(file, 'first\n');
    const firstStatus = await inspectGitStatus(repo, executable, pathEnv);
    const firstDigest = fingerprintBytes(await readFile(file));
    await writeFile(file, 'other\n');
    const secondStatus = await inspectGitStatus(repo, executable, pathEnv);
    const secondDigest = fingerprintBytes(await readFile(file));
    expect(firstStatus._tag).toBe('Available');
    expect(secondStatus._tag).toBe('Available');
    if (firstStatus._tag !== 'Available' || secondStatus._tag !== 'Available') return;
    expect(firstStatus.files[0]?.status).toBe('Modified');
    expect(secondStatus.files[0]?.status).toBe('Modified');
    expect(firstDigest).not.toBe(secondDigest);
  });
  it('inspects clean repo, staged, unstaged, staged-plus-newer-unstaged, deletions, untracked, and external edits', async () => {
    const repo = await createTempDir();
    await initRepo(repo);
    await commitFile(repo, 'tracked.txt', 'line 1\nline 2\n', 'initial tracked');
    await commitFile(repo, 'to-delete.txt', 'bye 1\nbye 2\n', 'initial delete target');
    await commitFile(repo, 'both.txt', 'base\n', 'initial both');
    await commitFile(repo, 'staged-del.txt', 'remove me\n', 'initial staged delete');
    await commitFile(repo, 'staged-only.txt', 'before\n', 'initial staged only');
    await commitFile(repo, 'recreated.txt', 'old bytes\n', 'initial recreated');

    const { executable, pathEnv } = await resolveSystemGit();

    // Clean baseline
    const clean = await callTyped<WorkerGitStatusResult>({
      id: 0,
      method: 'git.status',
      folder: repo,
      gitExecutable: executable,
      pathEnv,
    });
    expect(clean._tag).toBe('Available');
    if (clean._tag !== 'Available') return;
    expect(clean.files).toEqual([]);

    // External edit made directly on disk outside Spence
    await writeFile(path.join(repo, 'tracked.txt'), 'line 1\nline 2 edited externally\nline 3\n');
    await writeFile(path.join(repo, 'staged-only.txt'), 'after\n');
    await runGitCmd(repo, ['add', '--', 'staged-only.txt']);

    // Staged + newer unstaged edit on same file (MM)
    await writeFile(path.join(repo, 'both.txt'), 'base\nstaged addition\n');
    await runGitCmd(repo, ['add', '--', 'both.txt']);
    await writeFile(
      path.join(repo, 'both.txt'),
      'base\nstaged addition\nnewer unstaged addition\n',
    );

    // Unstaged deletion and staged deletion
    await rm(path.join(repo, 'to-delete.txt'));
    await runGitCmd(repo, ['rm', '--', 'staged-del.txt']);
    await runGitCmd(repo, ['rm', '--', 'recreated.txt']);
    await writeFile(path.join(repo, 'recreated.txt'), 'new saved bytes\n');

    // Staged new file + newer unstaged edit (AM)
    await writeFile(path.join(repo, 'new-am.txt'), 'staged line\n');
    await runGitCmd(repo, ['add', '--', 'new-am.txt']);
    await writeFile(path.join(repo, 'new-am.txt'), 'staged line\nunstaged line\n');

    // Untracked file in nested directory
    await mkdir(path.join(repo, 'nested'), { recursive: true });
    await writeFile(path.join(repo, 'nested', 'fresh.txt'), 'hello\nworld\n');

    const status = await callTyped<WorkerGitStatusResult>({
      id: 1,
      method: 'git.status',
      folder: repo,
      gitExecutable: executable,
      pathEnv,
    });
    expect(status._tag).toBe('Available');
    if (status._tag !== 'Available') return;

    expect(status.head).toMatchObject({ _tag: 'Branch', branch: 'main' });
    expect(status.integration).toBe('None');
    expect(status.hasConflicts).toBe(false);
    expect(status.incompleteDiffCounts).toBe(false);

    const byPath = new Map(status.files.map((file) => [file.path, file]));
    expect(status.files.filter((file) => file.path === 'recreated.txt')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ indexStatus: 'Deleted', staged: true }),
        expect.objectContaining({ workTreeStatus: 'Untracked', unstaged: true }),
      ]),
    );
    expect(byPath.get('staged-only.txt')).toMatchObject({
      indexStatus: 'Modified',
      workTreeStatus: 'Unmodified',
    });
    expect(byPath.get('tracked.txt')).toMatchObject({
      status: 'Modified',
      staged: false,
      unstaged: true,
      hasStagedAndUnstaged: false,
      additions: 2,
      deletions: 1,
      kind: 'Regular',
    });
    expect(byPath.get('both.txt')).toMatchObject({
      indexStatus: 'Modified',
      workTreeStatus: 'Modified',
      status: 'Modified',
      staged: true,
      unstaged: true,
      hasStagedAndUnstaged: true,
      additions: 2,
      deletions: 0,
      kind: 'Regular',
    });
    expect(byPath.get('new-am.txt')).toMatchObject({
      status: 'Added',
      staged: true,
      unstaged: true,
      hasStagedAndUnstaged: true,
      additions: 2,
      deletions: 0,
      kind: 'Regular',
    });
    expect(byPath.get('to-delete.txt')).toMatchObject({
      indexStatus: 'Unmodified',
      workTreeStatus: 'Deleted',
      status: 'Deleted',
      staged: false,
      unstaged: true,
      additions: 0,
      deletions: 2,
    });
    expect(byPath.get('staged-del.txt')).toMatchObject({
      status: 'Deleted',
      staged: true,
      unstaged: false,
      additions: 0,
      deletions: 1,
    });
    expect(byPath.get('nested/fresh.txt')).toMatchObject({
      indexStatus: 'Untracked',
      workTreeStatus: 'Untracked',
      status: 'Untracked',
      staged: false,
      unstaged: true,
      additions: 2,
      deletions: 0,
      kind: 'Regular',
    });

    // Combined diff for MM shows BOTH staged and newer unstaged edits
    const combinedDiffRes = await callTyped<WorkerDiffResult>({
      id: 2,
      method: 'git.diff',
      folder: repo,
      path: 'both.txt',
      scope: 'combined',
      gitExecutable: executable,
      pathEnv,
    });
    expect(combinedDiffRes._tag).toBe('Available');
    if (combinedDiffRes._tag !== 'Available') return;
    expect(combinedDiffRes.preview._tag).toBe('Patch');
    if (combinedDiffRes.preview._tag !== 'Patch') return;
    const addedLines = combinedDiffRes.preview.hunks.flatMap((h) =>
      h.lines.filter((l) => l.kind === 'add').map((l) => l.text),
    );
    expect(addedLines).toEqual(['staged addition', 'newer unstaged addition']);

    // Scope 'staged' only shows staged addition
    const stagedDiffRes = await callTyped<WorkerDiffResult>({
      id: 3,
      method: 'git.diff',
      folder: repo,
      path: 'both.txt',
      scope: 'staged',
      gitExecutable: executable,
      pathEnv,
    });
    expect(stagedDiffRes._tag).toBe('Available');
    if (stagedDiffRes._tag !== 'Available' || stagedDiffRes.preview._tag !== 'Patch') return;
    expect(
      stagedDiffRes.preview.hunks.flatMap((h) =>
        h.lines.filter((l) => l.kind === 'add').map((l) => l.text),
      ),
    ).toEqual(['staged addition']);

    // Deleted file diff captures removed lines
    const deletedDiffRes = await callTyped<WorkerDiffResult>({
      id: 4,
      method: 'git.diff',
      folder: repo,
      path: 'to-delete.txt',
      scope: 'combined',
      gitExecutable: executable,
      pathEnv,
    });
    expect(deletedDiffRes._tag).toBe('Available');
    if (deletedDiffRes._tag !== 'Available' || deletedDiffRes.preview._tag !== 'Patch') return;
    expect(deletedDiffRes.preview.deletions).toBe(2);

    // Untracked diff returns bounded added-line patch
    const untrackedDiffRes = await callTyped<WorkerDiffResult>({
      id: 5,
      method: 'git.diff',
      folder: repo,
      path: 'nested/fresh.txt',
      scope: 'combined',
      gitExecutable: executable,
      pathEnv,
    });
    expect(untrackedDiffRes._tag).toBe('Available');
    if (untrackedDiffRes._tag !== 'Available' || untrackedDiffRes.preview._tag !== 'Patch') return;
    expect(untrackedDiffRes.preview.additions).toBe(2);
    expect(untrackedDiffRes.preview.deletions).toBe(0);
  }, 20_000);

  it('discloses staged changes when working tree edits cancel them back to HEAD (net-zero MM)', async () => {
    const repo = await createTempDir();
    await initRepo(repo);
    await commitFile(repo, 'reverted.txt', 'original\n', 'initial');

    await writeFile(path.join(repo, 'reverted.txt'), 'staged change\n');
    await runGitCmd(repo, ['add', '--', 'reverted.txt']);
    await writeFile(path.join(repo, 'reverted.txt'), 'original\n');

    const { executable, pathEnv } = await resolveSystemGit();
    const status = await callTyped<WorkerGitStatusResult>({
      id: 1,
      method: 'git.status',
      folder: repo,
      gitExecutable: executable,
      pathEnv,
    });
    expect(status._tag).toBe('Available');
    if (status._tag !== 'Available') return;

    const entry = status.files.find((f) => f.path === 'reverted.txt');
    expect(entry).toMatchObject({
      staged: true,
      unstaged: true,
      hasStagedAndUnstaged: true,
      stagedNetZeroWorking: true,
    });

    const diffRes = await callTyped<WorkerDiffResult>({
      id: 2,
      method: 'git.diff',
      folder: repo,
      path: 'reverted.txt',
      scope: 'combined',
      gitExecutable: executable,
      pathEnv,
    });
    expect(diffRes._tag).toBe('Available');
    if (diffRes._tag !== 'Available') return;
    expect(diffRes.preview).toMatchObject({
      _tag: 'Unavailable',
      reason: 'NoDifference',
      hasStagedChanges: true,
    });

    const stagedOnly = await inspectGitDiff(repo, 'reverted.txt', 'staged', executable, pathEnv);
    expect(stagedOnly._tag).toBe('Available');
    if (stagedOnly._tag === 'Available') {
      expect(stagedOnly.preview._tag).toBe('Patch');
    }
  }, 20_000);

  it('handles unborn branches, detached HEAD, branch switches, non-Git, missing-Git, and corrupt/unsupported repos', async () => {
    const unborn = await createTempDir();
    await initRepo(unborn, 'trunk');
    await writeFile(path.join(unborn, 'staged.txt'), 'first\n');
    await runGitCmd(unborn, ['add', '--', 'staged.txt']);
    await writeFile(path.join(unborn, 'staged.txt'), 'first\nsecond\n');
    await writeFile(path.join(unborn, 'loose.txt'), 'untracked\n');

    const { executable, pathEnv } = await resolveSystemGit();

    // Missing Git
    const missingGitRes = await callTyped<WorkerGitStatusResult>({
      id: 1,
      method: 'git.status',
      folder: unborn,
      gitExecutable: null,
      pathEnv: '',
    });
    expect(missingGitRes._tag).toBe('MissingGit');

    // Non-Git
    const nonGit = await createTempDir();
    const nonGitRes = await callTyped<WorkerGitStatusResult>({
      id: 2,
      method: 'git.status',
      folder: nonGit,
      gitExecutable: executable,
      pathEnv,
    });
    expect(nonGitRes._tag).toBe('NonGit');

    // Unborn branch status, diff, and commits
    const unbornStatus = await callTyped<WorkerGitStatusResult>({
      id: 3,
      method: 'git.status',
      folder: unborn,
      gitExecutable: executable,
      pathEnv,
    });
    expect(unbornStatus._tag).toBe('Available');
    if (unbornStatus._tag !== 'Available') return;
    expect(unbornStatus.head).toMatchObject({ _tag: 'Unborn', branch: 'trunk' });
    expect(unbornStatus.files).toHaveLength(2);

    const unbornDiff = await callTyped<WorkerDiffResult>({
      id: 4,
      method: 'git.diff',
      folder: unborn,
      path: 'staged.txt',
      scope: 'combined',
      gitExecutable: executable,
      pathEnv,
    });
    expect(unbornDiff._tag).toBe('Available');
    if (unbornDiff._tag !== 'Available' || unbornDiff.preview._tag !== 'Patch') return;
    expect(unbornDiff.preview.additions).toBe(2);

    const unbornCommits = await callTyped<WorkerCommitsResult>({
      id: 5,
      method: 'git.commits',
      folder: unborn,
      limit: 20,
      offset: 0,
      gitExecutable: executable,
      pathEnv,
    });
    expect(unbornCommits).toMatchObject({ _tag: 'Unborn', branch: 'trunk' });

    // Commit, switch branch, detach HEAD
    await runGitCmd(unborn, ['add', '-A']);
    await runGitCmd(unborn, ['commit', '-m', 'root commit']);
    await runGitCmd(unborn, ['checkout', '-b', 'feature/x']);
    const headSha = await commitFile(unborn, 'feature.txt', 'feat\n', 'feature commit');

    const branchStatus = await callTyped<WorkerGitStatusResult>({
      id: 6,
      method: 'git.status',
      folder: unborn,
      gitExecutable: executable,
      pathEnv,
    });
    expect(branchStatus._tag).toBe('Available');
    if (branchStatus._tag !== 'Available') return;
    expect(branchStatus.head).toMatchObject({
      _tag: 'Branch',
      branch: 'feature/x',
      commit: headSha,
    });

    await runGitCmd(unborn, ['checkout', '--detach', 'HEAD~1']);
    const detachedSha = await runGitCmd(unborn, ['rev-parse', 'HEAD']);
    const detachedStatus = await callTyped<WorkerGitStatusResult>({
      id: 7,
      method: 'git.status',
      folder: unborn,
      gitExecutable: executable,
      pathEnv,
    });
    expect(detachedStatus._tag).toBe('Available');
    if (detachedStatus._tag !== 'Available') return;
    expect(detachedStatus.head).toMatchObject({
      _tag: 'Detached',
      commit: detachedSha,
    });

    // Corrupt index -> UnsupportedRepo
    await writeFile(path.join(unborn, '.git', 'index'), 'not-a-valid-git-index');
    const corruptStatus = await callTyped<WorkerGitStatusResult>({
      id: 8,
      method: 'git.status',
      folder: unborn,
      gitExecutable: executable,
      pathEnv,
    });
    expect(corruptStatus._tag).toBe('UnsupportedRepo');
  }, 20_000);

  it('discloses binary files, oversized files, nested git repos, symlinks, deterministic instability, and refuses path traversal', async () => {
    const repo = await createTempDir();
    await initRepo(repo);
    await commitFile(repo, 'tracked-bin.bin', new Uint8Array([0, 1, 2, 3, 0xff]), 'binary commit');

    // Untracked binary
    await writeFile(
      path.join(repo, 'image.png'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 1]),
    );

    // Untracked oversized (> 2 MiB)
    await writeFile(path.join(repo, 'huge.txt'), 'x'.repeat(2 * 1024 * 1024 + 64));

    // Untracked regular file for deterministic instability verification
    await writeFile(path.join(repo, 'changing.txt'), 'v0\n');

    // Nested git repo directory should be excluded rather than descended into
    const nestedRepo = path.join(repo, 'sub-repo');
    await mkdir(nestedRepo, { recursive: true });
    await initRepo(nestedRepo);
    await writeFile(path.join(nestedRepo, 'secret.txt'), 'do not include');

    // Optional symlink check (skip fixture creation only if host OS denies symlink privileges)
    const outsideTarget = path.join(await createTempDir(), 'outside.txt');
    await writeFile(outsideTarget, 'outside secret');
    let symlinkCreated = false;
    try {
      await symlink(outsideTarget, path.join(repo, 'link.txt'), 'file');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }

    const { executable, pathEnv } = await resolveSystemGit();
    const status = await inspectGitStatus(repo, executable, pathEnv);
    expect(status._tag).toBe('Available');
    if (status._tag !== 'Available') return;

    expect(status.incompleteDiffCounts).toBe(true);
    const byPath = new Map(status.files.map((f) => [f.path, f]));
    expect(byPath.get('image.png')).toMatchObject({
      kind: 'Binary',
      additions: null,
      deletions: null,
    });
    expect(byPath.get('huge.txt')).toMatchObject({
      kind: 'TooLarge',
      additions: null,
      deletions: null,
    });
    expect(byPath.has('sub-repo/secret.txt')).toBe(false);
    expect(status.excludedEntries.some((e) => e.reason === 'NestedRepo')).toBe(true);
    if (symlinkCreated) {
      expect(byPath.get('link.txt')).toMatchObject({
        kind: 'Symlink',
        additions: null,
        deletions: null,
      });
    }

    // Binary and oversized diffs return explicit Unavailable previews
    const binDiff = await inspectGitDiff(repo, 'image.png', 'combined', executable, pathEnv);
    expect(binDiff._tag).toBe('Available');
    if (binDiff._tag === 'Available') {
      expect(binDiff.preview).toMatchObject({ _tag: 'Unavailable', reason: 'Binary' });
    }

    const hugeDiff = await inspectGitDiff(repo, 'huge.txt', 'combined', executable, pathEnv);
    expect(hugeDiff._tag).toBe('Available');
    if (hugeDiff._tag === 'Available') {
      expect(hugeDiff.preview).toMatchObject({ _tag: 'Unavailable', reason: 'TooLarge' });
    }

    // Tracked binary modification
    await writeFile(path.join(repo, 'tracked-bin.bin'), new Uint8Array([0, 9, 8, 7]));
    const trackedBinDiff = await inspectGitDiff(
      repo,
      'tracked-bin.bin',
      'combined',
      executable,
      pathEnv,
    );
    expect(trackedBinDiff._tag).toBe('Available');
    if (trackedBinDiff._tag === 'Available') {
      expect(trackedBinDiff.preview).toMatchObject({ _tag: 'Unavailable', reason: 'Binary' });
    }

    // Traversal & .git path refusal
    for (const unsafePath of ['../outside.txt', '.git/config', '/etc/passwd']) {
      const badDiff = await inspectGitDiff(repo, unsafePath, 'combined', executable, pathEnv);
      expect(badDiff._tag).toBe('InvalidPath');
    }

    // Deterministic instability disclosure when file mutates on both read attempts
    let step = 0;
    const unstableStatus = await inspectGitStatus(repo, executable, pathEnv, {
      onBeforeVerifyStability: async (relPath) => {
        if (relPath !== 'changing.txt') return;
        step += 1;
        await writeFile(path.join(repo, 'changing.txt'), `${'v'.repeat(step + 3)}\n`);
      },
    });
    expect(unstableStatus._tag).toBe('Available');
    if (unstableStatus._tag === 'Available') {
      expect(unstableStatus.unstablePaths).toContain('changing.txt');
      expect(unstableStatus.instabilityDetail).toContain('changing.txt');
      expect(unstableStatus.files.find((f) => f.path === 'changing.txt')?.unstable).toBe(true);
    }

    const unstableDiff = await inspectGitDiff(
      repo,
      'changing.txt',
      'combined',
      executable,
      pathEnv,
      {
        onBeforeVerifyStability: async (relPath, attempt) => {
          if (relPath !== 'changing.txt') return;
          await writeFile(
            path.join(repo, 'changing.txt'),
            `diff-drift-${String(attempt)}-${'x'.repeat(attempt)}\n`,
          );
        },
      },
    );
    expect(unstableDiff._tag).toBe('Available');
    if (unstableDiff._tag === 'Available') {
      expect(unstableDiff.preview.unstable).toBe(true);
      expect(unstableDiff.preview.instabilityDetail).toContain('changing.txt');
    }
  }, 20_000);

  it('lists commit history with pagination and inspects root, normal, and merge commits cleanly', async () => {
    const repo = await createTempDir();
    await initRepo(repo, 'main');
    const rootSha = await commitFile(repo, 'a.txt', 'root 1\nroot 2\n', 'root commit');

    await runGitCmd(repo, ['checkout', '-b', 'side']);
    await commitFile(repo, 'side.txt', 'side branch line\n', 'side commit');

    await runGitCmd(repo, ['checkout', 'main']);
    await commitFile(repo, 'a.txt', 'root 1\nroot 2 updated\n', 'main commit');
    await runGitCmd(repo, ['merge', '--no-ff', 'side', '-m', 'merge side into main']);
    const mergeSha = await runGitCmd(repo, ['rev-parse', 'HEAD']);

    const { executable, pathEnv } = await resolveSystemGit();

    // First page (limit 2) via worker dispatcher
    const page1 = await callTyped<WorkerCommitsResult>({
      id: 1,
      method: 'git.commits',
      folder: repo,
      limit: 2,
      offset: 0,
      gitExecutable: executable,
      pathEnv,
    });
    expect(page1._tag).toBe('History');
    if (page1._tag !== 'History') return;
    expect(page1.commits).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.commits[0]).toMatchObject({
      sha: mergeSha,
      isMerge: true,
      subject: 'merge side into main',
    });

    // Second page (limit 2, offset 2)
    const page2 = await listGitCommits(repo, 2, 2, executable, pathEnv);
    expect(page2._tag).toBe('History');
    if (page2._tag !== 'History') return;
    expect(page2.commits).toHaveLength(2);
    expect(page2.hasMore).toBe(false);

    // Root commit detail & file diff via worker dispatcher
    const rootDetail = await callTyped<WorkerCommitDetailResult>({
      id: 3,
      method: 'git.commitDetail',
      folder: repo,
      sha: rootSha,
      gitExecutable: executable,
      pathEnv,
    });
    expect(rootDetail._tag).toBe('Commit');
    if (rootDetail._tag !== 'Commit') return;
    expect(rootDetail.commit.isMerge).toBe(false);
    expect(rootDetail.files).toEqual([
      {
        path: 'a.txt',
        status: 'Added',
        additions: 2,
        deletions: 0,
        binary: false,
      },
    ]);

    const rootFileDiff = await callTyped<WorkerCommitFileDiffResult>({
      id: 4,
      method: 'git.commitFileDiff',
      folder: repo,
      sha: rootSha,
      path: 'a.txt',
      gitExecutable: executable,
      pathEnv,
    });
    expect(rootFileDiff._tag).toBe('Available');
    if (rootFileDiff._tag !== 'Available') return;
    expect(rootFileDiff.preview._tag).toBe('Patch');

    // Merge commit detail uses first-parent diff cleanly
    const mergeDetail = await inspectCommitDetail(repo, mergeSha, executable, pathEnv);
    expect(mergeDetail._tag).toBe('Commit');
    if (mergeDetail._tag !== 'Commit') return;
    expect(mergeDetail.commit.isMerge).toBe(true);
    expect(mergeDetail.files.map((f) => f.path)).toEqual(['side.txt']);

    // Commit file diff directly on merge commit
    const mergeFileDiff = await inspectCommitFileDiff(
      repo,
      mergeSha,
      'side.txt',
      executable,
      pathEnv,
    );
    expect(mergeFileDiff._tag).toBe('Available');
    if (mergeFileDiff._tag === 'Available') {
      expect(mergeFileDiff.preview._tag).toBe('Patch');
    }

    // Invalid SHA rejected cleanly
    const invalidSha = await inspectCommitDetail(repo, 'not-a-sha!', executable, pathEnv);
    expect(invalidSha._tag).toBe('InvalidCommit');
  }, 20_000);
});
