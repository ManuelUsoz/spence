import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { buildAddedTextHunks, parseUnifiedDiff } from './git-diff-parser';
import {
  MAX_PREVIEW_BYTES,
  countTextLines,
  detectActiveIntegration,
  existsSyncAsync,
  isMaxBufferError,
  lstatSnapshot,
  readBoundedTextFile,
  resolveEmptyTreeSha,
  resolveWorktreeContext,
  runGit,
  snapshotsEqual,
  validateRepoRelativePath,
  type GitWorktreeContext,
  type StatSnapshot,
} from './git-exec';
import type {
  WorkerAheadBehind,
  WorkerChangedFile,
  WorkerDiffPreview,
  WorkerDiffResult,
  WorkerDiffScope,
  WorkerExcludedEntry,
  WorkerFileChangeStatus,
  WorkerFileKind,
  WorkerFileSlotStatus,
  WorkerGitStatusResult,
  WorkerHeadState,
} from './worker-protocol';

export interface WorkerStabilityHooks {
  readonly onBeforeVerifyStability?: (relPath: string, attempt: number) => Promise<void> | void;
}

interface ParsedPorcelainEntry {
  readonly kindTag: '1' | '2' | 'u' | '?';
  readonly indexChar: string;
  readonly workChar: string;
  readonly submoduleState: string;
  readonly modeWorking: string;
  readonly modeHead: string;
  readonly path: string;
  readonly previousPath?: string;
}

interface ParsedStatusPorcelain {
  readonly branchOid: string;
  readonly branchHead: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly entries: ReadonlyArray<ParsedPorcelainEntry>;
}

interface NumstatRecord {
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  readonly previousPath?: string;
}

const ORDINARY_RE = /^1 (..) (....) ([0-7]+) ([0-7]+) ([0-7]+) (\S+) (\S+) (.*)$/s;
const RENAMED_RE = /^2 (..) (....) ([0-7]+) ([0-7]+) ([0-7]+) (\S+) (\S+) ([RC]\d+) (.*)$/s;
const UNMERGED_RE = /^u (..) (....) ([0-7]+) ([0-7]+) ([0-7]+) ([0-7]+) (\S+) (\S+) (\S+) (.*)$/s;
const NUMSTAT_RE = /^(-|\d+)\t(-|\d+)\t(.*)$/s;

export const parseStatusPorcelainV2 = (stdout: string): ParsedStatusPorcelain => {
  const tokens = stdout.split('\0');
  let branchOid = '';
  let branchHead = '';
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const entries: ParsedPorcelainEntry[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '') continue;

    if (token.startsWith('# branch.oid ')) {
      branchOid = token.slice('# branch.oid '.length).trim();
      continue;
    }
    if (token.startsWith('# branch.head ')) {
      branchHead = token.slice('# branch.head '.length).trim();
      continue;
    }
    if (token.startsWith('# branch.upstream ')) {
      upstream = token.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (token.startsWith('# branch.ab ')) {
      const abMatch = /^\+(\d+) -(\d+)$/.exec(token.slice('# branch.ab '.length).trim());
      if (abMatch !== null) {
        ahead = Number(abMatch[1] ?? '0');
        behind = Number(abMatch[2] ?? '0');
      }
      continue;
    }
    if (token.startsWith('# ')) continue;

    if (token.startsWith('? ')) {
      entries.push({
        kindTag: '?',
        indexChar: '?',
        workChar: '?',
        submoduleState: 'N...',
        modeWorking: '000000',
        modeHead: '000000',
        path: token.slice(2),
      });
      continue;
    }

    const ord = ORDINARY_RE.exec(token);
    if (ord !== null) {
      const xy = ord[1] ?? '..';
      entries.push({
        kindTag: '1',
        indexChar: xy[0] ?? '.',
        workChar: xy[1] ?? '.',
        submoduleState: ord[2] ?? 'N...',
        modeHead: ord[3] ?? '000000',
        modeWorking: ord[5] ?? '000000',
        path: ord[8] ?? '',
      });
      continue;
    }

    const ren = RENAMED_RE.exec(token);
    if (ren !== null) {
      const xy = ren[1] ?? '..';
      const origPath = tokens[i + 1];
      i += 1;
      entries.push({
        kindTag: '2',
        indexChar: xy[0] ?? '.',
        workChar: xy[1] ?? '.',
        submoduleState: ren[2] ?? 'N...',
        modeHead: ren[3] ?? '000000',
        modeWorking: ren[5] ?? '000000',
        path: ren[9] ?? '',
        ...(origPath === undefined ? {} : { previousPath: origPath }),
      });
      continue;
    }

    const unm = UNMERGED_RE.exec(token);
    if (unm !== null) {
      const xy = unm[1] ?? 'UU';
      entries.push({
        kindTag: 'u',
        indexChar: xy[0] ?? 'U',
        workChar: xy[1] ?? 'U',
        submoduleState: unm[2] ?? 'N...',
        modeHead: '000000',
        modeWorking: unm[6] ?? '000000',
        path: unm[10] ?? '',
      });
    }
  }

  return {
    branchOid,
    branchHead,
    ...(upstream === undefined ? {} : { upstream }),
    ahead,
    behind,
    entries,
  };
};

export const parseNumstatZ = (stdout: string): ReadonlyMap<string, NumstatRecord> => {
  const tokens = stdout.split('\0');
  const map = new Map<string, NumstatRecord>();

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined || token === '') continue;
    const match = NUMSTAT_RE.exec(token);
    if (match === null) continue;

    const addRaw = match[1] ?? '0';
    const delRaw = match[2] ?? '0';
    const restPath = match[3] ?? '';
    const binary = addRaw === '-' || delRaw === '-';
    const additions = binary ? null : Number(addRaw);
    const deletions = binary ? null : Number(delRaw);

    if (restPath === '') {
      const previousPath = tokens[i + 1] ?? '';
      const newPath = tokens[i + 2] ?? '';
      i += 2;
      if (newPath.length > 0) {
        map.set(newPath, {
          additions,
          deletions,
          binary,
          ...(previousPath.length > 0 ? { previousPath } : {}),
        });
      }
      continue;
    }

    map.set(restPath, { additions, deletions, binary });
  }

  return map;
};

const mapSlotStatus = (ch: string, isConflict: boolean): WorkerFileSlotStatus => {
  if (isConflict) return 'Conflicted';
  switch (ch) {
    case '.':
      return 'Unmodified';
    case 'A':
      return 'Added';
    case 'M':
      return 'Modified';
    case 'D':
      return 'Deleted';
    case 'R':
      return 'Renamed';
    case 'C':
      return 'Copied';
    case 'T':
      return 'TypeChanged';
    case '?':
      return 'Untracked';
    case 'U':
      return 'Conflicted';
    default:
      return 'Modified';
  }
};

const derivePrimaryStatus = (entry: ParsedPorcelainEntry): WorkerFileChangeStatus => {
  if (entry.kindTag === 'u') return 'Conflicted';
  if (entry.kindTag === '?') return 'Untracked';
  if (entry.indexChar === 'R' || entry.workChar === 'R') return 'Renamed';
  if (entry.indexChar === 'C' || entry.workChar === 'C') return 'Copied';
  if (entry.workChar === 'D' || entry.indexChar === 'D') return 'Deleted';
  if (entry.indexChar === 'A') return 'Added';
  if (entry.indexChar === 'T' || entry.workChar === 'T') return 'TypeChanged';
  return 'Modified';
};

const deriveHeadState = (parsed: ParsedStatusPorcelain): WorkerHeadState => {
  if (parsed.branchOid === '(initial)') {
    const branch =
      parsed.branchHead && parsed.branchHead !== '(detached)' ? parsed.branchHead : 'HEAD';
    return {
      _tag: 'Unborn',
      branch,
      ref: `refs/heads/${branch}`,
    };
  }
  if (parsed.branchHead === '(detached)' || parsed.branchHead === '') {
    return {
      _tag: 'Detached',
      commit: parsed.branchOid,
    };
  }
  return {
    _tag: 'Branch',
    branch: parsed.branchHead,
    ref: `refs/heads/${parsed.branchHead}`,
    ...(parsed.branchOid.length > 0 ? { commit: parsed.branchOid } : {}),
  };
};

const checkTrackedBlobSizeTooLarge = async (
  ctx: GitWorktreeContext,
  pathEnv: string,
  specifier: string,
): Promise<number | null> => {
  const sizeRes = await runGit(
    ctx.executable,
    ['cat-file', '-s', specifier],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!sizeRes.ok) return null;
  const parsed = Number(sizeRes.stdout.trim());
  if (!Number.isFinite(parsed) || parsed <= MAX_PREVIEW_BYTES) return null;
  return parsed;
};

const inspectTrackedKind = async (
  entry: ParsedPorcelainEntry,
  fullPath: string,
  numstat: NumstatRecord | undefined,
): Promise<{
  readonly kind: WorkerFileKind;
  readonly byteSize?: number;
}> => {
  if (
    entry.submoduleState.startsWith('S') ||
    entry.modeWorking === '160000' ||
    entry.modeHead === '160000'
  ) {
    return { kind: 'Submodule' };
  }
  if (entry.modeWorking === '120000' || entry.modeHead === '120000') {
    return { kind: 'Symlink' };
  }
  if (numstat?.binary === true) {
    return { kind: 'Binary' };
  }

  const snap = await lstatSnapshot(fullPath);
  if (snap.kind === 'symlink') return { kind: 'Symlink' };
  if (snap.kind === 'special') return { kind: 'Special' };
  if (snap.kind === 'file' && snap.size > MAX_PREVIEW_BYTES) {
    return { kind: 'TooLarge', byteSize: snap.size };
  }
  return { kind: 'Regular' };
};

const hasNestedGitInParents = async (
  toplevelRealPath: string,
  relPath: string,
): Promise<boolean> => {
  const segments = relPath.split('/');
  let current = toplevelRealPath;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (seg === undefined) break;
    current = path.join(current, seg);
    if (await existsSyncAsync(path.join(current, '.git'))) {
      return true;
    }
  }
  return false;
};

const inspectUntrackedFileWithRetry = async (
  relPath: string,
  fullPath: string,
  hooks?: WorkerStabilityHooks,
): Promise<{
  readonly kind: WorkerFileKind;
  readonly additions: number | null;
  readonly byteSize?: number;
  readonly unstable: boolean;
}> => {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const before = await lstatSnapshot(fullPath);
    if (before.kind === 'missing') {
      if (attempt === 1) {
        await hooks?.onBeforeVerifyStability?.(relPath, attempt);
        continue;
      }
      return { kind: 'Missing', additions: null, unstable: true };
    }
    if (before.kind === 'symlink') {
      await hooks?.onBeforeVerifyStability?.(relPath, attempt);
      const after = await lstatSnapshot(fullPath);
      const unstable = !snapshotsEqual(before, after);
      if (unstable && attempt === 1) continue;
      return { kind: 'Symlink', additions: null, unstable };
    }
    if (before.kind === 'special' || before.kind === 'dir') {
      return { kind: 'Special', additions: null, unstable: false };
    }
    if (before.size > MAX_PREVIEW_BYTES) {
      await hooks?.onBeforeVerifyStability?.(relPath, attempt);
      const after = await lstatSnapshot(fullPath);
      const unstable = !snapshotsEqual(before, after);
      if (unstable && attempt === 1) continue;
      return { kind: 'TooLarge', additions: null, byteSize: before.size, unstable };
    }

    const readRes = await readBoundedTextFile(fullPath, before.size);
    await hooks?.onBeforeVerifyStability?.(relPath, attempt);
    const after = await lstatSnapshot(fullPath);
    const drifted = !snapshotsEqual(before, after);
    if (drifted && attempt === 1) {
      continue;
    }

    switch (readRes.kind) {
      case 'binary':
        return { kind: 'Binary', additions: null, unstable: drifted };
      case 'tooLarge':
        return {
          kind: 'TooLarge',
          additions: null,
          byteSize: readRes.byteSize,
          unstable: drifted,
        };
      case 'unreadable':
        return { kind: 'Unreadable', additions: null, unstable: drifted };
      case 'text':
        return {
          kind: 'Regular',
          additions: countTextLines(readRes.text),
          unstable: drifted,
        };
    }
  }
  return { kind: 'Unreadable', additions: null, unstable: true };
};

export const inspectGitStatus = async (
  folder: string,
  gitExecutable: string | null,
  pathEnv: string,
  hooks?: WorkerStabilityHooks,
): Promise<WorkerGitStatusResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;

  const integration = await detectActiveIntegration(ctx.gitDirRealPath);
  const statusRes = await runGit(
    ctx.executable,
    ['-c', 'core.quotepath=false', 'status', '--porcelain=v2', '--branch', '-z', '-uall'],
    ctx.toplevelRealPath,
    pathEnv,
  );
  if (!statusRes.ok) {
    return {
      _tag: 'UnsupportedRepo',
      path: folder,
      detail: statusRes.stderr.trim() || 'Unable to inspect Git status.',
    };
  }

  const parsedStatus = parseStatusPorcelainV2(statusRes.stdout);
  const head = deriveHeadState(parsedStatus);
  const isUnborn = head._tag === 'Unborn';

  let combinedNumstat: ReadonlyMap<string, NumstatRecord> = new Map();
  let cachedNumstat: ReadonlyMap<string, NumstatRecord> = new Map();

  // Pre-capture lstat snapshots for tracked files that still exist on disk to detect concurrent writes.
  const trackedSnapshotsBefore = new Map<string, StatSnapshot>();
  for (const entry of parsedStatus.entries) {
    if (entry.kindTag === '?') continue;
    const valid = await validateRepoRelativePath(ctx.toplevelRealPath, entry.path, {
      checkFilesystem: false,
    });
    if (valid.ok) {
      trackedSnapshotsBefore.set(entry.path, await lstatSnapshot(valid.fullPath));
    }
  }

  if (isUnborn) {
    const emptyTreeSha = await resolveEmptyTreeSha(ctx.executable, ctx.toplevelRealPath, pathEnv);
    if (emptyTreeSha !== null) {
      const unbornDiffRes = await runGit(
        ctx.executable,
        ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', emptyTreeSha],
        ctx.toplevelRealPath,
        pathEnv,
      );
      if (unbornDiffRes.ok) {
        combinedNumstat = parseNumstatZ(unbornDiffRes.stdout);
      }
    }
    const cachedRes = await runGit(
      ctx.executable,
      ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '--cached'],
      ctx.toplevelRealPath,
      pathEnv,
    );
    if (cachedRes.ok) {
      cachedNumstat = parseNumstatZ(cachedRes.stdout);
    }
  } else {
    const headDiffRes = await runGit(
      ctx.executable,
      ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', 'HEAD'],
      ctx.toplevelRealPath,
      pathEnv,
    );
    if (headDiffRes.ok) {
      combinedNumstat = parseNumstatZ(headDiffRes.stdout);
    }
    const cachedRes = await runGit(
      ctx.executable,
      ['-c', 'core.quotepath=false', 'diff', '--numstat', '-z', '--cached', 'HEAD'],
      ctx.toplevelRealPath,
      pathEnv,
    );
    if (cachedRes.ok) {
      cachedNumstat = parseNumstatZ(cachedRes.stdout);
    }
  }

  const files: WorkerChangedFile[] = [];
  const excludedEntries: WorkerExcludedEntry[] = [];
  const unstablePaths = new Set<string>();
  let incompleteDiffCounts = false;
  let hasConflicts = false;

  for (const entry of parsedStatus.entries) {
    if (entry.kindTag === '?') {
      const isDirEntry = entry.path.endsWith('/');
      const trimmedPath = isDirEntry ? entry.path.slice(0, -1) : entry.path;
      const valid = await validateRepoRelativePath(ctx.toplevelRealPath, trimmedPath);
      if (!valid.ok) {
        excludedEntries.push({
          path: trimmedPath,
          reason: 'UnsafePath',
          detail: valid.detail,
        });
        continue;
      }
      if (isDirEntry) {
        if (await existsSyncAsync(path.join(valid.fullPath, '.git'))) {
          excludedEntries.push({
            path: valid.normalized,
            reason: 'NestedRepo',
            detail: 'Nested Git repository excluded from parent Worktree inspection.',
          });
        }
        continue;
      }
      if (await hasNestedGitInParents(ctx.toplevelRealPath, valid.normalized)) {
        excludedEntries.push({
          path: valid.normalized,
          reason: 'NestedRepo',
          detail: 'Nested Git repository excluded from parent Worktree inspection.',
        });
        continue;
      }

      const untracked = await inspectUntrackedFileWithRetry(
        valid.normalized,
        valid.fullPath,
        hooks,
      );
      if (untracked.unstable) {
        unstablePaths.add(valid.normalized);
      }
      if (untracked.additions === null) {
        incompleteDiffCounts = true;
      }
      files.push({
        path: valid.normalized,
        status: 'Untracked',
        indexStatus: 'Untracked',
        workTreeStatus: 'Untracked',
        staged: false,
        unstaged: true,
        hasStagedAndUnstaged: false,
        stagedNetZeroWorking: false,
        kind: untracked.kind,
        additions: untracked.additions,
        deletions: untracked.additions === null ? null : 0,
        ...(untracked.byteSize === undefined ? {} : { byteSize: untracked.byteSize }),
        ...(untracked.unstable ? { unstable: true } : {}),
      });
      continue;
    }

    const valid = await validateRepoRelativePath(ctx.toplevelRealPath, entry.path);
    if (!valid.ok) {
      excludedEntries.push({
        path: entry.path,
        reason: 'UnsafePath',
        detail: valid.detail,
      });
      continue;
    }

    await hooks?.onBeforeVerifyStability?.(valid.normalized, 1);
    const snapBefore = trackedSnapshotsBefore.get(entry.path);
    const snapAfter = await lstatSnapshot(valid.fullPath);
    const trackedUnstable = snapBefore !== undefined && !snapshotsEqual(snapBefore, snapAfter);
    if (trackedUnstable) {
      unstablePaths.add(valid.normalized);
    }

    const isConflict = entry.kindTag === 'u';
    if (isConflict) {
      hasConflicts = true;
    }

    const staged = !isConflict && entry.indexChar !== '.';
    const unstaged = !isConflict && entry.workChar !== '.';
    const hasStagedAndUnstaged = staged && unstaged;
    const numstat = combinedNumstat.get(valid.normalized) ?? combinedNumstat.get(entry.path);
    const cached = cachedNumstat.get(valid.normalized) ?? cachedNumstat.get(entry.path);

    const stagedNetZeroWorking =
      hasStagedAndUnstaged && numstat === undefined && cached !== undefined;
    const kindInfo = await inspectTrackedKind(entry, valid.fullPath, numstat);

    const primaryStatus = derivePrimaryStatus(entry);
    let additions = numstat ? numstat.additions : stagedNetZeroWorking ? 0 : null;
    let deletions = numstat ? numstat.deletions : stagedNetZeroWorking ? 0 : null;

    if (
      kindInfo.kind === 'Binary' ||
      kindInfo.kind === 'Symlink' ||
      kindInfo.kind === 'Submodule' ||
      kindInfo.kind === 'Special'
    ) {
      additions = null;
      deletions = null;
    } else if (kindInfo.kind === 'TooLarge' && numstat === undefined) {
      additions = null;
      deletions = null;
    } else if (additions === null || deletions === null) {
      // Typechange or rename without line diff counts still shouldn't pretend line diff is complete.
      if (primaryStatus === 'Renamed' && numstat === undefined) {
        additions = 0;
        deletions = 0;
      }
    }

    if (additions === null || deletions === null) {
      incompleteDiffCounts = true;
    }

    files.push({
      path: valid.normalized,
      ...(entry.previousPath === undefined ? {} : { previousPath: entry.previousPath }),
      status: primaryStatus,
      indexStatus: mapSlotStatus(entry.indexChar, isConflict),
      workTreeStatus: mapSlotStatus(entry.workChar, isConflict),
      staged,
      unstaged,
      hasStagedAndUnstaged,
      stagedNetZeroWorking,
      kind: kindInfo.kind,
      additions,
      deletions,
      ...(kindInfo.byteSize === undefined ? {} : { byteSize: kindInfo.byteSize }),
      ...(trackedUnstable ? { unstable: true } : {}),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const aheadBehind: WorkerAheadBehind | undefined =
    parsedStatus.upstream === undefined
      ? undefined
      : {
          upstream: parsedStatus.upstream,
          ahead: parsedStatus.ahead,
          behind: parsedStatus.behind,
        };

  const unstableList = [...unstablePaths].sort();
  return {
    _tag: 'Available',
    gitVersion: ctx.gitVersion,
    executable: ctx.executable,
    folderRealPath: ctx.folderRealPath,
    toplevelRealPath: ctx.toplevelRealPath,
    gitDirRealPath: ctx.gitDirRealPath,
    head,
    ...(aheadBehind === undefined ? {} : { aheadBehind }),
    integration,
    hasConflicts,
    unstablePaths: unstableList,
    ...(unstableList.length > 0
      ? {
          instabilityDetail: `Detected concurrent edits while inspecting ${unstableList.join(', ')}.`,
        }
      : {}),
    excludedEntries,
    incompleteDiffCounts,
    files,
  };
};

const safeReadSymlinkTarget = async (fullPath: string): Promise<string | undefined> => {
  try {
    return await readlink(fullPath);
  } catch {
    return undefined;
  }
};

const runTrackedDiffAttempt = async (
  ctx: GitWorktreeContext,
  relPath: string,
  fullPath: string,
  scope: WorkerDiffScope,
  pathEnv: string,
  isUnborn: boolean,
  entry: ParsedPorcelainEntry | undefined,
): Promise<WorkerDiffPreview> => {
  const beforeSnap = await lstatSnapshot(fullPath);

  if (
    entry !== undefined &&
    (entry.submoduleState.startsWith('S') ||
      entry.modeWorking === '160000' ||
      entry.modeHead === '160000')
  ) {
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'Submodule',
      detail: 'Submodule or nested repository pointer changed; inline file diff is unavailable.',
      unstable: false,
    };
  }

  if (
    beforeSnap.kind === 'symlink' ||
    entry?.modeWorking === '120000' ||
    entry?.modeHead === '120000'
  ) {
    const symlinkTarget =
      beforeSnap.kind === 'symlink' ? await safeReadSymlinkTarget(fullPath) : undefined;
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'Symlink',
      detail: 'Symbolic links are not dereferenced for inline diff inspection.',
      ...(symlinkTarget === undefined ? {} : { symlinkTarget }),
      unstable: false,
    };
  }

  if (entry?.kindTag === '?') {
    if (scope === 'staged') {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'NoDifference',
        detail: 'Untracked file has no staged changes.',
        unstable: false,
      };
    }
    if (beforeSnap.kind === 'missing') {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'MissingFile',
        detail: 'File is no longer present on disk.',
        unstable: false,
      };
    }
    if (beforeSnap.kind === 'special' || beforeSnap.kind === 'dir') {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'SpecialFile',
        detail: 'Special filesystem entry cannot be previewed as text.',
        unstable: false,
      };
    }
    const readRes = await readBoundedTextFile(fullPath, beforeSnap.size);
    switch (readRes.kind) {
      case 'binary':
        return {
          _tag: 'Unavailable',
          path: relPath,
          scope,
          reason: 'Binary',
          detail: 'Binary file cannot be displayed as an inline text diff.',
          unstable: false,
        };
      case 'tooLarge':
        return {
          _tag: 'Unavailable',
          path: relPath,
          scope,
          reason: 'TooLarge',
          detail: `File exceeds the ${String(MAX_PREVIEW_BYTES)} byte inline preview limit.`,
          byteSize: readRes.byteSize,
          limitBytes: MAX_PREVIEW_BYTES,
          unstable: false,
        };
      case 'unreadable':
        return {
          _tag: 'Unavailable',
          path: relPath,
          scope,
          reason: 'Unreadable',
          detail: readRes.detail,
          unstable: false,
        };
      case 'text': {
        const built = buildAddedTextHunks(readRes.text);
        return {
          _tag: 'Patch',
          path: relPath,
          scope,
          hunks: built.hunks,
          additions: built.additions,
          deletions: 0,
          truncated: built.truncated,
          ...(built.truncationDetail === undefined
            ? {}
            : { truncationDetail: built.truncationDetail }),
          unstable: false,
        };
      }
    }
  }

  if (beforeSnap.kind === 'special') {
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'SpecialFile',
      detail: 'Special filesystem entry cannot be previewed as text.',
      unstable: false,
    };
  }

  if (scope !== 'staged' && beforeSnap.kind === 'file' && beforeSnap.size > MAX_PREVIEW_BYTES) {
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'TooLarge',
      detail: `File exceeds the ${String(MAX_PREVIEW_BYTES)} byte inline preview limit.`,
      byteSize: beforeSnap.size,
      limitBytes: MAX_PREVIEW_BYTES,
      unstable: false,
    };
  }

  // Guard deleted or staged blobs larger than the inline preview limit before invoking git diff.
  if (scope === 'staged' || beforeSnap.kind === 'missing') {
    const headSize = isUnborn
      ? null
      : await checkTrackedBlobSizeTooLarge(ctx, pathEnv, `HEAD:${relPath}`);
    const indexSize = await checkTrackedBlobSizeTooLarge(ctx, pathEnv, `:${relPath}`);
    const tooBig = headSize ?? indexSize;
    if (tooBig !== null) {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'TooLarge',
        detail: `Blob exceeds the ${String(MAX_PREVIEW_BYTES)} byte inline preview limit.`,
        byteSize: tooBig,
        limitBytes: MAX_PREVIEW_BYTES,
        unstable: false,
      };
    }
  }

  let emptyTreeSha: string | null = null;
  if (isUnborn && scope !== 'unstaged') {
    emptyTreeSha = await resolveEmptyTreeSha(ctx.executable, ctx.toplevelRealPath, pathEnv);
    if (emptyTreeSha === null) {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'Unreadable',
        detail: 'Unable to compute empty Git tree for unborn branch diff.',
        unstable: false,
      };
    }
  }

  let args: ReadonlyArray<string>;
  if (scope === 'staged') {
    args =
      isUnborn && emptyTreeSha !== null
        ? [
            '-c',
            'core.quotepath=false',
            'diff',
            '--no-ext-diff',
            '--no-color',
            '-U3',
            '--cached',
            emptyTreeSha,
            '--',
            relPath,
          ]
        : [
            '-c',
            'core.quotepath=false',
            'diff',
            '--no-ext-diff',
            '--no-color',
            '-U3',
            '--cached',
            'HEAD',
            '--',
            relPath,
          ];
  } else if (scope === 'unstaged') {
    args = [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '--no-color',
      '-U3',
      '--',
      relPath,
    ];
  } else {
    args =
      isUnborn && emptyTreeSha !== null
        ? [
            '-c',
            'core.quotepath=false',
            'diff',
            '--no-ext-diff',
            '--no-color',
            '-U3',
            emptyTreeSha,
            '--',
            relPath,
          ]
        : [
            '-c',
            'core.quotepath=false',
            'diff',
            '--no-ext-diff',
            '--no-color',
            '-U3',
            'HEAD',
            '--',
            relPath,
          ];
  }

  const diffRes = await runGit(ctx.executable, args, ctx.toplevelRealPath, pathEnv);
  if (!diffRes.ok) {
    if (isMaxBufferError(diffRes)) {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'TooLarge',
        detail: 'Diff output exceeded preview buffer cap.',
        limitBytes: MAX_PREVIEW_BYTES,
        unstable: false,
      };
    }
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'Unreadable',
      detail: diffRes.stderr.trim() || 'Git diff failed for target path.',
      unstable: false,
    };
  }

  const parsed = parseUnifiedDiff(diffRes.stdout);
  if (parsed.isBinary) {
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'Binary',
      detail: 'Binary file changes cannot be displayed as an inline text diff.',
      unstable: false,
    };
  }

  if (parsed.hunks.length === 0 && diffRes.stdout.trim().length === 0) {
    const staged = entry !== undefined && entry.indexChar !== '.';
    if (scope === 'combined' && staged) {
      return {
        _tag: 'Unavailable',
        path: relPath,
        scope,
        reason: 'NoDifference',
        detail:
          'Working tree contents match the base revision while staged changes remain in the index.',
        hasStagedChanges: true,
        unstable: false,
      };
    }
    return {
      _tag: 'Unavailable',
      path: relPath,
      scope,
      reason: 'NoDifference',
      detail: 'No textual differences found in the selected scope.',
      unstable: false,
    };
  }

  return {
    _tag: 'Patch',
    path: relPath,
    ...(entry?.previousPath !== undefined
      ? { previousPath: entry.previousPath }
      : parsed.previousPath !== undefined
        ? { previousPath: parsed.previousPath }
        : {}),
    scope,
    hunks: parsed.hunks,
    additions: parsed.additions,
    deletions: parsed.deletions,
    truncated: parsed.truncated,
    ...(parsed.truncationDetail === undefined ? {} : { truncationDetail: parsed.truncationDetail }),
    unstable: false,
  };
};

export const inspectGitDiff = async (
  folder: string,
  relPath: string,
  scope: WorkerDiffScope,
  gitExecutable: string | null,
  pathEnv: string,
  hooks?: WorkerStabilityHooks,
): Promise<WorkerDiffResult> => {
  const ctx = await resolveWorktreeContext(folder, gitExecutable, pathEnv);
  if (ctx._tag !== 'Available') return ctx;

  const valid = await validateRepoRelativePath(ctx.toplevelRealPath, relPath);
  if (!valid.ok) {
    return {
      _tag: 'InvalidPath',
      path: relPath,
      detail: valid.detail,
    };
  }
  if (await hasNestedGitInParents(ctx.toplevelRealPath, valid.normalized)) {
    return {
      _tag: 'InvalidPath',
      path: relPath,
      detail: 'Refused inspecting path inside a nested Git repository.',
    };
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const statusRes = await runGit(
      ctx.executable,
      [
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--',
        valid.normalized,
      ],
      ctx.toplevelRealPath,
      pathEnv,
    );
    const parsedStatus = statusRes.ok ? parseStatusPorcelainV2(statusRes.stdout) : null;
    const isUnborn = parsedStatus?.branchOid === '(initial)';
    const entry = parsedStatus?.entries.find(
      (item) => item.path === valid.normalized || item.path === relPath,
    );

    const beforeSnap = await lstatSnapshot(valid.fullPath);
    const previewCore = await runTrackedDiffAttempt(
      ctx,
      valid.normalized,
      valid.fullPath,
      scope,
      pathEnv,
      isUnborn,
      entry,
    );
    await hooks?.onBeforeVerifyStability?.(valid.normalized, attempt);
    const afterSnap = await lstatSnapshot(valid.fullPath);
    const drifted = !snapshotsEqual(beforeSnap, afterSnap);

    if (drifted && attempt === 1) {
      continue;
    }

    const preview: WorkerDiffPreview = {
      ...previewCore,
      unstable: drifted,
      ...(drifted
        ? {
            instabilityDetail: `File "${valid.normalized}" changed on disk during diff capture.`,
          }
        : {}),
    };
    return { _tag: 'Available', preview };
  }

  return {
    _tag: 'Available',
    preview: {
      _tag: 'Unavailable',
      path: valid.normalized,
      scope,
      reason: 'Unreadable',
      detail: 'File remained unstable across inspection retries.',
      unstable: true,
      instabilityDetail: `File "${valid.normalized}" changed continuously during diff capture.`,
    },
  };
};
