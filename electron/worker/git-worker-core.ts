import path from 'node:path';
import { inspectCommitDetail, inspectCommitFileDiff, listGitCommits } from './git-commits';
import {
  dirIdentityOrNull,
  isDirectory,
  isNotGitRepoOutput,
  isUnsupportedRepoOutput,
  parseGitVersion,
  realPathOrNull,
  runGit,
} from './git-exec';
import { inspectGitDiff, inspectGitStatus } from './git-status-diff';
import type {
  GitProbeResult,
  RawWorktreeChangeSummary,
  RawWorktreeRecord,
  WorkerRequest,
  WorkerResponse,
} from './worker-protocol';

interface MutableWorktreeRecord {
  rawPath: string;
  headCommit?: string;
  branch?: string;
  branchRef?: string;
  detached: boolean;
  bare: boolean;
  prunableReason?: string;
  lockedReason?: string;
}

const resolveExistingOrParentPath = async (
  target: string,
): Promise<{
  readonly realPath: string | null;
  readonly normalizedPath: string;
}> => {
  const realPath = await realPathOrNull(target);
  if (realPath !== null) {
    return { realPath, normalizedPath: realPath };
  }
  const parentReal = await realPathOrNull(path.dirname(target));
  const normalizedPath =
    parentReal !== null ? path.join(parentReal, path.basename(target)) : path.resolve(target);
  return { realPath: null, normalizedPath };
};

const NUMSTAT_LINE = /^(\d+)\t(\d+)\t/;

const parseStatusCounts = (
  stdout: string,
): {
  readonly changedFiles: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
} => {
  let changedFiles = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  const tokens = stdout.split('\0');
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++] ?? '';
    if (token.length === 0) continue;
    if (token.startsWith('1 ')) {
      changedFiles += 1;
      if (token[2] !== '.') staged += 1;
      if (token[3] !== '.') unstaged += 1;
    } else if (token.startsWith('2 ')) {
      changedFiles += 1;
      if (token[2] !== '.') staged += 1;
      if (token[3] !== '.') unstaged += 1;
      index += 1;
    } else if (token.startsWith('u ')) {
      changedFiles += 1;
      unstaged += 1;
    } else if (token.startsWith('? ')) {
      changedFiles += 1;
      untracked += 1;
    }
  }
  return { changedFiles, staged, unstaged, untracked };
};

const sumNumstat = (stdout: string): { readonly additions: number; readonly deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const token of stdout.split('\0')) {
    const match = NUMSTAT_LINE.exec(token);
    if (match === null) continue;
    additions += Number(match[1]);
    deletions += Number(match[2]);
  }
  return { additions, deletions };
};

const probeWorktreeChanges = async (
  gitExecutable: string,
  folderPath: string,
  pathEnv: string,
): Promise<RawWorktreeChangeSummary | undefined> => {
  const [statusRes, unstagedDiffRes, stagedDiffRes] = await Promise.all([
    runGit(gitExecutable, ['status', '--porcelain=v2', '-z'], folderPath, pathEnv),
    runGit(gitExecutable, ['diff', '--numstat', '-z'], folderPath, pathEnv),
    runGit(gitExecutable, ['diff', '--cached', '--numstat', '-z'], folderPath, pathEnv),
  ]);
  if (!statusRes.ok) return undefined;
  const counts = parseStatusCounts(statusRes.stdout);
  const unstaged = unstagedDiffRes.ok
    ? sumNumstat(unstagedDiffRes.stdout)
    : { additions: 0, deletions: 0 };
  const staged = stagedDiffRes.ok
    ? sumNumstat(stagedDiffRes.stdout)
    : { additions: 0, deletions: 0 };
  return {
    changedFiles: counts.changedFiles,
    staged: counts.staged,
    unstaged: counts.unstaged,
    untracked: counts.untracked,
    additions: unstaged.additions + staged.additions,
    deletions: unstaged.deletions + staged.deletions,
  };
};

const finalizeWorktreeRecord = async (
  record: MutableWorktreeRecord,
  gitExecutable: string,
  pathEnv: string,
): Promise<RawWorktreeRecord> => {
  const { realPath, normalizedPath } = await resolveExistingOrParentPath(record.rawPath);
  const folderIdentity = realPath === null ? null : await dirIdentityOrNull(realPath);
  const changes =
    realPath !== null && !record.bare && record.prunableReason === undefined
      ? await probeWorktreeChanges(gitExecutable, realPath, pathEnv)
      : undefined;
  return {
    rawPath: normalizedPath,
    ...(realPath === null ? {} : { realPath }),
    ...(folderIdentity === null ? {} : { folderIdentity }),
    exists: realPath !== null,
    ...(record.headCommit === undefined ? {} : { headCommit: record.headCommit }),
    ...(record.branch === undefined ? {} : { branch: record.branch }),
    ...(record.branchRef === undefined ? {} : { branchRef: record.branchRef }),
    detached: record.detached,
    bare: record.bare,
    ...(record.prunableReason === undefined ? {} : { prunableReason: record.prunableReason }),
    ...(record.lockedReason === undefined ? {} : { lockedReason: record.lockedReason }),
    ...(changes === undefined ? {} : { changes }),
  };
};

export const parseWorktreePorcelainZ = (stdout: string): ReadonlyArray<MutableWorktreeRecord> => {
  const tokens = stdout.split('\0');
  const records: MutableWorktreeRecord[] = [];
  let current: MutableWorktreeRecord | null = null;

  for (const token of tokens) {
    if (token === '') {
      if (current !== null) {
        records.push(current);
        current = null;
      }
      continue;
    }

    if (token.startsWith('worktree ')) {
      if (current !== null) records.push(current);
      current = {
        rawPath: token.slice('worktree '.length),
        detached: false,
        bare: false,
      };
      continue;
    }

    if (current === null) continue;

    if (token.startsWith('HEAD ')) {
      current.headCommit = token.slice('HEAD '.length);
    } else if (token.startsWith('branch ')) {
      const ref = token.slice('branch '.length);
      current.branchRef = ref;
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (token === 'detached') {
      current.detached = true;
    } else if (token === 'bare') {
      current.bare = true;
    } else if (token === 'prunable') {
      current.prunableReason = 'prunable';
    } else if (token.startsWith('prunable ')) {
      current.prunableReason = token.slice('prunable '.length);
    } else if (token === 'locked') {
      current.lockedReason = 'locked';
    } else if (token.startsWith('locked ')) {
      current.lockedReason = token.slice('locked '.length);
    }
  }

  if (current !== null) records.push(current);
  return records;
};

/** Probes Git capability, canonical repository identity, and worktrees without shell interpolation. */
export const probeGitFolder = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<GitProbeResult> => {
  if (!(await isDirectory(folder))) {
    return {
      _tag: 'MissingPath',
      path: folder,
      detail: `Folder does not exist or is not a directory: ${folder}`,
    };
  }

  if (gitExecutable === null) {
    return {
      _tag: 'MissingGit',
      detail: 'Git executable was not found on PATH.',
    };
  }

  const versionRes = await runGit(gitExecutable, ['--version'], folder, pathEnv);
  if (!versionRes.ok) {
    return {
      _tag: 'MissingGit',
      detail: versionRes.stderr || 'Git failed to execute --version.',
    };
  }
  const gitVersion = parseGitVersion(versionRes.stdout);

  const revParse = await runGit(
    gitExecutable,
    ['rev-parse', '--is-bare-repository', '--is-inside-work-tree', '--git-common-dir', '--git-dir'],
    folder,
    pathEnv,
  );
  if (!revParse.ok) {
    const combined = `${revParse.stderr}\n${revParse.stdout}`.trim();
    if (isUnsupportedRepoOutput(combined)) {
      return {
        _tag: 'UnsupportedRepo',
        path: folder,
        detail: combined || 'Repository format is not supported by the installed Git.',
      };
    }
    if (isNotGitRepoOutput(combined)) {
      return {
        _tag: 'NonGit',
        path: folder,
        detail: combined || `Not a Git repository: ${folder}`,
      };
    }
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: combined || 'Unable to inspect Git repository metadata.',
    };
  }

  const lines = revParse.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const isBare = lines[0] === 'true';
  const isInsideWorkTree = lines[1] === 'true';
  const rawCommonDir = lines[2];
  const rawGitDir = lines[3];

  if (rawCommonDir === undefined || rawGitDir === undefined) {
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: 'Git rev-parse did not report repository directories.',
    };
  }

  const folderRealPath = (await realPathOrNull(folder)) ?? path.resolve(folder);
  const commonDirAbs = path.resolve(folder, rawCommonDir);
  const gitDirAbs = path.resolve(folder, rawGitDir);
  const commonDirRealPath = (await realPathOrNull(commonDirAbs)) ?? commonDirAbs;
  const commonDirIdentity = await dirIdentityOrNull(commonDirRealPath);
  const gitDirRealPath = (await realPathOrNull(gitDirAbs)) ?? gitDirAbs;
  const gitDirIdentity = await dirIdentityOrNull(gitDirRealPath);

  let toplevelRealPath: string | undefined;
  let toplevelFolderIdentity: string | null = null;
  if (isInsideWorkTree && !isBare) {
    const topRes = await runGit(gitExecutable, ['rev-parse', '--show-toplevel'], folder, pathEnv);
    if (!topRes.ok) {
      const combined = `${topRes.stderr}\n${topRes.stdout}`.trim();
      return {
        _tag: isNotGitRepoOutput(combined) ? 'NonGit' : 'UnsupportedRepo',
        path: folder,
        detail: combined || 'Failed to resolve Git worktree top-level folder.',
      };
    }
    const rawTop = topRes.stdout.trim();
    toplevelRealPath = (await realPathOrNull(rawTop)) ?? path.resolve(rawTop);
    toplevelFolderIdentity = await dirIdentityOrNull(toplevelRealPath);

    // Probe index readability without scanning untracked files so corrupt/unsupported indexes surface clearly.
    const statusRes = await runGit(
      gitExecutable,
      ['status', '--porcelain=v2', '-z', '-uno'],
      folder,
      pathEnv,
    );
    if (!statusRes.ok) {
      const combined = `${statusRes.stderr}\n${statusRes.stdout}`.trim();
      return {
        _tag: 'UnsupportedRepo',
        path: folder,
        detail: combined || 'Repository index format is unsupported or unreadable.',
      };
    }
  }

  const listRes = await runGit(
    gitExecutable,
    ['worktree', 'list', '--porcelain', '-z'],
    folder,
    pathEnv,
  );
  if (!listRes.ok) {
    const combined = `${listRes.stderr}\n${listRes.stdout}`.trim();
    return {
      _tag: isNotGitRepoOutput(combined) ? 'NonGit' : 'UnsupportedRepo',
      path: folder,
      detail: combined || 'Failed to enumerate Git worktrees.',
    };
  }

  const parsed = parseWorktreePorcelainZ(listRes.stdout);
  const resolvedRecords: RawWorktreeRecord[] = [];
  for (const record of parsed) {
    if (!record.bare && !record.detached && record.branch === undefined) {
      const targetExists = await isDirectory(record.rawPath);
      if (targetExists) {
        const symRes = await runGit(
          gitExecutable,
          ['symbolic-ref', '--short', '-q', 'HEAD'],
          record.rawPath,
          pathEnv,
        );
        const unbornBranch = symRes.ok ? symRes.stdout.trim() : '';
        if (unbornBranch.length > 0) {
          record.branch = unbornBranch;
          record.branchRef = `refs/heads/${unbornBranch}`;
        }
      }
    }
    resolvedRecords.push(await finalizeWorktreeRecord(record, gitExecutable, pathEnv));
  }

  return {
    _tag: 'Available',
    gitVersion,
    executable: gitExecutable,
    folderRealPath,
    ...(toplevelRealPath === undefined ? {} : { toplevelRealPath }),
    ...(toplevelFolderIdentity === null ? {} : { toplevelFolderIdentity }),
    commonDirRealPath,
    ...(commonDirIdentity === null ? {} : { commonDirIdentity }),
    gitDirRealPath,
    ...(gitDirIdentity === null ? {} : { gitDirIdentity }),
    worktrees: resolvedRecords,
  };
};

export const handleWorkerRequest = async (request: WorkerRequest): Promise<WorkerResponse> => {
  switch (request.method) {
    case 'ping':
      return { id: request.id, ok: true, result: { pid: process.pid } };
    case 'shutdown':
      return { id: request.id, ok: true, result: { stopped: true } };
    case 'git.probe': {
      const result = await probeGitFolder(request.folder, request.gitExecutable, request.pathEnv);
      return { id: request.id, ok: true, result };
    }
    case 'git.status': {
      const result = await inspectGitStatus(request.folder, request.gitExecutable, request.pathEnv);
      return { id: request.id, ok: true, result };
    }
    case 'git.diff': {
      const result = await inspectGitDiff(
        request.folder,
        request.path,
        request.scope,
        request.gitExecutable,
        request.pathEnv,
      );
      return { id: request.id, ok: true, result };
    }
    case 'git.commits': {
      const result = await listGitCommits(
        request.folder,
        request.limit,
        request.offset,
        request.gitExecutable,
        request.pathEnv,
      );
      return { id: request.id, ok: true, result };
    }
    case 'git.commitDetail': {
      const result = await inspectCommitDetail(
        request.folder,
        request.sha,
        request.gitExecutable,
        request.pathEnv,
      );
      return { id: request.id, ok: true, result };
    }
    case 'git.commitFileDiff': {
      const result = await inspectCommitFileDiff(
        request.folder,
        request.sha,
        request.path,
        request.gitExecutable,
        request.pathEnv,
      );
      return { id: request.id, ok: true, result };
    }
  }
};
