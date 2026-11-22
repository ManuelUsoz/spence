import { parseUnifiedDiff } from './git-diff-parser';
import {
  MAX_COMMIT_FILES,
  gitFailure,
  isMaxBufferError,
  resolveEmptyTreeSha,
  resolveWorktreeContext,
  runGit,
  validateRepoRelativePath,
  type GitWorktreeContext,
} from './git-exec';
import type {
  WorkerCapabilityFailure,
  WorkerCommitDetailResult,
  WorkerCommitFile,
  WorkerCommitSummary,
  WorkerCommitsResult,
  WorkerDiffResult,
  WorkerFileChangeStatus,
  WorkerHeadState,
} from './worker-protocol';

const COMMIT_LOG_FORMAT = '--format=%H%x1f%h%x1f%P%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%at%x1f%D';

const parseCommitRecord = (record: string): WorkerCommitSummary | null => {
  if (record.length === 0) return null;
  const parts = record.split('\x1f');
  const sha = parts[0] ?? '';
  if (sha.length === 0) return null;
  const shortSha = parts[1] ?? sha.slice(0, 7);
  const parentsRaw = parts[2] ?? '';
  const parentShas = parentsRaw
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0);
  const subject = parts[3] ?? '';
  const body = (parts[4] ?? '').replace(/\s+$/, '');
  const authorName = parts[5] ?? '';
  const authorEmail = parts[6] ?? '';
  const authoredAtSeconds = Number(parts[7] ?? '0');
  const refsRaw = parts[8] ?? '';
  const refs = refsRaw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return {
    sha,
    shortSha,
    parentShas,
    isMerge: parentShas.length > 1,
    subject,
    body,
    authorName,
    authorEmail,
    authoredAtSeconds: Number.isFinite(authoredAtSeconds) ? authoredAtSeconds : 0,
    refs,
  };
};

const resolveHeadForCommits = async (
  ctx: GitWorktreeContext,
  pathEnv: string,
): Promise<WorkerHeadState> => {
  const symRes = await runGit(
    ctx.executable,
    ['symbolic-ref', '--short', '-q', 'HEAD'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  const headRes = await runGit(
    ctx.executable,
    ['rev-parse', '--verify', '-q', 'HEAD'],
    ctx.toplevelRealPath,
    pathEnv,
  );

  if (symRes.ok && symRes.stdout.trim().length > 0) {
    const branch = symRes.stdout.trim();
    const ref = `refs/heads/${branch}`;
    if (!headRes.ok || headRes.stdout.trim().length === 0) {
      return { _tag: 'Unborn', branch, ref };
    }
    return {
      _tag: 'Branch',
      branch,
      ref,
      commit: headRes.stdout.trim(),
    };
  }

  if (!headRes.ok || headRes.stdout.trim().length === 0) {
    return { _tag: 'Unborn', branch: 'HEAD', ref: 'HEAD' };
  }
  return {
    _tag: 'Detached',
    commit: headRes.stdout.trim(),
  };
};

export const listGitCommits = async (
  folder: string,
  limit: number,
  offset: number,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorkerCommitsResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;

  const head = await resolveHeadForCommits(ctx, pathEnv);
  if (head._tag === 'Unborn') {
    return {
      _tag: 'Unborn',
      branch: head.branch,
      ref: head.ref,
    };
  }

  const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const safeOffset = Math.max(0, Math.trunc(offset));
  const logRes = await runGit(
    ctx.executable,
    [
      '-c',
      'core.quotepath=false',
      'log',
      '-n',
      String(safeLimit + 1),
      `--skip=${String(safeOffset)}`,
      '-z',
      COMMIT_LOG_FORMAT,
      'HEAD',
    ],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!logRes.ok) {
    return gitFailure(folder, logRes, 'Failed to read Git commit history.');
  }

  const records = logRes.stdout
    .split('\0')
    .map(parseCommitRecord)
    .filter((item): item is WorkerCommitSummary => item !== null);
  const hasMore = records.length > safeLimit;
  const commits = records.slice(0, safeLimit);

  return {
    _tag: 'History',
    head,
    commits,
    hasMore,
    ...(hasMore ? { nextOffset: safeOffset + commits.length } : {}),
  };
};

const COMMIT_SHA = /^[0-9a-f]{7,40}$/;

type ResolvedCommit =
  | { readonly ok: true; readonly sha: string; readonly base: string }
  | { readonly ok: false; readonly detail: string };

/** A commit reachable from HEAD, and what it is compared against: its first parent, or the empty tree for a root. */
const resolveCommit = async (
  ctx: GitWorktreeContext,
  sha: string,
  pathEnv: string,
): Promise<ResolvedCommit | WorkerCapabilityFailure> => {
  const git = (args: ReadonlyArray<string>) =>
    runGit(ctx.executable, args, ctx.toplevelRealPath, pathEnv);
  if (!COMMIT_SHA.test(sha)) return { ok: false, detail: 'That is not a commit id.' };
  const resolved = await git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  const full = resolved.stdout.trim();
  if (!resolved.ok || full.length === 0) return { ok: false, detail: 'No such commit.' };
  if (!(await git(['merge-base', '--is-ancestor', full, 'HEAD'])).ok) {
    return { ok: false, detail: 'That commit is not part of the current branch.' };
  }
  const parents = await git(['rev-list', '--parents', '-n', '1', full]);
  if (!parents.ok) return gitFailure(ctx.toplevelRealPath, parents, 'Failed to read the commit.');
  const parent = parents.stdout.trim().split(/\s+/)[1];
  if (parent !== undefined) return { ok: true, sha: full, base: parent };
  const empty = await resolveEmptyTreeSha(ctx.executable, ctx.toplevelRealPath, pathEnv);
  if (empty === null) {
    return gitFailure(
      ctx.toplevelRealPath,
      { ok: false, stdout: '', stderr: '' },
      'Unable to compute the empty Git tree.',
    );
  }
  return { ok: true, sha: full, base: empty };
};

const STATUS_BY_LETTER: Readonly<Record<string, WorkerFileChangeStatus>> = {
  A: 'Added',
  M: 'Modified',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'TypeChanged',
  U: 'Conflicted',
};

/** Parses `git diff --name-status -z` into paths and statuses, in order. */
const parseNameStatus = (stdout: string) => {
  const tokens = stdout.split('\0');
  const entries: Array<{
    readonly path: string;
    readonly previousPath?: string;
    readonly status: WorkerFileChangeStatus;
  }> = [];
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i] ?? '';
    if (code.length === 0) break;
    const status = STATUS_BY_LETTER[code.charAt(0)] ?? 'Modified';
    if (code.startsWith('R') || code.startsWith('C')) {
      entries.push({ path: tokens[i + 2] ?? '', previousPath: tokens[i + 1] ?? '', status });
      i += 3;
    } else {
      entries.push({ path: tokens[i + 1] ?? '', status });
      i += 2;
    }
  }
  return entries;
};

/** Parses `git diff --numstat -z` into counts keyed by the new path; `null` for binary files. */
const parseNumstat = (stdout: string) => {
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i] ?? '');
    if (match === null) continue;
    const additions = match[1] === '-' ? null : Number(match[1]);
    const deletions = match[2] === '-' ? null : Number(match[2]);
    let path = match[3] ?? '';
    if (path.length === 0) {
      // A rename or copy: the old and new paths follow as separate records.
      path = tokens[i + 2] ?? '';
      i += 2;
    }
    counts.set(path, { additions, deletions });
  }
  return counts;
};

/** The metadata and changed files of one commit of the branch, against its first parent. */
export const getCommitDetail = async (
  folder: string,
  sha: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorkerCommitDetailResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const resolved = await resolveCommit(ctx, sha, pathEnv);
  if (!('ok' in resolved)) return resolved;
  if (!resolved.ok) return { _tag: 'UnknownCommit', detail: resolved.detail };

  const git = (args: ReadonlyArray<string>) =>
    runGit(ctx.executable, args, ctx.toplevelRealPath, pathEnv);
  const diffArgs = (flag: string) => [
    '-c',
    'core.quotepath=false',
    'diff',
    '--no-ext-diff',
    flag,
    '-M',
    '-z',
    resolved.base,
    resolved.sha,
  ];
  const [meta, names, numbers] = await Promise.all([
    git(['show', '-s', '-z', COMMIT_LOG_FORMAT, resolved.sha]),
    git(diffArgs('--name-status')),
    git(diffArgs('--numstat')),
  ]);
  const failed = [meta, names, numbers].find((result) => !result.ok);
  if (failed !== undefined) return gitFailure(folder, failed, 'Failed to read the commit.');
  const summary = parseCommitRecord(meta.stdout.split('\0')[0] ?? '');
  if (summary === null) return gitFailure(folder, meta, 'Failed to read the commit.');

  const counts = parseNumstat(numbers.stdout);
  const files: ReadonlyArray<WorkerCommitFile> = parseNameStatus(names.stdout)
    .slice(0, MAX_COMMIT_FILES)
    .map((entry) => ({
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status: entry.status,
      additions: counts.get(entry.path)?.additions ?? null,
      deletions: counts.get(entry.path)?.deletions ?? null,
    }));
  return { _tag: 'Detail', commit: { ...summary, files } };
};

/** The diff of one file in one commit, against its first parent. */
export const getCommitFileDiff = async (
  folder: string,
  sha: string,
  relPath: string,
  gitExecutable: string | null,
  pathEnv: string,
  previousPath?: string,
): Promise<WorkerDiffResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;
  const valid = await validateRepoRelativePath(ctx.toplevelRealPath, relPath, {
    checkFilesystem: false,
  });
  if (!valid.ok) return { _tag: 'InvalidPath', path: relPath, detail: valid.detail };
  let previous: string | undefined;
  if (previousPath !== undefined) {
    const checked = await validateRepoRelativePath(ctx.toplevelRealPath, previousPath, {
      checkFilesystem: false,
    });
    if (!checked.ok) return { _tag: 'InvalidPath', path: previousPath, detail: checked.detail };
    previous = checked.normalized;
  }
  const resolved = await resolveCommit(ctx, sha, pathEnv);
  if (!('ok' in resolved)) return resolved;
  if (!resolved.ok) return { _tag: 'InvalidPath', path: relPath, detail: resolved.detail };

  const unavailable = (
    reason: 'Binary' | 'TooLarge' | 'Unreadable' | 'NoDifference',
    detail: string,
  ): WorkerDiffResult => ({
    _tag: 'Available',
    preview: {
      _tag: 'Unavailable',
      path: valid.normalized,
      scope: 'combined',
      reason,
      detail,
      unstable: false,
    },
  });

  const diffRes = await runGit(
    ctx.executable,
    [
      '--literal-pathspecs',
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-U3',
      '-M',
      resolved.base,
      resolved.sha,
      '--',
      valid.normalized,
      ...(previous === undefined ? [] : [previous]),
    ],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!diffRes.ok) {
    return isMaxBufferError(diffRes)
      ? unavailable('TooLarge', 'Diff output exceeded preview buffer cap.')
      : unavailable('Unreadable', diffRes.stderr.trim() || 'Git diff failed for target path.');
  }
  const parsed = parseUnifiedDiff(diffRes.stdout);
  if (parsed.isBinary) {
    return unavailable('Binary', 'Binary file changes cannot be displayed as an inline text diff.');
  }
  if (parsed.hunks.length === 0) {
    return unavailable('NoDifference', 'No textual differences found in this commit.');
  }
  const previousOut = previous ?? parsed.previousPath;
  return {
    _tag: 'Available',
    preview: {
      _tag: 'Patch',
      path: valid.normalized,
      ...(previousOut === undefined ? {} : { previousPath: previousOut }),
      scope: 'combined',
      hunks: parsed.hunks,
      additions: parsed.additions,
      deletions: parsed.deletions,
      truncated: parsed.truncated,
      ...(parsed.truncationDetail === undefined
        ? {}
        : { truncationDetail: parsed.truncationDetail }),
      unstable: false,
    },
  };
};
