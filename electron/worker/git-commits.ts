import { parseUnifiedDiff } from './git-diff-parser';
import {
  MAX_COMMIT_FILES,
  MAX_PREVIEW_BYTES,
  isMaxBufferError,
  resolveEmptyTreeSha,
  resolveWorktreeContext,
  runGit,
  validateRepoRelativePath,
  type GitWorktreeContext,
} from './git-exec';
import { parseNumstatZ } from './git-status-diff';
import type {
  WorkerCommitChangedFile,
  WorkerCommitDetailResult,
  WorkerCommitFileDiffResult,
  WorkerCommitSummary,
  WorkerCommitsResult,
  WorkerDiffPreview,
  WorkerHeadState,
} from './worker-protocol';

const COMMIT_SHA_RE = /^[0-9a-f]{4,64}$/i;
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

const verifyCommitSha = async (
  ctx: GitWorktreeContext,
  pathEnv: string,
  sha: string,
): Promise<
  | { readonly ok: true; readonly commitSha: string }
  | { readonly ok: false; readonly detail: string }
> => {
  if (!COMMIT_SHA_RE.test(sha)) {
    return { ok: false, detail: `Invalid commit hash "${sha}".` };
  }
  const verifyRes = await runGit(
    ctx.executable,
    ['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!verifyRes.ok) {
    return {
      ok: false,
      detail: verifyRes.stderr.trim() || `Commit "${sha}" could not be resolved.`,
    };
  }
  const resolved = verifyRes.stdout.trim();
  if (!COMMIT_SHA_RE.test(resolved)) {
    return { ok: false, detail: `Unexpected commit identifier resolved for "${sha}".` };
  }
  return { ok: true, commitSha: resolved };
};

interface RawCommitNameStatus {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: WorkerCommitChangedFile['status'];
}

const parseNameStatusZ = (stdout: string): ReadonlyArray<RawCommitNameStatus> => {
  const tokens = stdout.split('\0');
  const results: RawCommitNameStatus[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (code === undefined || code === '') continue;

    if (code.startsWith('R') || code.startsWith('C')) {
      const previousPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath.length > 0) {
        results.push({
          path: newPath,
          ...(previousPath.length > 0 ? { previousPath } : {}),
          status: code.startsWith('R') ? 'Renamed' : 'Copied',
        });
      }
      continue;
    }

    const filePath = tokens[i + 1] ?? '';
    i += 1;
    if (filePath.length === 0) continue;

    let status: WorkerCommitChangedFile['status'] = 'Modified';
    if (code === 'A') status = 'Added';
    else if (code === 'D') status = 'Deleted';
    else if (code === 'T') status = 'TypeChanged';
    results.push({ path: filePath, status });
  }

  return results;
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
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: logRes.stderr.trim() || 'Failed to read Git commit history.',
    };
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

export const inspectCommitDetail = async (
  folder: string,
  sha: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorkerCommitDetailResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;

  const verified = await verifyCommitSha(ctx, pathEnv, sha);
  if (!verified.ok) {
    return { _tag: 'InvalidCommit', sha, detail: verified.detail };
  }

  const metaRes = await runGit(
    ctx.executable,
    ['-c', 'core.quotepath=false', 'log', '-n', '1', '-z', COMMIT_LOG_FORMAT, verified.commitSha],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!metaRes.ok) {
    return {
      _tag: 'InvalidCommit',
      sha,
      detail: metaRes.stderr.trim() || `Unable to inspect commit "${sha}".`,
    };
  }
  const commit = parseCommitRecord(metaRes.stdout.split('\0')[0] ?? '');
  if (commit === null) {
    return {
      _tag: 'InvalidCommit',
      sha,
      detail: `Commit metadata could not be parsed for "${sha}".`,
    };
  }

  const firstParent = commit.parentShas[0];
  const buildCommitDiffArgs = (statFlag: '--name-status' | '--numstat'): ReadonlyArray<string> =>
    firstParent === undefined
      ? [
          '-c',
          'core.quotepath=false',
          'diff-tree',
          '--no-commit-id',
          '-r',
          '--root',
          '-z',
          statFlag,
          commit.sha,
        ]
      : [
          '-c',
          'core.quotepath=false',
          'diff',
          '--no-ext-diff',
          '-z',
          statFlag,
          firstParent,
          commit.sha,
        ];

  const [nameStatusRes, numstatRes] = await Promise.all([
    runGit(ctx.executable, buildCommitDiffArgs('--name-status'), ctx.toplevelRealPath, pathEnv),
    runGit(ctx.executable, buildCommitDiffArgs('--numstat'), ctx.toplevelRealPath, pathEnv),
  ]);

  if (!nameStatusRes.ok) {
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: nameStatusRes.stderr.trim() || `Unable to list changed files for commit "${sha}".`,
    };
  }

  const parsedEntries = parseNameStatusZ(nameStatusRes.stdout);
  const numstats = numstatRes.ok ? parseNumstatZ(numstatRes.stdout) : new Map();

  const truncatedFiles = parsedEntries.length > MAX_COMMIT_FILES;
  const boundedEntries = parsedEntries.slice(0, MAX_COMMIT_FILES);
  const files: WorkerCommitChangedFile[] = boundedEntries.map((entry) => {
    const stat = numstats.get(entry.path);
    return {
      path: entry.path,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status: entry.status,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
      binary: stat?.binary ?? false,
    };
  });

  return {
    _tag: 'Commit',
    commit,
    files,
    truncatedFiles,
  };
};

const checkRevisionBlobTooLarge = async (
  ctx: GitWorktreeContext,
  pathEnv: string,
  revision: string,
  relPath: string,
): Promise<number | null> => {
  const res = await runGit(
    ctx.executable,
    ['cat-file', '-s', `${revision}:${relPath}`],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!res.ok) return null;
  const size = Number(res.stdout.trim());
  return Number.isFinite(size) && size > MAX_PREVIEW_BYTES ? size : null;
};

export const inspectCommitFileDiff = async (
  folder: string,
  sha: string,
  relPath: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorkerCommitFileDiffResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;

  const verified = await verifyCommitSha(ctx, pathEnv, sha);
  if (!verified.ok) {
    return { _tag: 'InvalidCommit', sha, detail: verified.detail };
  }

  const valid = await validateRepoRelativePath(ctx.toplevelRealPath, relPath, {
    checkFilesystem: false,
  });
  if (!valid.ok) {
    return { _tag: 'InvalidPath', path: relPath, detail: valid.detail };
  }

  const metaRes = await runGit(
    ctx.executable,
    ['-c', 'core.quotepath=false', 'log', '-n', '1', '-z', COMMIT_LOG_FORMAT, verified.commitSha],
    ctx.toplevelRealPath,
    pathEnv,
  );
  const commit = metaRes.ok ? parseCommitRecord(metaRes.stdout.split('\0')[0] ?? '') : null;
  if (commit === null) {
    return { _tag: 'InvalidCommit', sha, detail: `Unable to read commit "${sha}".` };
  }

  const firstParent = commit.parentShas[0];
  const baseRef =
    firstParent !== undefined
      ? firstParent
      : await resolveEmptyTreeSha(ctx.executable, ctx.toplevelRealPath, pathEnv);
  if (baseRef === null) {
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: 'Unable to compute empty Git tree for root commit diff.',
    };
  }

  const targetBlobTooBig = await checkRevisionBlobTooLarge(
    ctx,
    pathEnv,
    commit.sha,
    valid.normalized,
  );
  const baseBlobTooBig =
    firstParent !== undefined
      ? await checkRevisionBlobTooLarge(ctx, pathEnv, firstParent, valid.normalized)
      : null;
  const tooBig = targetBlobTooBig ?? baseBlobTooBig;
  if (tooBig !== null) {
    return {
      _tag: 'Available',
      preview: {
        _tag: 'Unavailable',
        path: valid.normalized,
        scope: 'combined',
        reason: 'TooLarge',
        detail: `Commit blob exceeds the ${String(MAX_PREVIEW_BYTES)} byte inline preview limit.`,
        byteSize: tooBig,
        limitBytes: MAX_PREVIEW_BYTES,
        unstable: false,
      },
    };
  }

  const diffRes = await runGit(
    ctx.executable,
    [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-U3',
      baseRef,
      commit.sha,
      '--',
      valid.normalized,
    ],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!diffRes.ok) {
    if (isMaxBufferError(diffRes)) {
      return {
        _tag: 'Available',
        preview: {
          _tag: 'Unavailable',
          path: valid.normalized,
          scope: 'combined',
          reason: 'TooLarge',
          detail: 'Commit file diff exceeded preview buffer limit.',
          limitBytes: MAX_PREVIEW_BYTES,
          unstable: false,
        },
      };
    }
    return {
      _tag: 'Available',
      preview: {
        _tag: 'Unavailable',
        path: valid.normalized,
        scope: 'combined',
        reason: 'Unreadable',
        detail: diffRes.stderr.trim() || 'Git diff failed for commit file.',
        unstable: false,
      },
    };
  }

  const parsed = parseUnifiedDiff(diffRes.stdout);
  if (parsed.isBinary) {
    return {
      _tag: 'Available',
      preview: {
        _tag: 'Unavailable',
        path: valid.normalized,
        scope: 'combined',
        reason: 'Binary',
        detail: 'Binary file changes cannot be displayed as an inline text diff.',
        unstable: false,
      },
    };
  }

  if (parsed.hunks.length === 0 && diffRes.stdout.trim().length === 0) {
    return {
      _tag: 'Available',
      preview: {
        _tag: 'Unavailable',
        path: valid.normalized,
        scope: 'combined',
        reason: 'NoDifference',
        detail: 'Selected file has no difference in this commit.',
        unstable: false,
      },
    };
  }

  const preview: WorkerDiffPreview = {
    _tag: 'Patch',
    path: valid.normalized,
    ...(parsed.previousPath === undefined ? {} : { previousPath: parsed.previousPath }),
    scope: 'combined',
    hunks: parsed.hunks,
    additions: parsed.additions,
    deletions: parsed.deletions,
    truncated: parsed.truncated,
    ...(parsed.truncationDetail === undefined
      ? {}
      : { truncationDetail: parsed.truncationDetail }),
    unstable: false,
  };
  return { _tag: 'Available', preview };
};
