import { execFile as execFileCb } from 'node:child_process';
import { realpath as realpathCb } from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WorkerCapabilityFailure, WorkerIntegrationState } from './worker-protocol';

export interface ExecResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly errnoCode?: string;
  readonly exitCode?: number | null;
}

export interface GitWorktreeContext {
  readonly _tag: 'Available';
  readonly gitVersion: string;
  readonly executable: string;
  readonly folderRealPath: string;
  readonly toplevelRealPath: string;
  readonly commonDirRealPath: string;
  readonly gitDirRealPath: string;
}

export interface StatSnapshot {
  readonly exists: boolean;
  readonly kind: 'file' | 'dir' | 'symlink' | 'special' | 'missing';
  readonly size: number;
  readonly mtimeMs: number;
}

export const SAFE_GIT_ARG = /^[A-Za-z0-9._=@:/-]+$/;
export const GIT_TIMEOUT_MS = 15_000;
export const GIT_MAX_BUFFER = 16 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_BYTES = 512 * 1024;
export const MAX_DIFF_LINES = 4_000;
export const MAX_COMMIT_FILES = 2_000;

export const realpathNative = promisify(realpathCb.native);

export const buildGitEnv = (pathEnv: string): NodeJS.ProcessEnv => {
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

export const runExec = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  pathEnv: string,
  windowsVerbatimArguments = false,
  stdinText?: string,
  timeoutMs = GIT_TIMEOUT_MS,
): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = execFileCb(
      command,
      [...args],
      {
        cwd,
        env: buildGitEnv(pathEnv),
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments,
        encoding: 'utf8',
        timeout: timeoutMs,
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
    if (stdinText !== undefined && child.stdin !== null) {
      // git may exit before it reads its input (a failed command); the exec callback above reports that, so a
      // broken pipe here must not surface as an unhandled error.
      child.stdin.on('error', () => undefined);
      child.stdin.end(stdinText);
    }
  });

export const runGit = (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  pathEnv: string,
  stdinText?: string,
  timeoutMs?: number,
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
    return runExec(
      comspec,
      ['/d', '/s', '/c', `"${commandLine}"`],
      cwd,
      pathEnv,
      true,
      stdinText,
      timeoutMs,
    );
  }
  return runExec(executable, args, cwd, pathEnv, false, stdinText, timeoutMs);
};

export const realPathOrNull = async (target: string): Promise<string | null> => {
  try {
    return await realpathNative(target);
  } catch {
    return null;
  }
};

export const dirIdentityOrNull = async (target: string): Promise<string | null> => {
  try {
    const info = await stat(target);
    return `${String(info.dev)}:${String(info.ino)}:${String(Math.trunc(info.birthtimeMs))}`;
  } catch {
    return null;
  }
};

export const isDirectory = async (target: string): Promise<boolean> => {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
};

export const existsSyncAsync = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

export const parseGitVersion = (stdout: string): string => {
  const trimmed = stdout.trim();
  const match = /^git version\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() || trimmed || 'unknown';
};

export const isUnsupportedRepoOutput = (text: string): boolean =>
  /unsupported repositoryformatversion|unknown repository extension|bad repository format|objectformat|unsupported index|index file smaller than expected|index file corrupt|corrupt|invalid .*index/i.test(
    text,
  );

export const isNotGitRepoOutput = (text: string): boolean => /not a git repository/i.test(text);

export const isMaxBufferError = (result: ExecResult): boolean =>
  result.errnoCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
  /maxBuffer length exceeded/i.test(result.stderr);

/** A git command failed: an unsupported repository format, else a passing failure (timeout, lock, ownership). */
export const gitFailure = (
  folder: string,
  result: ExecResult,
  fallback: string,
): WorkerCapabilityFailure => {
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  return isUnsupportedRepoOutput(combined)
    ? { _tag: 'UnsupportedRepo', path: folder, detail: combined }
    : { _tag: 'GitFailed', path: folder, detail: combined || fallback };
};

/** Validates and normalizes repo preflight checks; refuses bare repos or unreadable indexes. */
export const resolveWorktreeContext = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<GitWorktreeContext | WorkerCapabilityFailure> => {
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
    return gitFailure(folder, revParse, 'Unable to inspect Git repository metadata.');
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

  if (isBare || !isInsideWorkTree) {
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: isBare
        ? 'Bare Git repositories do not have a checked-out working tree to inspect.'
        : 'Folder is inside Git metadata rather than a checked-out working tree.',
    };
  }

  const folderRealPath = (await realPathOrNull(folder)) ?? path.resolve(folder);
  const commonDirAbs = path.resolve(folder, rawCommonDir);
  const gitDirAbs = path.resolve(folder, rawGitDir);
  const commonDirRealPath = (await realPathOrNull(commonDirAbs)) ?? commonDirAbs;
  const gitDirRealPath = (await realPathOrNull(gitDirAbs)) ?? gitDirAbs;

  const topRes = await runGit(gitExecutable, ['rev-parse', '--show-toplevel'], folder, pathEnv);
  if (!topRes.ok) {
    const combined = `${topRes.stderr}\n${topRes.stdout}`.trim();
    if (isNotGitRepoOutput(combined)) return { _tag: 'NonGit', path: folder, detail: combined };
    return gitFailure(folder, topRes, 'Failed to resolve Git worktree top-level folder.');
  }
  const rawTop = topRes.stdout.trim();
  const toplevelRealPath = (await realPathOrNull(rawTop)) ?? path.resolve(rawTop);

  // Verify index readability without scanning untracked entries.
  const indexProbe = await runGit(
    gitExecutable,
    ['status', '--porcelain=v2', '-z', '-uno'],
    toplevelRealPath,
    pathEnv,
  );
  if (!indexProbe.ok) {
    return gitFailure(folder, indexProbe, 'Repository index is unreadable.');
  }

  return {
    _tag: 'Available',
    gitVersion,
    executable: gitExecutable,
    folderRealPath,
    toplevelRealPath,
    commonDirRealPath,
    gitDirRealPath,
  };
};

export const detectActiveIntegration = async (
  gitDirRealPath: string,
): Promise<WorkerIntegrationState> => {
  if (
    (await existsSyncAsync(path.join(gitDirRealPath, 'rebase-merge'))) ||
    (await existsSyncAsync(path.join(gitDirRealPath, 'rebase-apply')))
  ) {
    return 'Rebase';
  }
  if (await existsSyncAsync(path.join(gitDirRealPath, 'MERGE_HEAD'))) {
    return 'Merge';
  }
  if (await existsSyncAsync(path.join(gitDirRealPath, 'CHERRY_PICK_HEAD'))) {
    return 'CherryPick';
  }
  if (await existsSyncAsync(path.join(gitDirRealPath, 'REVERT_HEAD'))) {
    return 'Revert';
  }
  if (await existsSyncAsync(path.join(gitDirRealPath, 'BISECT_LOG'))) {
    return 'Bisect';
  }
  return 'None';
};

export const resolveEmptyTreeSha = async (
  executable: string,
  cwd: string,
  pathEnv: string,
): Promise<string | null> => {
  const res = await runGit(executable, ['hash-object', '-t', 'tree', '--stdin'], cwd, pathEnv, '');
  if (!res.ok) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null;
};

/** Validates a repo-relative path syntactically and ensures no escape via `..`, `.git`, or parent symlinks. */
export const validateRepoRelativePath = async (
  toplevelRealPath: string,
  relPath: string,
  options?: { readonly checkFilesystem?: boolean },
): Promise<
  | { readonly ok: true; readonly normalized: string; readonly fullPath: string }
  | { readonly ok: false; readonly detail: string }
> => {
  if (relPath.length === 0 || relPath.includes('\0')) {
    return { ok: false, detail: 'Path must be a non-empty relative path.' };
  }
  if (relPath.includes('\\') || relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    return { ok: false, detail: `Invalid repository-relative path: ${relPath}` };
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, detail: `Refused unsafe path segment in "${relPath}".` };
    }
    if (segment.toLowerCase() === '.git') {
      return { ok: false, detail: `Refused access to Git metadata path "${relPath}".` };
    }
  }

  const fullPath = path.resolve(toplevelRealPath, ...segments);
  const relative = path.relative(toplevelRealPath, fullPath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, detail: `Path escapes repository root: ${relPath}` };
  }

  if (options?.checkFilesystem === false) {
    return { ok: true, normalized: segments.join('/'), fullPath };
  }

  // Walk parent directories without traversing through symlinks outside the repository root.
  let current = toplevelRealPath;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg === undefined) break;
    current = path.join(current, seg);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        return {
          ok: false,
          detail: `Refused traversing symbolic-link directory "${segments.slice(0, i + 1).join('/')}".`,
        };
      }
      if (!info.isDirectory()) {
        return { ok: true, normalized: segments.join('/'), fullPath };
      }
    } catch {
      return { ok: true, normalized: segments.join('/'), fullPath };
    }
  }

  return { ok: true, normalized: segments.join('/'), fullPath };
};

export const lstatSnapshot = async (fullPath: string): Promise<StatSnapshot> => {
  try {
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      return { exists: true, kind: 'symlink', size: info.size, mtimeMs: info.mtimeMs };
    }
    if (info.isDirectory()) {
      return { exists: true, kind: 'dir', size: info.size, mtimeMs: info.mtimeMs };
    }
    if (!info.isFile()) {
      return { exists: true, kind: 'special', size: info.size, mtimeMs: info.mtimeMs };
    }
    return { exists: true, kind: 'file', size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return { exists: false, kind: 'missing', size: 0, mtimeMs: 0 };
  }
};

export const snapshotsEqual = (a: StatSnapshot, b: StatSnapshot): boolean =>
  a.exists === b.exists &&
  a.kind === b.kind &&
  a.size === b.size &&
  Math.trunc(a.mtimeMs * 1000) === Math.trunc(b.mtimeMs * 1000);

export const countTextLines = (text: string): number => {
  if (text.length === 0) return 0;
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (normalized.length === 0) return 1;
  return normalized.split('\n').length;
};

export const readBoundedTextFile = async (
  fullPath: string,
  expectedSize: number,
): Promise<
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary' }
  | { readonly kind: 'tooLarge'; readonly byteSize: number }
  | { readonly kind: 'unreadable'; readonly detail: string }
> => {
  if (expectedSize > MAX_PREVIEW_BYTES) {
    return { kind: 'tooLarge', byteSize: expectedSize };
  }
  try {
    const buffer = await readFile(fullPath);
    if (buffer.byteLength > MAX_PREVIEW_BYTES) {
      return { kind: 'tooLarge', byteSize: buffer.byteLength };
    }
    if (buffer.includes(0)) {
      return { kind: 'binary' };
    }
    return { kind: 'text', text: buffer.toString('utf8') };
  } catch (error) {
    return {
      kind: 'unreadable',
      detail: error instanceof Error ? error.message : 'Unable to read file.',
    };
  }
};
