import { gitFailure, resolveWorktreeContext, runGit, type GitWorktreeContext } from './git-exec';
import type { WorkerCommitSummary, WorkerCommitsResult, WorkerHeadState } from './worker-protocol';

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
