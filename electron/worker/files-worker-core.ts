import { execFile, spawn } from 'node:child_process';
import { constants, realpath as realpathCb, type Stats } from 'node:fs';
import { lstat, open, opendir, readlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  DEFAULT_FILES_DIR_PAGE_LIMIT,
  DEFAULT_FILES_PREVIEW_MAX_BYTES,
  type FilesDirectoryPage,
  type FilesEntry,
  type FilesEntryKind,
  type FilesPreview,
} from '../../src/shared/files/files.rpc';
import type { WorkerFilesErrorReason, WorkerRequest, WorkerResponse } from './worker-protocol';

const realpathNative = promisify(realpathCb.native);
const execFileAsync = promisify(execFile);

const MAX_DIR_PAGE_LIMIT = 500;
const INTERNAL_BATCH_SIZE = 128;
const PREVIEW_SAMPLE_BYTES = 8192;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/;

/** Result returned by pure worker file helpers before wrapping into a `WorkerResponse`. */
export type FilesWorkerResult<A> =
  | { readonly ok: true; readonly result: A }
  | { readonly ok: false; readonly reason: WorkerFilesErrorReason; readonly detail: string };

/** Minimal stat capability shape needed to classify filesystem entries safely. */
export interface LstatShape {
  readonly isSymbolicLink: () => boolean;
  readonly isFIFO: () => boolean;
  readonly isSocket: () => boolean;
  readonly isBlockDevice: () => boolean;
  readonly isCharacterDevice: () => boolean;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

/** Classifies an `lstat` result without dereferencing links or opening special files. */
export const classifyLstatKind = (stats: LstatShape): FilesEntryKind => {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFIFO() || stats.isSocket() || stats.isBlockDevice() || stats.isCharacterDevice()) {
    return 'special';
  }
  if (stats.isDirectory()) return 'directory';
  if (stats.isFile()) return 'file';
  return 'special';
};

const isGitMetadataSegment = (segment: string): boolean => {
  const normalized = segment
    .trimEnd()
    .replace(/[. ]+$/, '')
    .toLowerCase();
  return normalized === '.git';
};

const errorCodeOf = (cause: unknown): string | undefined => {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const errorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isMissingCode = (code: string | undefined): boolean =>
  code === 'ENOENT' || code === 'ENOTDIR';

const isPermissionCode = (code: string | undefined): boolean =>
  code === 'EACCES' || code === 'EPERM';

const caseKey = (target: string): string =>
  process.platform === 'win32' ? target.toLowerCase() : target;

/** Checks whether canonical `candidateReal` is equal to or strictly inside canonical `rootReal`. */
export const isPathWithinRoot = (rootReal: string, candidateReal: string): boolean => {
  const rel = relative(caseKey(rootReal), caseKey(candidateReal));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

const dirIdentityOrNull = async (target: string): Promise<string | null> => {
  try {
    const info = await stat(target);
    return info.isDirectory()
      ? `${String(info.dev)}:${String(info.ino)}:${String(Math.trunc(info.birthtimeMs))}`
      : null;
  } catch {
    return null;
  }
};

const realPathOrNull = async (target: string): Promise<string | null> => {
  try {
    return await realpathNative(target);
  } catch {
    return null;
  }
};

const hasGitMarker = async (dirPath: string): Promise<boolean> => {
  try {
    await lstat(join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
};

interface ParsedRelativePath {
  readonly segments: ReadonlyArray<string>;
  readonly normalized: string;
}

const parseSafeRelativePath = (
  rawPath: string,
):
  | { readonly ok: true; readonly path: ParsedRelativePath }
  | { readonly ok: false; readonly detail: string } => {
  if (
    rawPath.includes('\0') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    rawPath.endsWith('/') ||
    WINDOWS_DRIVE_PREFIX.test(rawPath) ||
    isAbsolute(rawPath) ||
    win32.isAbsolute(rawPath)
  ) {
    return { ok: false, detail: `Path must be relative inside workspace: ${rawPath}` };
  }
  if (rawPath === '') {
    return { ok: true, path: { segments: [], normalized: '' } };
  }
  const segments = rawPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return { ok: false, detail: `Invalid path traversal segment in: ${rawPath}` };
    }
    if (isGitMetadataSegment(segment)) {
      return { ok: false, detail: `Git metadata path is protected: ${rawPath}` };
    }
  }
  return { ok: true, path: { segments, normalized: segments.join('/') } };
};

const validateRootDirectory = async (
  rootPath: string,
  expectedRootIdentity: string | null,
): Promise<FilesWorkerResult<string>> => {
  const rootReal = await realPathOrNull(rootPath);
  if (!rootReal) {
    return { ok: false, reason: 'NotFound', detail: 'Workspace root directory is unavailable' };
  }
  const identity = await dirIdentityOrNull(rootReal);
  if (!identity) {
    return { ok: false, reason: 'NotFound', detail: 'Workspace root is not a directory' };
  }
  if (expectedRootIdentity !== null && identity !== expectedRootIdentity) {
    return {
      ok: false,
      reason: 'OutsideRoot',
      detail: 'Workspace root identity no longer matches the bound Project or Worktree',
    };
  }
  return { ok: true, result: rootReal };
};

const inspectSymlinkContained = async (rootReal: string, linkPath: string): Promise<boolean> => {
  const resolved = await realPathOrNull(linkPath);
  if (resolved !== null) {
    return isPathWithinRoot(rootReal, resolved);
  }
  // Dangling symlink: resolve its raw target lexically relative to its parent to catch escaping targets.
  try {
    const rawTarget = await readlink(linkPath);
    const lexical = resolve(dirname(linkPath), rawTarget);
    return isPathWithinRoot(rootReal, lexical);
  } catch {
    return false;
  }
};

type ResolvedTarget =
  | { readonly kind: 'dir'; readonly targetPath: string; readonly normalized: string }
  | {
      readonly kind: 'file';
      readonly targetPath: string;
      readonly normalized: string;
      readonly stats: Stats;
    }
  | { readonly kind: 'symlink'; readonly normalized: string }
  | { readonly kind: 'missing'; readonly normalized: string }
  | { readonly kind: 'unreadable'; readonly normalized: string; readonly detail: string };

const resolveTargetInRoot = async (
  rootReal: string,
  parsed: ParsedRelativePath,
  mode: 'dir' | 'preview' | 'open',
): Promise<FilesWorkerResult<ResolvedTarget>> => {
  if (parsed.segments.length === 0) {
    if (mode !== 'dir') {
      return {
        ok: false,
        reason: 'UnsupportedFile',
        detail: 'Workspace root directory cannot be opened as a file',
      };
    }
    return { ok: true, result: { kind: 'dir', targetPath: rootReal, normalized: '' } };
  }

  let current = rootReal;
  for (let index = 0; index < parsed.segments.length; index += 1) {
    const segment = parsed.segments[index];
    if (segment === undefined) continue;
    const isFinal = index === parsed.segments.length - 1;
    const nextPath = join(current, segment);

    let info: Stats;
    try {
      info = await lstat(nextPath);
    } catch (cause) {
      const code = errorCodeOf(cause);
      if (isMissingCode(code)) {
        if (mode === 'preview') {
          return { ok: true, result: { kind: 'missing', normalized: parsed.normalized } };
        }
        return { ok: false, reason: 'NotFound', detail: `Path not found: ${parsed.normalized}` };
      }
      if (isPermissionCode(code) && mode === 'preview' && isFinal) {
        return {
          ok: true,
          result: { kind: 'unreadable', normalized: parsed.normalized, detail: errorDetail(cause) },
        };
      }
      return { ok: false, reason: 'IoFailed', detail: errorDetail(cause) };
    }

    const kind = classifyLstatKind(info);
    if (kind === 'symlink') {
      if (!isFinal) {
        return {
          ok: false,
          reason: 'OutsideRoot',
          detail: `Cannot traverse through symbolic link: ${parsed.normalized}`,
        };
      }
      const contained = await inspectSymlinkContained(rootReal, nextPath);
      if (!contained) {
        return {
          ok: false,
          reason: 'OutsideRoot',
          detail: `Symbolic link escapes workspace root: ${parsed.normalized}`,
        };
      }
      if (mode === 'preview') {
        return { ok: true, result: { kind: 'symlink', normalized: parsed.normalized } };
      }
      return {
        ok: false,
        reason: mode === 'dir' ? 'OutsideRoot' : 'UnsupportedFile',
        detail: `Symbolic links are not followed: ${parsed.normalized}`,
      };
    }

    if (kind === 'special') {
      return {
        ok: false,
        reason: 'UnsupportedFile',
        detail: `Special filesystem entries are unsupported: ${parsed.normalized}`,
      };
    }

    if (kind === 'directory') {
      if (await hasGitMarker(nextPath)) {
        return {
          ok: false,
          reason: 'OutsideRoot',
          detail: `Nested Git repositories cannot be traversed: ${parsed.normalized}`,
        };
      }
      const nextReal = await realPathOrNull(nextPath);
      if (!nextReal || !isPathWithinRoot(rootReal, nextReal)) {
        return {
          ok: false,
          reason: 'OutsideRoot',
          detail: `Path resolved outside workspace root: ${parsed.normalized}`,
        };
      }
      if (isFinal) {
        if (mode === 'open') {
          return {
            ok: false,
            reason: 'UnsupportedFile',
            detail: `Directories cannot be opened as files: ${parsed.normalized}`,
          };
        }
        return {
          ok: true,
          result: { kind: 'dir', targetPath: nextReal, normalized: parsed.normalized },
        };
      }
      current = nextReal;
      continue;
    }

    // Regular file
    if (!isFinal) {
      if (mode === 'preview') {
        return { ok: true, result: { kind: 'missing', normalized: parsed.normalized } };
      }
      return {
        ok: false,
        reason: 'NotFound',
        detail: `Parent is not a directory: ${parsed.normalized}`,
      };
    }

    const fileReal = await realPathOrNull(nextPath);
    if (!fileReal || !isPathWithinRoot(rootReal, fileReal)) {
      return {
        ok: false,
        reason: 'OutsideRoot',
        detail: `File resolved outside workspace root: ${parsed.normalized}`,
      };
    }
    if (mode === 'dir') {
      return {
        ok: false,
        reason: 'UnsupportedFile',
        detail: `Path is a file, not a directory: ${parsed.normalized}`,
      };
    }
    return {
      ok: true,
      result: { kind: 'file', targetPath: fileReal, normalized: parsed.normalized, stats: info },
    };
  }

  return { ok: false, reason: 'NotFound', detail: `Path not found: ${parsed.normalized}` };
};

const buildGitEnv = (pathEnv: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  return env;
};

const runGitInsideRoot = async (
  gitExe: string,
  rootReal: string,
  pathEnv: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stdout: string }> => {
  try {
    const { stdout } = await execFileAsync(gitExe, ['-C', rootReal, ...args], {
      env: buildGitEnv(pathEnv),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
    return { exitCode: 0, stdout };
  } catch (cause) {
    if (typeof cause === 'object' && cause !== null && 'code' in cause) {
      const code = (cause as { readonly code?: unknown }).code;
      if (typeof code === 'number') {
        const stdout =
          'stdout' in cause && typeof (cause as { readonly stdout?: unknown }).stdout === 'string'
            ? (cause as { readonly stdout: string }).stdout
            : '';
        return { exitCode: code, stdout };
      }
    }
    return { exitCode: 128, stdout: '' };
  }
};

const runGitCheckIgnore = (
  gitExe: string,
  rootReal: string,
  pathEnv: string,
  candidates: ReadonlyArray<string>,
): Promise<ReadonlySet<string>> => {
  if (candidates.length === 0) return Promise.resolve(new Set());
  return new Promise((resolvePromise) => {
    const child = spawn(gitExe, ['-C', rootReal, 'check-ignore', '-z', '--stdin'], {
      env: buildGitEnv(pathEnv),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (set: ReadonlySet<string>) => {
      if (settled) return;
      settled = true;
      resolvePromise(set);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Set());
    }, GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(new Set());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(new Set());
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const matched = new Set(
        raw
          .split('\0')
          .filter((item) => item.length > 0)
          .map((item) => (item.endsWith('/') ? item.slice(0, -1) : item)),
      );
      finish(matched);
    });
    child.stdin.on('error', () => {
      // Ignore broken pipe if child exits early.
    });
    child.stdin.end(`${candidates.join('\0')}\0`);
  });
};

const detectGitRepo = async (
  rootReal: string,
  gitExecutable: string | null,
  pathEnv: string,
): Promise<{ readonly isGitRepo: boolean; readonly gitExe: string | null }> => {
  if (gitExecutable === null) return { isGitRepo: false, gitExe: null };
  const result = await runGitInsideRoot(gitExecutable, rootReal, pathEnv, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  return result.exitCode === 0 && result.stdout.trim() === 'true'
    ? { isGitRepo: true, gitExe: gitExecutable }
    : { isGitRepo: false, gitExe: null };
};

interface SortableDirent {
  readonly name: string;
  readonly bucket: 0 | 1;
}

const compareSortable = (a: SortableDirent, b: SortableDirent): number => {
  if (a.bucket !== b.bucket) return a.bucket - b.bucket;
  const ci = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  if (ci !== 0) return ci;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

const parseCursor = (cursor: string | undefined): SortableDirent | null => {
  if (!cursor) return null;
  if (cursor.startsWith('0:')) return { bucket: 0, name: cursor.slice(2) };
  if (cursor.startsWith('1:')) return { bucket: 1, name: cursor.slice(2) };
  return null;
};

const formatCursor = (item: SortableDirent): string => `${String(item.bucket)}:${item.name}`;

const clampPageLimit = (limit: number): number => {
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_FILES_DIR_PAGE_LIMIT;
  return Math.min(MAX_DIR_PAGE_LIMIT, Math.floor(limit));
};

const yieldEventLoop = (): Promise<void> =>
  new Promise((resolveYield) => {
    setImmediate(resolveYield);
  });

/** Lists one bounded page of entries in a validated directory, never dereferencing `.git`, symlinks, or nested repos. */
export const listWorkspaceDir = async (request: {
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
  readonly dirPath: string;
  readonly cursor?: string;
  readonly limit: number;
  readonly showIgnoredFiles: boolean;
  readonly gitExecutable: string | null;
  readonly pathEnv: string;
}): Promise<FilesWorkerResult<FilesDirectoryPage>> => {
  const rootCheck = await validateRootDirectory(request.rootPath, request.expectedRootIdentity);
  if (!rootCheck.ok) return rootCheck;
  const rootReal = rootCheck.result;

  const parsed = parseSafeRelativePath(request.dirPath);
  if (!parsed.ok) return { ok: false, reason: 'OutsideRoot', detail: parsed.detail };

  const target = await resolveTargetInRoot(rootReal, parsed.path, 'dir');
  if (!target.ok) return target;
  if (target.result.kind !== 'dir') {
    return { ok: false, reason: 'UnsupportedFile', detail: 'Target path is not a directory' };
  }

  const { isGitRepo, gitExe } = await detectGitRepo(
    rootReal,
    request.gitExecutable,
    request.pathEnv,
  );
  const cursorKey = parseCursor(request.cursor);
  const pageLimit = clampPageLimit(request.limit);
  type Candidate = SortableDirent & { readonly direntIsDir: boolean; readonly ignored: boolean };
  const candidates: Candidate[] = [];
  const relPrefix = parsed.path.normalized === '' ? '' : `${parsed.path.normalized}/`;
  let batch: Omit<Candidate, 'ignored'>[] = [];
  const consumeBatch = async (): Promise<void> => {
    const ignoredPaths =
      isGitRepo && gitExe !== null
        ? await runGitCheckIgnore(
            gitExe,
            rootReal,
            request.pathEnv,
            batch.map((item) =>
              item.direntIsDir ? `${relPrefix}${item.name}/` : `${relPrefix}${item.name}`,
            ),
          )
        : new Set<string>();
    for (const item of batch) {
      const ignored = ignoredPaths.has(`${relPrefix}${item.name}`);
      if (ignored && !request.showIgnoredFiles) continue;
      candidates.push({ ...item, ignored });
    }
    candidates.sort(compareSortable);
    candidates.length = Math.min(candidates.length, pageLimit + 1);
    batch = [];
    await yieldEventLoop();
  };
  try {
    const directory = await opendir(target.result.targetPath);
    for await (const entry of directory) {
      if (isGitMetadataSegment(entry.name)) continue;
      const item: Omit<Candidate, 'ignored'> = {
        name: entry.name,
        bucket: entry.isDirectory() ? 0 : 1,
        direntIsDir: entry.isDirectory(),
      };
      if (cursorKey && compareSortable(item, cursorKey) <= 0) continue;
      batch.push(item);
      if (batch.length >= INTERNAL_BATCH_SIZE) await consumeBatch();
    }
    if (batch.length > 0) await consumeBatch();
  } catch (cause) {
    const code = errorCodeOf(cause);
    return {
      ok: false,
      reason: isMissingCode(code) ? 'NotFound' : 'IoFailed',
      detail: errorDetail(cause),
    };
  }
  const entries: FilesEntry[] = [];
  let hasMore = false;
  let lastEmitted: SortableDirent | null = null;
  for (const item of candidates) {
    const relPath = `${relPrefix}${item.name}`;
    const ignored = item.ignored;

    if (entries.length >= pageLimit) {
      hasMore = true;
      break;
    }

    const childAbs = join(target.result.targetPath, item.name);
    let kind: FilesEntryKind;
    let size: number | undefined;
    try {
      const info = await lstat(childAbs);
      kind = classifyLstatKind(info);
      if (kind === 'directory' && (await hasGitMarker(childAbs))) {
        kind = 'nestedRepo';
      }
      if (kind === 'file') {
        size = info.size;
      }
    } catch {
      continue;
    }

    entries.push({
      path: relPath,
      name: item.name,
      kind,
      ignored,
      ...(size === undefined ? {} : { size }),
    });
    lastEmitted = item;
  }

  return {
    ok: true,
    result: {
      dirPath: parsed.path.normalized,
      isGitRepo,
      showIgnoredFiles: request.showIgnoredFiles,
      entries,
      ...(hasMore && lastEmitted !== null ? { nextCursor: formatCursor(lastEmitted) } : {}),
      hasMore,
    },
  };
};

const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });

const trimTrailingIncompleteUtf8 = (buffer: Buffer): Buffer => {
  if (buffer.length === 0) return buffer;
  const start = Math.max(0, buffer.length - 4);
  for (let idx = buffer.length - 1; idx >= start; idx -= 1) {
    const byte = buffer[idx];
    if (byte === undefined) continue;
    if ((byte & 0xc0) === 0x80) continue;
    let expectedLen = 1;
    if ((byte & 0xe0) === 0xc0) expectedLen = 2;
    else if ((byte & 0xf0) === 0xe0) expectedLen = 3;
    else if ((byte & 0xf8) === 0xf0) expectedLen = 4;
    if (idx + expectedLen > buffer.length) {
      return buffer.subarray(0, idx);
    }
    break;
  }
  return buffer;
};

const isBinarySample = (sample: Buffer, totalSize: number): boolean => {
  if (sample.length === 0) return false;
  let controlCount = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) {
      controlCount += 1;
    }
  }
  if (controlCount / sample.length > 0.3) return true;

  const trimmed = totalSize > sample.length ? trimTrailingIncompleteUtf8(sample) : sample;
  try {
    utf8FatalDecoder.decode(trimmed);
    return false;
  } catch {
    return true;
  }
};

const clampPreviewLimit = (maxBytes: number): number => {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) return DEFAULT_FILES_PREVIEW_MAX_BYTES;
  return Math.min(DEFAULT_FILES_PREVIEW_MAX_BYTES, Math.floor(maxBytes));
};

/** Reads a bounded, read-only UTF-8 preview of a validated saved file, distinguishing binary, large, and unavailable states. */
export const readWorkspacePreview = async (request: {
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
  readonly relativePath: string;
  readonly maxBytes: number;
}): Promise<FilesWorkerResult<FilesPreview>> => {
  const rootCheck = await validateRootDirectory(request.rootPath, request.expectedRootIdentity);
  if (!rootCheck.ok) return rootCheck;
  const rootReal = rootCheck.result;

  const parsed = parseSafeRelativePath(request.relativePath);
  if (!parsed.ok) return { ok: false, reason: 'OutsideRoot', detail: parsed.detail };
  if (parsed.path.segments.length === 0) {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: '',
        reason: 'Directory',
        detail: 'Workspace root directory cannot be previewed',
      },
    };
  }

  const target = await resolveTargetInRoot(rootReal, parsed.path, 'preview');
  if (!target.ok) return target;

  if (target.result.kind === 'missing') {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: parsed.path.normalized,
        reason: 'Missing',
        detail: 'File is no longer available on disk',
      },
    };
  }
  if (target.result.kind === 'symlink') {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: parsed.path.normalized,
        reason: 'Symlink',
        detail: 'Symbolic links are not followed for preview',
      },
    };
  }
  if (target.result.kind === 'unreadable') {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: parsed.path.normalized,
        reason: 'Unreadable',
        detail: target.result.detail,
      },
    };
  }
  if (target.result.kind !== 'file') {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: parsed.path.normalized,
        reason: 'Directory',
        detail: 'Directories cannot be previewed as files',
      },
    };
  }

  // Note: resolveTargetInRoot treats directory final segment on preview mode carefully — double-check lstat below.
  if (target.result.stats.isDirectory()) {
    return {
      ok: true,
      result: {
        _tag: 'Unavailable',
        path: parsed.path.normalized,
        reason: 'Directory',
        detail: 'Directories cannot be previewed as files',
      },
    };
  }

  const limit = clampPreviewLimit(request.maxBytes);
  const openFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

  let handle;
  try {
    handle = await open(target.result.targetPath, openFlags);
  } catch (cause) {
    const code = errorCodeOf(cause);
    if (isMissingCode(code)) {
      return {
        ok: true,
        result: {
          _tag: 'Unavailable',
          path: parsed.path.normalized,
          reason: 'Missing',
          detail: 'File is no longer available on disk',
        },
      };
    }
    if (isPermissionCode(code)) {
      return {
        ok: true,
        result: {
          _tag: 'Unavailable',
          path: parsed.path.normalized,
          reason: 'Unreadable',
          detail: errorDetail(cause),
        },
      };
    }
    return { ok: false, reason: 'IoFailed', detail: errorDetail(cause) };
  }

  try {
    const fdStat = await handle.stat();
    if (!fdStat.isFile()) {
      return { ok: false, reason: 'UnsupportedFile', detail: 'Target is not a regular file' };
    }
    if (
      target.result.stats.ino !== 0 &&
      (fdStat.dev !== target.result.stats.dev || fdStat.ino !== target.result.stats.ino)
    ) {
      return {
        ok: false,
        reason: 'OutsideRoot',
        detail: 'File changed unexpectedly while opening for preview',
      };
    }

    const totalBytes = fdStat.size;
    const toRead = Math.min(totalBytes, limit);
    const sampleSize = Math.min(toRead, PREVIEW_SAMPLE_BYTES);
    const sampleBuf = Buffer.allocUnsafe(sampleSize);
    let sampleRead = 0;
    while (sampleRead < sampleSize) {
      const { bytesRead } = await handle.read(
        sampleBuf,
        sampleRead,
        sampleSize - sampleRead,
        sampleRead,
      );
      if (bytesRead === 0) break;
      sampleRead += bytesRead;
    }
    const actualSample = sampleBuf.subarray(0, sampleRead);

    if (isBinarySample(actualSample, totalBytes)) {
      return {
        ok: true,
        result: {
          _tag: 'Binary',
          path: parsed.path.normalized,
          totalBytes,
          mtimeMs: fdStat.mtimeMs,
        },
      };
    }

    let fullBuf = actualSample;
    if (toRead > sampleRead) {
      const restLen = toRead - sampleRead;
      const combined = Buffer.allocUnsafe(toRead);
      actualSample.copy(combined, 0);
      let offset = sampleRead;
      while (offset < toRead) {
        const { bytesRead } = await handle.read(combined, offset, toRead - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      fullBuf = combined.subarray(0, Math.min(offset, sampleRead + restLen));
    }

    const truncated = totalBytes > limit;
    const cleanSlice = truncated ? trimTrailingIncompleteUtf8(fullBuf) : fullBuf;
    if (cleanSlice.includes(0)) {
      return {
        ok: true,
        result: {
          _tag: 'Binary',
          path: parsed.path.normalized,
          totalBytes,
          mtimeMs: fdStat.mtimeMs,
        },
      };
    }
    let content: string;
    try {
      content = utf8FatalDecoder.decode(cleanSlice);
    } catch {
      return {
        ok: true,
        result: {
          _tag: 'Binary',
          path: parsed.path.normalized,
          totalBytes,
          mtimeMs: fdStat.mtimeMs,
        },
      };
    }

    return {
      ok: true,
      result: {
        _tag: 'Text',
        path: parsed.path.normalized,
        content,
        byteLength: cleanSlice.byteLength,
        totalBytes,
        truncated,
        previewLimitBytes: limit,
        mtimeMs: fdStat.mtimeMs,
      },
    };
  } catch (cause) {
    return { ok: false, reason: 'IoFailed', detail: errorDetail(cause) };
  } finally {
    await handle.close();
  }
};

/** Validates and resolves a regular file target safe to pass to `shell.openPath`. */
export const validateWorkspaceOpenTarget = async (request: {
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
  readonly relativePath: string;
}): Promise<FilesWorkerResult<{ readonly targetPath: string }>> => {
  const rootCheck = await validateRootDirectory(request.rootPath, request.expectedRootIdentity);
  if (!rootCheck.ok) return rootCheck;

  const parsed = parseSafeRelativePath(request.relativePath);
  if (!parsed.ok) return { ok: false, reason: 'OutsideRoot', detail: parsed.detail };
  if (parsed.path.segments.length === 0) {
    return { ok: false, reason: 'UnsupportedFile', detail: 'Cannot open root folder externally' };
  }

  const target = await resolveTargetInRoot(rootCheck.result, parsed.path, 'open');
  if (!target.ok) return target;
  if (target.result.kind !== 'file') {
    return {
      ok: false,
      reason: 'UnsupportedFile',
      detail: 'Only regular saved files can be opened',
    };
  }
  return { ok: true, result: { targetPath: target.result.targetPath } };
};

/** Dispatches `files.*` worker requests to bounded worker operations. */
export const handleFilesWorkerRequest = async (
  request: Extract<
    WorkerRequest,
    { readonly method: 'files.listDir' | 'files.readPreview' | 'files.validateOpenTarget' }
  >,
): Promise<WorkerResponse> => {
  switch (request.method) {
    case 'files.listDir': {
      const outcome = await listWorkspaceDir(request);
      return outcome.ok
        ? { id: request.id, ok: true, result: outcome.result }
        : { id: request.id, ok: false, reason: outcome.reason, detail: outcome.detail };
    }
    case 'files.readPreview': {
      const outcome = await readWorkspacePreview(request);
      return outcome.ok
        ? { id: request.id, ok: true, result: outcome.result }
        : { id: request.id, ok: false, reason: outcome.reason, detail: outcome.detail };
    }
    case 'files.validateOpenTarget': {
      const outcome = await validateWorkspaceOpenTarget(request);
      return outcome.ok
        ? { id: request.id, ok: true, result: outcome.result }
        : { id: request.id, ok: false, reason: outcome.reason, detail: outcome.detail };
    }
  }
};
