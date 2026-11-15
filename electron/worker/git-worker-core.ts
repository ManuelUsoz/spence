import { execFile as execFileCb } from 'node:child_process';
import { realpath as realpathCb } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitProbeResult,
  RawWorktreeRecord,
  WorkerRequest,
  WorkerResponse,
} from './worker-protocol';

interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly errnoCode?: string;
  readonly exitCode?: number | null;
}

const SAFE_GIT_ARG = /^[A-Za-z0-9._=@:/-]+$/;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

const buildGitEnv = (pathEnv: string): NodeJS.ProcessEnv => {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() === 'PATH') continue;
    clean[key] = value;
  }
  return {
    ...clean,
    PATH: pathEnv,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
};

const runExec = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  pathEnv: string,
  windowsVerbatimArguments = false,
): Promise<ExecResult> =>
  new Promise((resolve) => {
    execFileCb(
      command,
      [...args],
      {
        cwd,
        env: buildGitEnv(pathEnv),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ ok: true, stdout, stderr });
          return;
        }
        const errInfo = error as NodeJS.ErrnoException & { readonly status?: number | null };
        const result: ExecResult = {
          ok: false,
          stdout,
          stderr: stderr || errInfo.message,
          ...(typeof errInfo.code === 'string' ? { errnoCode: errInfo.code } : {}),
          ...(errInfo.status !== undefined ? { exitCode: errInfo.status } : {}),
        };
        resolve(result);
      },
    );
  });

const runGit = (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  pathEnv: string,
): Promise<ExecResult> => {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    const unsafe = args.find((arg) => !SAFE_GIT_ARG.test(arg));
    if (unsafe !== undefined) {
      return Promise.resolve({
        ok: false,
        stdout: '',
        stderr: `Refused unsafe Git argument: ${unsafe}`,
      });
    }
    if (/["%!^\r\n]/.test(executable)) {
      return Promise.resolve({
        ok: false,
        stdout: '',
        stderr: 'Refused unsafe Git shim path.',
      });
    }
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows';
    const comspec = process.env['ComSpec'] ?? path.join(systemRoot, 'System32', 'cmd.exe');
    const commandLine = `"${executable}" ${args.join(' ')}`;
    return runExec(comspec, ['/d', '/s', '/c', `"${commandLine}"`], cwd, pathEnv, true);
  }
  return runExec(executable, args, cwd, pathEnv, false);
};

const realpathNative = promisify(realpathCb.native);

const realPathOrNull = async (target: string): Promise<string | null> => {
  try {
    return await realpathNative(target);
  } catch {
    return null;
  }
};

const dirIdentityOrNull = async (target: string): Promise<string | null> => {
  try {
    const info = await stat(target);
    return `${String(info.dev)}:${String(info.ino)}:${String(Math.trunc(info.birthtimeMs))}`;
  } catch {
    return null;
  }
};

const isDirectory = async (target: string): Promise<boolean> => {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
};

const parseGitVersion = (stdout: string): string => {
  const trimmed = stdout.trim();
  const match = /^git version\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() || trimmed || 'unknown';
};

const isUnsupportedRepoOutput = (text: string): boolean =>
  /unsupported repositoryformatversion|unknown repository extension|bad repository format|objectformat|unsupported index|index file smaller than expected|index file corrupt|corrupt|invalid .*index/i.test(
    text,
  );

const isNotGitRepoOutput = (text: string): boolean => /not a git repository/i.test(text);

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

const finalizeWorktreeRecord = async (
  record: MutableWorktreeRecord,
): Promise<RawWorktreeRecord> => {
  const { realPath, normalizedPath } = await resolveExistingOrParentPath(record.rawPath);
  const folderIdentity = realPath === null ? null : await dirIdentityOrNull(realPath);
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

  let toplevelRealPath: string | undefined;
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
    resolvedRecords.push(await finalizeWorktreeRecord(record));
  }

  return {
    _tag: 'Available',
    gitVersion,
    executable: gitExecutable,
    folderRealPath,
    ...(toplevelRealPath === undefined ? {} : { toplevelRealPath }),
    commonDirRealPath,
    ...(commonDirIdentity === null ? {} : { commonDirIdentity }),
    gitDirRealPath,
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
  }
};
