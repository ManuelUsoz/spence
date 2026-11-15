import { execFile as execFileCb } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath as realpathCb } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  GitBranchCheck,
  GitCreateContextHead,
  GitCreateContextResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitDestinationCheck,
  GitEligibleBranch,
  GitPostWorktreeCreateInspection,
  GitProbeResult,
  RawWorktreeRecord,
  WorkerRequest,
  WorkerResponse,
  WorkerResponseErrorReason,
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

interface WorkerActionFailure {
  readonly ok: false;
  readonly reason: WorkerResponseErrorReason;
  readonly detail: string;
}

type WorkerActionOutcome<T> = { readonly ok: true; readonly result: T } | WorkerActionFailure;

const COMMIT_OID_RE = /^[0-9a-f]{40,64}$/i;
const FORBIDDEN_BRANCH_CHARS = new Set(['~', '^', ':', '?', '*', '[', ']', '\\']);

const hasUnsafeBranchCharacter = (branch: string): boolean => {
  for (let i = 0; i < branch.length; i += 1) {
    const code = branch.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
    const ch = branch.charAt(i);
    if (FORBIDDEN_BRANCH_CHARS.has(ch)) return true;
  }
  return false;
};

const normalizeComparePath = (target: string): string => {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  const trimmed = resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
  return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
};

const isSameOrChildPath = (candidate: string, ancestor: string): boolean => {
  const c = normalizeComparePath(candidate);
  const a = normalizeComparePath(ancestor);
  if (c === a) return true;
  const sep = a.endsWith(path.sep) ? a : `${a}${path.sep}`;
  return c.startsWith(sep);
};

const hasGitPathSegment = (target: string): boolean => {
  const segments = path.resolve(target).split(/[\\/]+/);
  return segments.some((segment) => segment.toLowerCase() === '.git');
};

const resolveDeepestAncestorRealPath = async (
  target: string,
): Promise<{
  readonly resolvedRealPath: string | null;
  readonly existingParentRealPath: string | null;
}> => {
  const normalized = path.resolve(target);
  const missingSegments: string[] = [];
  let cursor = normalized;

  while (true) {
    const real = await realPathOrNull(cursor);
    if (real !== null) {
      const rebuilt =
        missingSegments.length === 0 ? real : path.join(real, ...missingSegments.reverse());
      return {
        resolvedRealPath: rebuilt,
        existingParentRealPath: real,
      };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return { resolvedRealPath: null, existingParentRealPath: null };
    }
    missingSegments.push(path.basename(cursor));
    cursor = parent;
  }
};

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

const detectActiveIntegration = async (
  gitDirRealPath: string,
  commonDirRealPath: string,
): Promise<string | null> => {
  if (await pathExists(path.join(gitDirRealPath, 'MERGE_HEAD'))) return 'merge';
  if (
    (await pathExists(path.join(gitDirRealPath, 'rebase-merge'))) ||
    (await pathExists(path.join(gitDirRealPath, 'rebase-apply')))
  ) {
    return 'rebase';
  }
  if (await pathExists(path.join(gitDirRealPath, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (await pathExists(path.join(gitDirRealPath, 'REVERT_HEAD'))) return 'revert';
  if (
    (await pathExists(path.join(gitDirRealPath, 'BISECT_LOG'))) ||
    (await pathExists(path.join(commonDirRealPath, 'BISECT_LOG')))
  ) {
    return 'bisect';
  }
  return null;
};

const countPorcelainStatus = (stdout: string): number => {
  const tokens = stdout.split('\0');
  let count = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '') continue;
    count += 1;
    // Renames/copies in -z emit an extra NUL-separated source path token immediately after.
    const statusCode = token.slice(0, 2);
    if (statusCode.includes('R') || statusCode.includes('C')) {
      i += 1;
    }
  }
  return count;
};

const isSafeBranchLiteral = (branch: string): boolean => {
  if (branch.length === 0 || branch.length > 240) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/')) return false;
  if (branch.startsWith('.') || branch.endsWith('.')) return false;
  if (branch === '@' || branch.includes('..') || branch.includes('//') || branch.includes('@{')) {
    return false;
  }
  if (hasUnsafeBranchCharacter(branch)) return false;
  const parts = branch.split('/');
  for (const part of parts) {
    if (part.length === 0 || part.startsWith('.') || part.endsWith('.lock')) return false;
  }
  return true;
};

const validateBranchFormat = async (
  gitExecutable: string,
  folder: string,
  pathEnv: string,
  branch: string,
): Promise<boolean> => {
  if (!isSafeBranchLiteral(branch)) return false;
  const checkRes = await runGit(
    gitExecutable,
    ['check-ref-format', `refs/heads/${branch}`],
    folder,
    pathEnv,
  );
  return checkRes.ok;
};

const inspectDestinationTarget = async (
  destinationPath: string,
  knownRepoRoots: ReadonlyArray<string>,
  gitDirs: ReadonlyArray<string>,
): Promise<GitDestinationCheck> => {
  if (destinationPath.includes('\0') || !path.isAbsolute(destinationPath)) {
    return {
      destinationPath,
      normalizedPath: destinationPath,
      resolvedRealPath: null,
      parentExists: false,
      destinationExists: false,
      destinationIsDirectory: false,
      destinationIsEmpty: null,
      insideSourceOrRepo: false,
      containsExistingWorktree: false,
      touchesGitAdmin: true,
    };
  }

  const normalizedPath = path.resolve(destinationPath);
  const { resolvedRealPath, existingParentRealPath } =
    await resolveDeepestAncestorRealPath(normalizedPath);
  const effectivePath = resolvedRealPath ?? normalizedPath;
  const parentReal = await realPathOrNull(path.dirname(normalizedPath));

  let destinationExists = false;
  let destinationIsDirectory = false;
  let destinationIsEmpty: boolean | null = null;
  try {
    const info = await stat(normalizedPath);
    destinationExists = true;
    destinationIsDirectory = info.isDirectory();
    if (destinationIsDirectory) {
      const entries = await readdir(normalizedPath);
      destinationIsEmpty = entries.length === 0;
    }
  } catch {
    destinationExists = false;
  }

  const touchesGitSegment = hasGitPathSegment(normalizedPath) || hasGitPathSegment(effectivePath);
  const insideGitDir = gitDirs.some((dir) => isSameOrChildPath(effectivePath, dir));
  const touchesGitAdmin = touchesGitSegment || insideGitDir;

  const insideSourceOrRepo = knownRepoRoots.some((root) => isSameOrChildPath(effectivePath, root));
  const containsExistingWorktree = knownRepoRoots.some((root) =>
    isSameOrChildPath(root, effectivePath),
  );

  return {
    destinationPath,
    normalizedPath,
    resolvedRealPath,
    parentExists: parentReal !== null || existingParentRealPath !== null,
    destinationExists,
    destinationIsDirectory,
    destinationIsEmpty,
    insideSourceOrRepo: insideSourceOrRepo || touchesGitAdmin,
    containsExistingWorktree,
    touchesGitAdmin,
  };
};

const inspectCreateHead = async (
  gitExecutable: string,
  wtPath: string,
  pathEnv: string,
): Promise<GitCreateContextHead> => {
  const symRes = await runGit(
    gitExecutable,
    ['symbolic-ref', '--short', '-q', 'HEAD'],
    wtPath,
    pathEnv,
  );
  const headBranch = symRes.ok && symRes.stdout.trim().length > 0 ? symRes.stdout.trim() : null;
  const revRes = await runGit(
    gitExecutable,
    ['rev-parse', '--verify', '-q', 'HEAD'],
    wtPath,
    pathEnv,
  );
  const headCommit =
    revRes.ok && COMMIT_OID_RE.test(revRes.stdout.trim()) ? revRes.stdout.trim() : null;

  if (headCommit === null) {
    return { _tag: 'Unborn', branch: headBranch };
  }
  if (headBranch !== null) {
    return { _tag: 'Branch', branch: headBranch, commit: headCommit };
  }
  return { _tag: 'Detached', commit: headCommit };
};

const listLocalBranches = async (
  gitExecutable: string,
  wtPath: string,
  pathEnv: string,
  checkedOutBranches: ReadonlySet<string>,
): Promise<{
  readonly branches: ReadonlyArray<GitEligibleBranch>;
  readonly digest: string;
}> => {
  const refsRes = await runGit(
    gitExecutable,
    ['for-each-ref', '--format=%(refname:short)%09%(objectname)', 'refs/heads/'],
    wtPath,
    pathEnv,
  );
  const branches: GitEligibleBranch[] = [];
  if (refsRes.ok) {
    for (const line of refsRes.stdout.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const tabIdx = line.indexOf('\t');
      if (tabIdx <= 0) continue;
      const name = line.slice(0, tabIdx);
      const commit = line.slice(tabIdx + 1).trim();
      branches.push({
        name,
        commit,
        checkedOut: checkedOutBranches.has(name),
      });
    }
  }
  branches.sort((a, b) => a.name.localeCompare(b.name));
  const hash = createHash('sha256');
  for (const b of branches) {
    hash.update(`${b.name}\t${b.commit}\t${b.checkedOut ? '1' : '0'}\n`);
  }
  return { branches, digest: hash.digest('hex') };
};

/** Inspects repository state, eligible branches, and optional proposed target for Worktree creation. */
export const inspectCreateContext = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
  options?: { readonly destinationPath?: string; readonly branch?: string },
): Promise<GitCreateContextResult> => {
  const probe = await probeGitFolder(folder, gitExecutable, pathEnv);
  if (probe._tag !== 'Available') {
    return probe._tag === 'MissingGit'
      ? { _tag: 'MissingGit', folder, detail: probe.detail }
      : { _tag: probe._tag, folder: probe.path, detail: probe.detail };
  }

  const wtPath = probe.toplevelRealPath ?? probe.folderRealPath;
  const checkedOutBranches = new Set<string>();
  const worktreePaths: string[] = [];
  for (const wt of probe.worktrees) {
    worktreePaths.push(wt.realPath ?? wt.rawPath);
    if (wt.branch !== undefined) {
      checkedOutBranches.add(wt.branch);
    }
  }

  const [head, statusRes, branchSummary, integrationActive] = await Promise.all([
    inspectCreateHead(probe.executable, wtPath, pathEnv),
    runGit(probe.executable, ['status', '--porcelain=v1', '-z', '-unormal'], wtPath, pathEnv),
    listLocalBranches(probe.executable, wtPath, pathEnv, checkedOutBranches),
    detectActiveIntegration(probe.gitDirRealPath, probe.commonDirRealPath),
  ]);

  const dirtyCount = statusRes.ok ? countPorcelainStatus(statusRes.stdout) : 0;

  let destinationCheck: GitDestinationCheck | undefined;
  if (options?.destinationPath !== undefined) {
    destinationCheck = await inspectDestinationTarget(
      options.destinationPath,
      [...worktreePaths, probe.folderRealPath],
      [probe.commonDirRealPath, probe.gitDirRealPath],
    );
  }

  let branchCheck: GitBranchCheck | undefined;
  if (options?.branch !== undefined) {
    const validName = await validateBranchFormat(probe.executable, wtPath, pathEnv, options.branch);
    const existing = branchSummary.branches.find((b) => b.name === options.branch);
    branchCheck = {
      branch: options.branch,
      validName,
      exists: existing !== undefined,
      existingCommit: existing === undefined ? null : existing.commit,
      checkedOutElsewhere: existing?.checkedOut ?? false,
    };
  }

  return {
    _tag: 'Available',
    folder,
    folderRealPath: probe.folderRealPath,
    commonDirRealPath: probe.commonDirRealPath,
    commonDirIdentity: probe.commonDirIdentity ?? null,
    worktreePath: wtPath,
    worktreeRealPath: wtPath,
    head,
    dirtyCount,
    integrationActive,
    branches: branchSummary.branches,
    branchesDigest: branchSummary.digest,
    worktreePaths,
    ...(destinationCheck === undefined ? {} : { destinationCheck }),
    ...(branchCheck === undefined ? {} : { branchCheck }),
  };
};

/** Executes `git worktree add` inside the worker after strict input, path, and identity validation. */
export const createWorktreeInWorker = async (
  input: GitCreateWorktreeInput,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<WorkerActionOutcome<GitCreateWorktreeResult>> => {
  const probe = await probeGitFolder(input.folder, gitExecutable, pathEnv);
  if (probe._tag !== 'Available') {
    return {
      ok: false,
      reason: probe._tag === 'MissingGit' ? 'MissingGit' : 'ExecutionFailed',
      detail: probe.detail,
    };
  }

  if (
    normalizeComparePath(probe.commonDirRealPath) !==
    normalizeComparePath(input.expectedCommonDirRealPath)
  ) {
    return {
      ok: false,
      reason: 'Conflict',
      detail: 'Target repository identity changed before Worktree creation.',
    };
  }
  if (
    input.expectedCommonDirIdentity !== null &&
    probe.commonDirIdentity !== undefined &&
    probe.commonDirIdentity !== input.expectedCommonDirIdentity
  ) {
    return {
      ok: false,
      reason: 'Conflict',
      detail: 'Repository directory identity drifted before Worktree creation.',
    };
  }

  const wtPath = probe.toplevelRealPath ?? probe.folderRealPath;
  if (!COMMIT_OID_RE.test(input.startPoint)) {
    return {
      ok: false,
      reason: 'InvalidInput',
      detail: 'Starting point commit hash is invalid.',
    };
  }

  const validBranch = await validateBranchFormat(probe.executable, wtPath, pathEnv, input.branch);
  if (!validBranch) {
    return {
      ok: false,
      reason: 'InvalidInput',
      detail: `Branch name "${input.branch}" is not valid for Git.`,
    };
  }

  const worktreeRoots = [
    ...probe.worktrees.map((w) => w.realPath ?? w.rawPath),
    probe.folderRealPath,
  ];
  const destCheck = await inspectDestinationTarget(input.destinationPath, worktreeRoots, [
    probe.commonDirRealPath,
    probe.gitDirRealPath,
  ]);

  if (!path.isAbsolute(input.destinationPath) || input.destinationPath.includes('\0')) {
    return {
      ok: false,
      reason: 'InvalidInput',
      detail: 'Destination folder must be a valid absolute path.',
    };
  }
  if (path.dirname(destCheck.normalizedPath) === destCheck.normalizedPath) {
    return {
      ok: false,
      reason: 'UntrustedPath',
      detail: 'Destination folder cannot be a filesystem root.',
    };
  }
  if (destCheck.resolvedRealPath === null) {
    return {
      ok: false,
      reason: 'UntrustedPath',
      detail: 'Destination parent root does not exist.',
    };
  }
  if (destCheck.touchesGitAdmin) {
    return {
      ok: false,
      reason: 'UntrustedPath',
      detail: 'Destination path cannot touch a .git directory.',
    };
  }
  if (destCheck.insideSourceOrRepo) {
    return {
      ok: false,
      reason: 'UntrustedPath',
      detail: 'Destination folder cannot be inside an existing Worktree or repository checkout.',
    };
  }
  if (destCheck.containsExistingWorktree) {
    return {
      ok: false,
      reason: 'UntrustedPath',
      detail: 'Destination folder cannot contain an existing Worktree.',
    };
  }
  if (destCheck.destinationExists) {
    if (!destCheck.destinationIsDirectory) {
      return {
        ok: false,
        reason: 'Conflict',
        detail: 'Destination path already exists as a file.',
      };
    }
    if (destCheck.destinationIsEmpty !== true) {
      return {
        ok: false,
        reason: 'Conflict',
        detail: 'Destination folder already exists and is not empty.',
      };
    }
  }

  const refName = `refs/heads/${input.branch}`;
  const refCheck = await runGit(
    probe.executable,
    ['show-ref', '--verify', '--quiet', refName],
    wtPath,
    pathEnv,
  );

  if (input.mode === 'NewBranch') {
    if (refCheck.ok) {
      return {
        ok: false,
        reason: 'Conflict',
        detail: `Branch "${input.branch}" already exists.`,
      };
    }
    const addRes = await runGit(
      probe.executable,
      ['worktree', 'add', '-b', input.branch, '--', destCheck.resolvedRealPath, input.startPoint],
      wtPath,
      pathEnv,
    );
    if (!addRes.ok) {
      return {
        ok: false,
        reason: 'ExecutionFailed',
        detail: `${addRes.stderr}\n${addRes.stdout}`.trim() || 'git worktree add failed.',
      };
    }
  } else {
    if (!refCheck.ok) {
      return {
        ok: false,
        reason: 'Conflict',
        detail: `Branch "${input.branch}" does not exist.`,
      };
    }
    const branchAlreadyCheckedOut = probe.worktrees.some((wt) => wt.branch === input.branch);
    if (branchAlreadyCheckedOut) {
      return {
        ok: false,
        reason: 'Conflict',
        detail: `Branch "${input.branch}" is already checked out in another Worktree.`,
      };
    }
    const addRes = await runGit(
      probe.executable,
      ['worktree', 'add', '--no-guess-remote', '--', destCheck.resolvedRealPath, input.branch],
      wtPath,
      pathEnv,
    );
    if (!addRes.ok) {
      return {
        ok: false,
        reason: 'ExecutionFailed',
        detail: `${addRes.stderr}\n${addRes.stdout}`.trim() || 'git worktree add failed.',
      };
    }
  }

  const finalRealPath =
    (await realPathOrNull(destCheck.resolvedRealPath)) ?? destCheck.resolvedRealPath;
  const destinationIdentity = await dirIdentityOrNull(finalRealPath);
  const headRes = await runGit(
    probe.executable,
    ['rev-parse', '--verify', 'HEAD'],
    finalRealPath,
    pathEnv,
  );
  const headCommit = headRes.ok ? headRes.stdout.trim() : input.startPoint;

  return {
    ok: true,
    result: {
      destinationRealPath: finalRealPath,
      destinationIdentity,
      branch: input.branch,
      commit: headCommit,
    },
  };
};

/** Inspects actual repository and filesystem postconditions after a create attempt or crash. */
export const inspectPostWorktreeCreate = async (
  folder: string,
  destinationPath: string,
  branch: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<GitPostWorktreeCreateInspection> => {
  const destRealPath = await realPathOrNull(destinationPath);
  let folderExists = false;
  let folderEmpty = true;
  if (await isDirectory(destinationPath)) {
    folderExists = true;
    try {
      const entries = await readdir(destinationPath);
      folderEmpty = entries.length === 0;
    } catch {
      folderEmpty = true;
    }
  } else if (await pathExists(destinationPath)) {
    folderExists = true;
    folderEmpty = false;
  }

  const probe = await probeGitFolder(folder, gitExecutable, pathEnv);
  if (probe._tag !== 'Available') {
    return {
      folderExists,
      folderEmpty,
      registeredInGit: false,
      registeredBranch: null,
      branchExists: false,
      branchCommit: null,
      clean: null,
      headCommit: null,
      destinationRealPath: destRealPath,
      gitAvailable: probe._tag !== 'MissingGit',
      repoAvailable: false,
      detail: probe.detail,
    };
  }

  const wtPath = probe.toplevelRealPath ?? probe.folderRealPath;
  const targetCompare = normalizeComparePath(destRealPath ?? destinationPath);
  const matchedWorktree = probe.worktrees.find(
    (wt) => normalizeComparePath(wt.realPath ?? wt.rawPath) === targetCompare,
  );

  let branchExists = false;
  let branchCommit: string | null = null;
  if (isSafeBranchLiteral(branch)) {
    const showRef = await runGit(
      probe.executable,
      ['show-ref', '--verify', `refs/heads/${branch}`],
      wtPath,
      pathEnv,
    );
    if (showRef.ok) {
      branchExists = true;
      branchCommit = showRef.stdout.trim().split(/\s+/)[0] ?? null;
    }
  }

  let clean: boolean | null = null;
  let headCommit: string | null = matchedWorktree?.headCommit ?? null;
  if (folderExists && (await isDirectory(destinationPath))) {
    const [statusRes, headRes] = await Promise.all([
      runGit(
        probe.executable,
        ['status', '--porcelain=v1', '-z', '-unormal'],
        destinationPath,
        pathEnv,
      ),
      runGit(probe.executable, ['rev-parse', '--verify', '-q', 'HEAD'], destinationPath, pathEnv),
    ]);
    if (statusRes.ok) {
      clean = countPorcelainStatus(statusRes.stdout) === 0;
    }
    if (headRes.ok && COMMIT_OID_RE.test(headRes.stdout.trim())) {
      headCommit = headRes.stdout.trim();
    }
  }

  return {
    folderExists,
    folderEmpty,
    registeredInGit: matchedWorktree !== undefined,
    registeredBranch: matchedWorktree?.branch ?? null,
    branchExists,
    branchCommit,
    clean,
    headCommit,
    destinationRealPath: destRealPath,
    gitAvailable: true,
    repoAvailable: true,
    detail:
      matchedWorktree !== undefined
        ? 'Worktree is registered in Git.'
        : 'Worktree is not registered in Git.',
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
    case 'git.inspectCreateContext': {
      const result = await inspectCreateContext(
        request.folder,
        request.gitExecutable,
        request.pathEnv,
        {
          ...(request.destinationPath === undefined
            ? {}
            : { destinationPath: request.destinationPath }),
          ...(request.branch === undefined ? {} : { branch: request.branch }),
        },
      );
      return { id: request.id, ok: true, result };
    }
    case 'git.createWorktree': {
      const outcome = await createWorktreeInWorker(request, request.gitExecutable, request.pathEnv);
      if (!outcome.ok) {
        return { id: request.id, ok: false, reason: outcome.reason, detail: outcome.detail };
      }
      return { id: request.id, ok: true, result: outcome.result };
    }
    case 'git.inspectPostWorktreeCreate': {
      const result = await inspectPostWorktreeCreate(
        request.folder,
        request.destinationPath,
        request.branch,
        request.gitExecutable,
        request.pathEnv,
      );
      return { id: request.id, ok: true, result };
    }
  }
};
