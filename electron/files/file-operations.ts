import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  opendir,
  realpath,
  readlink,
  rename as fsRename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { Cause, Context, Effect, Exit, Layer, Option } from 'effect';
import type { FilesRootTarget } from '../../src/shared/files/files.rpc';
import {
  FileOperationsError,
  type FileOperationBlocker,
  type FileOperationCreateKind,
  type FileOperationReview,
  type FileOperationReviewTarget,
} from '../../src/shared/files/file-operations.rpc';
import {
  SourceControlError,
  type OperationId,
  type OperationPathResult,
  type OperationSnapshot,
  type ReviewId,
} from '../../src/shared/source-control/source-control.rpc';
import { PathSources } from '../agents/merged-path';
import { folderKey } from '../projects/folder-key';
import { Projects } from '../projects/projects';
import {
  Operations,
  type DurableOperationRecord,
  type OperationReconciliationOutcome,
} from '../source-control/operations';
import { reservationKeys } from '../source-control/reservation-coordinator';
import type { ReservationCoordinator } from '../source-control/reservation-coordinator';
import { ReviewRegistry } from '../source-control/review-registry';
import { Worktrees } from '../worktrees/worktrees';
import {
  classifyLstatKind,
  hasGitMarker,
  isPathWithinRoot,
  parseSafeRelativePath,
} from '../worker/files-worker-core';
import { Trash, type TrashShape } from './trash';

const FINGERPRINT_DIGEST_CAP_BYTES = 64 * 1024;
const NESTED_REPO_MAX_DEPTH = 8;
const NESTED_REPO_MAX_ENTRIES = 1000;

interface ReviewPayload {
  readonly kind: 'Files.create' | 'Files.rename' | 'Files.delete';
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
  readonly targetPaths: ReadonlyArray<string>;
  readonly destinations?: ReadonlyArray<string>;
  readonly fingerprint: string;
  readonly mode: 'normal' | 'trash' | 'permanent';
  readonly createKind?: 'file' | 'folder';
  readonly allowOverwrite?: boolean;
}

interface ValidatedRoot {
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
}

interface FileSystemState {
  readonly exists: boolean;
  readonly kind: FileOperationReviewTarget['kind'];
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly digest?: string | null;
  readonly linkTarget?: string;
}

interface PathOperationResult {
  readonly status: 'Completed' | 'Failed' | 'Untouched';
  readonly detail?: string;
}

export interface FileOperationsShape {
  readonly reviewCreate: (input: {
    readonly target: FilesRootTarget;
    readonly dirPath: string;
    readonly name: string;
    readonly kind: FileOperationCreateKind;
  }) => Effect.Effect<FileOperationReview, FileOperationsError>;
  readonly reviewRename: (input: {
    readonly target: FilesRootTarget;
    readonly relativePath: string;
    readonly newName: string;
    readonly allowOverwrite?: boolean;
  }) => Effect.Effect<FileOperationReview, FileOperationsError>;
  readonly reviewDelete: (input: {
    readonly target: FilesRootTarget;
    readonly relativePaths: ReadonlyArray<string>;
    readonly permanent?: boolean;
  }) => Effect.Effect<FileOperationReview, FileOperationsError>;
  readonly execute: (input: {
    readonly reviewId: ReviewId;
    readonly operationId: OperationId;
    readonly allowPermanentDelete?: boolean;
  }) => Effect.Effect<OperationSnapshot, FileOperationsError>;
}

/** Domain service coordinating reviewed, durable create/rename/delete file operations. */
export class FileOperations extends Context.Service<FileOperations, FileOperationsShape>()(
  'files/FileOperations',
) {}

const sha256Hex = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const sha256File = async (absolutePath: string): Promise<string> => {
  const buffer = await readFileBounded(absolutePath, FINGERPRINT_DIGEST_CAP_BYTES);
  return createHash('sha256').update(buffer).digest('hex');
};

const readFileBounded = async (absolutePath: string, maxBytes: number): Promise<Buffer> => {
  const handle = await import('node:fs/promises').then((m) => m.open(absolutePath, 'r'));
  try {
    const { size } = await handle.stat();
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(toRead);
    let offset = 0;
    while (offset < toRead) {
      const { bytesRead } = await handle.read(buf, offset, toRead - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await handle.close();
  }
};

const mapSourceControlError = (err: SourceControlError): FileOperationsError => {
  switch (err.reason) {
    case 'StaleReview':
      return new FileOperationsError({ reason: 'StaleReview', detail: err.detail });
    case 'ReviewExpired':
      return new FileOperationsError({ reason: 'ReviewExpired', detail: err.detail });
    case 'Conflict':
      return new FileOperationsError({ reason: 'Conflict', detail: err.detail });
    case 'Busy':
      return new FileOperationsError({ reason: 'Busy', detail: err.detail });
    case 'RecoveryRequired':
      return new FileOperationsError({ reason: 'RecoveryRequired', detail: err.detail });
    case 'InvalidInput':
      return new FileOperationsError({ reason: 'InvalidInput', detail: err.detail });
    case 'NotFound':
      return new FileOperationsError({ reason: 'NotFound', detail: err.detail });
    case 'MissingPath':
      return new FileOperationsError({ reason: 'NotFound', detail: err.detail });
    case 'UntrustedPath':
      return new FileOperationsError({ reason: 'OutsideRoot', detail: err.detail });
    case 'WorkerFailed':
    case 'OperationFailed':
      return new FileOperationsError({ reason: 'WorkerFailed', detail: err.detail });
    case 'MissingGit':
    case 'NonGit':
    case 'UnsupportedRepo':
    case 'WorktreeMissing':
      return new FileOperationsError({ reason: 'IoFailed', detail: err.detail });
  }
};

const toSourceControlError = (err: FileOperationsError): SourceControlError => {
  switch (err.reason) {
    case 'StaleReview':
      return new SourceControlError({ reason: 'StaleReview', detail: err.detail });
    case 'ReviewExpired':
      return new SourceControlError({ reason: 'ReviewExpired', detail: err.detail });
    case 'Conflict':
      return new SourceControlError({ reason: 'Conflict', detail: err.detail });
    case 'Busy':
      return new SourceControlError({ reason: 'Busy', detail: err.detail });
    case 'RecoveryRequired':
      return new SourceControlError({ reason: 'RecoveryRequired', detail: err.detail });
    case 'InvalidInput':
      return new SourceControlError({ reason: 'InvalidInput', detail: err.detail });
    case 'NotFound':
      return new SourceControlError({ reason: 'NotFound', detail: err.detail });
    case 'ProtectedPath':
    case 'OutsideRoot':
      return new SourceControlError({ reason: 'UntrustedPath', detail: err.detail });
    case 'UnsupportedFile':
      return new SourceControlError({ reason: 'OperationFailed', detail: err.detail });
    case 'TrashUnavailable':
    case 'PermanentDeleteRequired':
      return new SourceControlError({ reason: 'OperationFailed', detail: err.detail });
    case 'WorkerFailed':
    case 'IoFailed':
      return new SourceControlError({ reason: 'WorkerFailed', detail: err.detail });
  }
};

const normalizeName = (raw: string): Option.Option<string> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return Option.none();
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return Option.none();
  }
  if (trimmed === '.' || trimmed === '..') return Option.none();
  return Option.some(trimmed);
};

const probeDirIdentity = async (
  target: string,
): Promise<{ readonly realPath: string; readonly identity: string } | null> => {
  try {
    const realPath = await realpath(target);
    const info = await lstat(realPath);
    if (!info.isDirectory()) return null;
    return {
      realPath,
      identity: `${String(info.dev)}:${String(info.ino)}:${String(Math.trunc(info.birthtimeMs))}`,
    };
  } catch {
    return null;
  }
};

const errorCodeOf = (cause: unknown): string | undefined => {
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    const code = (cause as { readonly code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
};

const inspectPath = (
  rootPath: string,
  relativePath: string,
): Effect.Effect<FileSystemState, FileOperationsError> =>
  Effect.tryPromise({
    try: async (): Promise<FileSystemState> => {
      const parsed = parseSafeRelativePath(relativePath);
      if (!parsed.ok) {
        return { exists: false, kind: 'missing' };
      }
      if (parsed.path.segments.length === 0) {
        return { exists: true, kind: 'directory' };
      }
      const fullPath = path.join(rootPath, ...parsed.path.segments);
      try {
        const info = await lstat(fullPath);
        let kind = classifyLstatKind(info);
        if (kind === 'directory' && (await hasGitMarker(fullPath))) {
          kind = 'nestedRepo';
        }
        const base: FileSystemState = {
          exists: true,
          kind,
          size: info.size,
          mtimeMs: info.mtimeMs,
        };
        if (kind === 'file') {
          const digest =
            info.size <= FINGERPRINT_DIGEST_CAP_BYTES ? await sha256File(fullPath) : null;
          return { ...base, digest };
        }
        if (kind === 'symlink') {
          const linkTarget = await readlink(fullPath, 'utf8').catch(() => undefined);
          return { ...base, linkTarget };
        }
        return base;
      } catch (cause) {
        const code = errorCodeOf(cause);
        if (code === 'EACCES' || code === 'EPERM') {
          return { exists: true, kind: 'unreadable' };
        }
        return { exists: false, kind: 'missing' };
      }
    },
    catch: (cause) =>
      new FileOperationsError({
        reason: 'IoFailed',
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const isGitMetadataPath = (relPath: string): boolean => {
  if (relPath === '') return false;
  return relPath.split('/').some((segment) => {
    const normalized = segment
      .trimEnd()
      .replace(/[. ]+$/, '')
      .toLowerCase();
    return normalized === '.git';
  });
};

const isParentOrSame = (candidate: string, descendant: string): boolean => {
  if (candidate === descendant) return true;
  const prefix = candidate === '' ? '' : `${candidate}/`;
  return descendant.startsWith(prefix);
};

const validateCreatePaths: (
  dirPath: string,
  name: string,
) => Effect.Effect<
  { readonly parentPath: string; readonly targetPath: string },
  FileOperationsError
> = Effect.fnUntraced(function* (dirPath: string, name: string) {
  const parsedDir = parseSafeRelativePath(dirPath);
  if (!parsedDir.ok) {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: parsedDir.detail,
    });
  }
  const normalizedName = normalizeName(name);
  if (Option.isNone(normalizedName)) {
    return yield* new FileOperationsError({
      reason: 'InvalidInput',
      detail: 'Name must be a single file or folder name.',
    });
  }
  const parentPath = parsedDir.path.normalized;
  const targetPath =
    parentPath === '' ? normalizedName.value : `${parentPath}/${normalizedName.value}`;
  if (isGitMetadataPath(targetPath)) {
    return yield* new FileOperationsError({
      reason: 'ProtectedPath',
      detail: 'Git metadata paths cannot be modified.',
    });
  }
  const parsedTarget = parseSafeRelativePath(targetPath);
  if (!parsedTarget.ok || parsedTarget.path.normalized === '') {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: parsedTarget.ok ? 'Cannot modify the workspace root.' : parsedTarget.detail,
    });
  }
  return { parentPath, targetPath };
});

const validateRenamePaths: (
  relativePath: string,
  newName: string,
) => Effect.Effect<
  { readonly sourcePath: string; readonly targetPath: string; readonly parentPath: string },
  FileOperationsError
> = Effect.fnUntraced(function* (relativePath: string, newName: string) {
  const parsedSource = parseSafeRelativePath(relativePath);
  if (!parsedSource.ok || parsedSource.path.normalized === '') {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: parsedSource.ok ? 'Cannot rename the workspace root.' : parsedSource.detail,
    });
  }
  if (isGitMetadataPath(parsedSource.path.normalized)) {
    return yield* new FileOperationsError({
      reason: 'ProtectedPath',
      detail: 'Git metadata paths cannot be modified.',
    });
  }
  const normalizedName = normalizeName(newName);
  if (Option.isNone(normalizedName)) {
    return yield* new FileOperationsError({
      reason: 'InvalidInput',
      detail: 'New name must be a single file or folder name.',
    });
  }
  const segments = parsedSource.path.segments;
  const parentSegments = segments.slice(0, -1);
  const parentPath = parentSegments.join('/');
  const targetPath =
    parentPath === '' ? normalizedName.value : `${parentPath}/${normalizedName.value}`;
  if (isGitMetadataPath(targetPath)) {
    return yield* new FileOperationsError({
      reason: 'ProtectedPath',
      detail: 'Git metadata paths cannot be modified.',
    });
  }
  if (isParentOrSame(parsedSource.path.normalized, targetPath)) {
    return yield* new FileOperationsError({
      reason: 'InvalidInput',
      detail: 'Destination cannot be inside source.',
    });
  }
  return { sourcePath: parsedSource.path.normalized, targetPath, parentPath };
});

const validateDeletePaths: (
  relativePaths: ReadonlyArray<string>,
) => Effect.Effect<ReadonlyArray<string>, FileOperationsError> = Effect.fnUntraced(function* (
  relativePaths: ReadonlyArray<string>,
) {
  const normalized: string[] = [];
  for (const raw of relativePaths) {
    const parsed = parseSafeRelativePath(raw);
    if (!parsed.ok || parsed.path.normalized === '') {
      return yield* new FileOperationsError({
        reason: 'OutsideRoot',
        detail: parsed.ok ? 'Cannot delete the workspace root.' : parsed.detail,
      });
    }
    if (isGitMetadataPath(parsed.path.normalized)) {
      return yield* new FileOperationsError({
        reason: 'ProtectedPath',
        detail: 'Git metadata paths cannot be modified.',
      });
    }
    normalized.push(parsed.path.normalized);
  }
  const deduped = [...new Set(normalized)].sort();
  for (let i = 0; i < deduped.length; i += 1) {
    const current = deduped[i];
    if (current === undefined) continue;
    for (let j = 0; j < deduped.length; j += 1) {
      if (i === j) continue;
      const other = deduped[j];
      if (other === undefined) continue;
      if (isParentOrSame(current, other)) {
        return yield* new FileOperationsError({
          reason: 'InvalidInput',
          detail: `Cannot delete both a folder and its descendant: ${current}`,
        });
      }
    }
  }
  return deduped;
});

const containsNestedRepo = async (rootPath: string, relativePath: string): Promise<boolean> => {
  const parsed = parseSafeRelativePath(relativePath);
  if (!parsed.ok || parsed.path.segments.length === 0) return false;
  const dirPath = path.join(rootPath, ...parsed.path.segments);
  let visited = 0;
  const stack: { readonly abs: string; readonly depth: number }[] = [{ abs: dirPath, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) continue;
    if (entry.depth > NESTED_REPO_MAX_DEPTH) continue;
    if (await hasGitMarker(entry.abs)) return true;
    let dir;
    try {
      dir = await opendir(entry.abs);
    } catch {
      continue;
    }
    try {
      for await (const child of dir) {
        if (!child.isDirectory()) continue;
        if (child.name === '.git') continue;
        visited += 1;
        // An oversized subtree cannot be cleared safely; refuse instead of claiming it was checked.
        if (visited > NESTED_REPO_MAX_ENTRIES) return true;
        stack.push({ abs: path.join(entry.abs, child.name), depth: entry.depth + 1 });
      }
    } catch {
      // ignore unreadable subtrees
    }
  }
  return false;
};

const computeFingerprint = (
  root: ValidatedRoot,
  targetPaths: ReadonlyArray<string>,
  states: ReadonlyArray<FileSystemState>,
  createKind?: 'file' | 'folder',
): string =>
  sha256Hex({
    rootIdentity: root.expectedRootIdentity,
    rootPath: root.rootPath,
    createKind,
    targets: targetPaths.map((p, index) => {
      const state = states[index];
      return {
        path: p,
        exists: state?.exists ?? false,
        kind: state?.kind ?? 'missing',
        size: state?.size,
        mtimeMs: state?.mtimeMs,
        digest: state?.digest,
        linkTarget: state?.linkTarget,
      };
    }),
  });

const collectBlockers = (
  targetPaths: ReadonlyArray<string>,
  states: ReadonlyArray<FileSystemState>,
  kind: 'Files.create' | 'Files.rename' | 'Files.delete',
  options: {
    readonly destinations?: ReadonlyArray<string>;
    readonly allowOverwrite?: boolean;
  } = {},
): ReadonlyArray<FileOperationBlocker> => {
  const blockers: FileOperationBlocker[] = [];
  for (let i = 0; i < targetPaths.length; i += 1) {
    const targetPath = targetPaths[i];
    if (targetPath === undefined) continue;
    const state = states[i];
    if (state === undefined) continue;
    if (state.kind === 'unreadable') {
      blockers.push({
        code: 'SpecialFile',
        detail: `Path is not readable: ${targetPath}`,
      });
    } else if (state.kind === 'nestedRepo') {
      blockers.push({
        code: 'NestedRepo',
        detail: `Nested Git repositories cannot be modified: ${targetPath}`,
      });
    } else if (state.kind === 'special') {
      blockers.push({
        code: 'SpecialFile',
        detail: `Special filesystem entries are unsupported: ${targetPath}`,
      });
    }
    if (kind === 'Files.create' && state.exists) {
      blockers.push({
        code: 'TargetExists',
        detail: `A file or folder named "${targetPath}" already exists.`,
      });
    }
    if ((kind === 'Files.rename' || kind === 'Files.delete') && !state.exists) {
      blockers.push({
        code: 'TargetMissing',
        detail: `Path does not exist: ${targetPath}`,
      });
    }
  }

  if (kind === 'Files.rename' && options.destinations !== undefined) {
    for (let i = 0; i < options.destinations.length; i += 1) {
      const destination = options.destinations[i];
      if (destination === undefined) continue;
      const sourcePath = targetPaths[i];
      if (sourcePath === undefined) continue;
      if (isParentOrSame(sourcePath, destination)) {
        blockers.push({
          code: 'DestinationInsideSource',
          detail: `Destination cannot be inside source: ${destination}`,
        });
        continue;
      }
      const destState = states[targetPaths.length + i];
      if (destState?.exists && !options.allowOverwrite) {
        blockers.push({
          code: 'TargetExists',
          detail: `A file or folder named "${destination}" already exists.`,
        });
      }
    }
  }

  return blockers;
};

const makeReviewTargets = (
  targetPaths: ReadonlyArray<string>,
  states: ReadonlyArray<FileSystemState>,
  mode: ReviewPayload['mode'],
  kind: 'Files.create' | 'Files.rename' | 'Files.delete',
  destinations?: ReadonlyArray<string>,
): ReadonlyArray<FileOperationReviewTarget> => {
  const permanent = mode === 'permanent';
  const sourceTargets = targetPaths.map((targetPath, index) => {
    const state = states[index];
    const exists = state?.exists ?? false;
    const entryKind = state?.kind ?? 'missing';
    const willBeRemoved = exists && kind !== 'Files.rename';
    return {
      path: targetPath,
      kind: entryKind,
      exists,
      willBeTrashed: willBeRemoved && !permanent,
      willBePermanentlyRemoved: willBeRemoved && permanent,
      ...(destinations === undefined || destinations[index] === undefined
        ? {}
        : { destinationPath: destinations[index] }),
    };
  });

  if (kind !== 'Files.rename' || destinations === undefined) {
    return sourceTargets;
  }

  const destinationTargets: FileOperationReviewTarget[] = [];
  for (let i = 0; i < destinations.length; i += 1) {
    const destination = destinations[i];
    if (destination === undefined) continue;
    const destState = states[targetPaths.length + i];
    if (!destState?.exists) continue;
    destinationTargets.push({
      path: destination,
      kind: destState.kind,
      exists: true,
      willBeTrashed: !permanent,
      willBePermanentlyRemoved: permanent,
    });
  }
  return [...sourceTargets, ...destinationTargets];
};

const reservationKeysForPaths = (
  platform: NodeJS.Platform,
  rootPath: string,
  targetPaths: ReadonlyArray<string>,
  destinations?: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const keys = new Set<string>();
  keys.add(reservationKeys.folder(folderKey(rootPath, platform)));
  const addParentKey = (relPath: string) => {
    const parent = relPath === '' ? '' : relPath.split('/').slice(0, -1).join('/');
    keys.add(
      reservationKeys.folder(
        folderKey(path.join(rootPath, parent === '' ? '.' : parent), platform),
      ),
    );
  };
  for (const targetPath of targetPaths) {
    addParentKey(targetPath);
  }
  if (destinations !== undefined) {
    for (const dest of destinations) {
      addParentKey(dest);
    }
  }
  return [...keys].sort();
};

const tryTrash: (
  trash: TrashShape,
  absolutePath: string,
) => Effect.Effect<'trashed' | 'unavailable', FileOperationsError> = Effect.fnUntraced(function* (
  trash: TrashShape,
  absolutePath: string,
) {
  const outcome = yield* Effect.exit(trash.moveToTrash(absolutePath));
  if (Exit.isFailure(outcome)) {
    const err = Cause.squash(outcome.cause);
    if (err instanceof FileOperationsError && err.reason === 'TrashUnavailable') {
      return 'unavailable' as const;
    }
    if (err instanceof FileOperationsError) return yield* err;
    return yield* new FileOperationsError({
      reason: 'IoFailed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return 'trashed' as const;
});

const verifyParentContained = Effect.fnUntraced(function* (
  rootPath: string,
  relativePath: string,
): Effect.fn.Return<string, FileOperationsError> {
  const parsed = parseSafeRelativePath(relativePath);
  if (!parsed.ok) {
    return yield* new FileOperationsError({ reason: 'OutsideRoot', detail: parsed.detail });
  }
  if (parsed.path.segments.length === 0) {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: 'Cannot modify the workspace root.',
    });
  }
  const parentSegments = parsed.path.segments.slice(0, -1);
  const parentAbs = parentSegments.length === 0 ? rootPath : path.join(rootPath, ...parentSegments);
  const realParent = yield* Effect.promise(() => realpath(parentAbs).catch(() => null));
  if (realParent === null) {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: `Parent directory is not accessible: ${parentSegments.join('/') || '.'}`,
    });
  }
  if (!isPathWithinRoot(rootPath, realParent)) {
    return yield* new FileOperationsError({
      reason: 'OutsideRoot',
      detail: `Parent resolves outside the workspace root: ${relativePath}`,
    });
  }
  return path.join(rootPath, ...parsed.path.segments);
});

const removePath = (
  rootPath: string,
  targetPath: string,
  state: FileSystemState,
  allowPermanentDelete: boolean,
  trash: TrashShape,
): Effect.Effect<PathOperationResult, FileOperationsError> =>
  Effect.gen(function* () {
    const absolutePath = yield* verifyParentContained(rootPath, targetPath);
    if (state.exists) {
      if (!allowPermanentDelete) {
        const trashed = yield* tryTrash(trash, absolutePath);
        if (trashed === 'unavailable') {
          return yield* new FileOperationsError({
            reason: 'TrashUnavailable',
            detail: 'Trash is unavailable. Confirm permanent deletion to proceed.',
          });
        }
      } else {
        yield* Effect.tryPromise({
          try: () => rm(absolutePath, { recursive: true, force: true }),
          catch: (cause) =>
            new FileOperationsError({
              reason: 'IoFailed',
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }
    }
    return { status: 'Completed' as const };
  }).pipe(
    Effect.catch((err: FileOperationsError) =>
      Effect.succeed({ status: 'Failed' as const, detail: err.detail }),
    ),
  );

const createPath = (
  rootPath: string,
  targetPath: string,
  kind: 'file' | 'folder',
): Effect.Effect<PathOperationResult, FileOperationsError> =>
  Effect.gen(function* () {
    const absolutePath = yield* verifyParentContained(rootPath, targetPath);
    if (kind === 'folder') {
      yield* Effect.tryPromise({
        try: () => mkdir(absolutePath, { recursive: false }),
        catch: (cause) =>
          new FileOperationsError({
            reason: 'IoFailed',
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    } else {
      yield* Effect.tryPromise({
        try: () => writeFile(absolutePath, '', 'utf8'),
        catch: (cause) =>
          new FileOperationsError({
            reason: 'IoFailed',
            detail: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    }
    return { status: 'Completed' as const };
  }).pipe(
    Effect.catch((err: FileOperationsError) =>
      Effect.succeed({ status: 'Failed' as const, detail: err.detail }),
    ),
  );

const renamePath = (
  rootPath: string,
  sourcePath: string,
  targetPath: string,
  allowOverwrite: boolean,
  allowPermanentDelete: boolean,
  trash: TrashShape,
): Effect.Effect<PathOperationResult, FileOperationsError> =>
  Effect.gen(function* () {
    const sourceAbsolute = yield* verifyParentContained(rootPath, sourcePath);
    const targetAbsolute = yield* verifyParentContained(rootPath, targetPath);

    const targetExists = yield* Effect.promise(async () => {
      try {
        await lstat(targetAbsolute);
        return true;
      } catch {
        return false;
      }
    });

    if (targetExists && !allowOverwrite) {
      return yield* new FileOperationsError({
        reason: 'InvalidInput',
        detail: `Destination already exists: ${targetPath}`,
      });
    }

    if (targetExists && allowOverwrite) {
      if (!allowPermanentDelete) {
        const trashed = yield* tryTrash(trash, targetAbsolute);
        if (trashed === 'unavailable') {
          return yield* new FileOperationsError({
            reason: 'TrashUnavailable',
            detail: 'Trash is unavailable. Confirm permanent overwrite to proceed.',
          });
        }
      } else {
        yield* Effect.tryPromise({
          try: () => rm(targetAbsolute, { recursive: true, force: true }),
          catch: (cause) =>
            new FileOperationsError({
              reason: 'IoFailed',
              detail: cause instanceof Error ? cause.message : String(cause),
            }),
        });
      }
    }

    yield* Effect.tryPromise({
      try: () => fsRename(sourceAbsolute, targetAbsolute),
      catch: (cause) =>
        new FileOperationsError({
          reason: 'IoFailed',
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return { status: 'Completed' as const };
  }).pipe(
    Effect.catch((err: FileOperationsError) =>
      Effect.succeed({ status: 'Failed' as const, detail: err.detail }),
    ),
  );

export const layerFileOperations: Layer.Layer<
  FileOperations,
  never,
  Projects | Worktrees | PathSources | ReviewRegistry | ReservationCoordinator | Operations | Trash
> = Layer.effect(
  FileOperations,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const worktrees = yield* Worktrees;
    const pathSources = yield* PathSources;
    const reviewRegistry = yield* ReviewRegistry;
    const operations = yield* Operations;
    const trash = yield* Trash;
    const platform = pathSources.platform;

    const resolveRoot = Effect.fnUntraced(function* (
      target: FilesRootTarget,
    ): Effect.fn.Return<ValidatedRoot, FileOperationsError> {
      const project = yield* projects.check(target.projectId).pipe(
        Effect.catchTag('ProjectsError', (error) =>
          Effect.fail(
            new FileOperationsError({
              reason: error.reason === 'NotFound' ? 'NotFound' : 'IoFailed',
              detail: error.detail,
            }),
          ),
        ),
      );
      if (target.worktreeId === undefined) {
        if (project.folderMissing) {
          return yield* new FileOperationsError({
            reason: 'NotFound',
            detail: 'Project folder is currently missing.',
          });
        }
        const live = yield* Effect.promise(() => probeDirIdentity(project.path));
        if (!live) {
          return yield* new FileOperationsError({
            reason: 'NotFound',
            detail: 'Project folder is not accessible on disk.',
          });
        }
        return { rootPath: live.realPath, expectedRootIdentity: live.identity };
      }

      const inventory = yield* worktrees.inventory(project.path, project.id).pipe(
        Effect.catchTag('WorktreesError', (error) =>
          Effect.fail(
            new FileOperationsError({
              reason: error.reason === 'WorkerFailed' ? 'WorkerFailed' : 'NotFound',
              detail: error.detail,
            }),
          ),
        ),
      );
      const entry = inventory.worktrees.find((item) => item.id === target.worktreeId);
      if (!entry || entry.missing) {
        return yield* new FileOperationsError({
          reason: 'NotFound',
          detail: 'Worktree is unavailable or does not belong to this Project.',
        });
      }
      const live = yield* Effect.promise(() => probeDirIdentity(entry.path));
      if (!live) {
        return yield* new FileOperationsError({
          reason: 'NotFound',
          detail: 'Worktree folder is not accessible on disk.',
        });
      }
      return { rootPath: live.realPath, expectedRootIdentity: live.identity };
    });

    const inspectDirectoryTargets = Effect.fnUntraced(function* (
      rootPath: string,
      targetPaths: ReadonlyArray<string>,
      states: ReadonlyArray<FileSystemState>,
    ): Effect.fn.Return<ReadonlyArray<FileOperationBlocker>, FileOperationsError> {
      const blockers: FileOperationBlocker[] = [];
      for (let i = 0; i < targetPaths.length; i += 1) {
        const targetPath = targetPaths[i];
        const state = states[i];
        if (targetPath === undefined || state === undefined) continue;
        // A symlink is removed as a link, never traversed or followed during inspection.
        if (state.kind !== 'directory') continue;
        const hasNested = yield* Effect.promise(() =>
          containsNestedRepo(rootPath, targetPath).catch(() => true),
        );
        if (hasNested) {
          blockers.push({
            code: 'NestedRepo',
            detail: `Nested Git repositories cannot be modified: ${targetPath}`,
          });
        }
      }
      return blockers;
    });

    const issueReview = Effect.fnUntraced(function* (input: {
      readonly target: FilesRootTarget;
      readonly kind: 'Files.create' | 'Files.rename' | 'Files.delete';
      readonly targetPaths: ReadonlyArray<string>;
      readonly destinations?: ReadonlyArray<string>;
      readonly createKind?: 'file' | 'folder';
      readonly mode: ReviewPayload['mode'];
      readonly allowOverwrite?: boolean;
    }): Effect.fn.Return<FileOperationReview, FileOperationsError> {
      const root = yield* resolveRoot(input.target);
      const sourceStates = yield* Effect.all(
        input.targetPaths.map((p) => inspectPath(root.rootPath, p)),
        { concurrency: 1 },
      );
      const destinationStates =
        input.destinations === undefined
          ? []
          : yield* Effect.all(
              input.destinations.map((p) => inspectPath(root.rootPath, p)),
              { concurrency: 1 },
            );
      const states = [...sourceStates, ...destinationStates];
      const fingerprint = computeFingerprint(
        root,
        [...input.targetPaths, ...(input.destinations ?? [])],
        states,
        input.createKind,
      );
      let blockers = collectBlockers(input.targetPaths, states, input.kind, {
        destinations: input.destinations,
        allowOverwrite: input.allowOverwrite,
      });
      const nestedBlockers = yield* inspectDirectoryTargets(
        root.rootPath,
        input.targetPaths,
        sourceStates,
      );
      blockers = [...blockers, ...nestedBlockers];
      const requiresPermanentConfirmation = input.mode === 'permanent';

      const payload: ReviewPayload = {
        kind: input.kind,
        rootPath: root.rootPath,
        expectedRootIdentity: root.expectedRootIdentity,
        targetPaths: input.targetPaths,
        fingerprint,
        mode: input.mode,
        ...(input.createKind === undefined ? {} : { createKind: input.createKind }),
        ...(input.destinations === undefined ? {} : { destinations: input.destinations }),
        ...(input.allowOverwrite === undefined ? {} : { allowOverwrite: input.allowOverwrite }),
      };

      const issued = yield* reviewRegistry
        .issue({
          kind: input.kind,
          fingerprint,
          payload,
        })
        .pipe(Effect.mapError(mapSourceControlError));

      return {
        reviewId: issued.reviewId,
        issuedAt: issued.issuedAt,
        expiresAt: issued.expiresAt,
        kind: input.kind,
        targets: makeReviewTargets(
          input.targetPaths,
          states,
          input.mode,
          input.kind,
          input.destinations,
        ),
        warnings: [],
        blockers,
        requiresPermanentConfirmation,
      };
    });

    const reconcileFileOperationRecord = Effect.fn('FileOperations.reconcile')(function* (
      record: DurableOperationRecord,
    ): Effect.fn.Return<OperationReconciliationOutcome, SourceControlError> {
      const meta = record.metadata;
      const rootPath = typeof meta['rootPath'] === 'string' ? meta['rootPath'] : undefined;
      const targetPaths = Array.isArray(meta['targetPaths'])
        ? (meta['targetPaths'] as ReadonlyArray<string>)
        : [];
      const kind = meta['kind'];
      const createKind =
        meta['createKind'] === 'file' || meta['createKind'] === 'folder'
          ? meta['createKind']
          : undefined;
      const destinations = Array.isArray(meta['destinations'])
        ? (meta['destinations'] as ReadonlyArray<string>)
        : undefined;

      if (
        rootPath === undefined ||
        targetPaths.length === 0 ||
        (kind !== 'Files.create' && kind !== 'Files.rename' && kind !== 'Files.delete')
      ) {
        return {
          _tag: 'NeedsRecovery',
          outcome: 'NeedsRecovery',
          recovery: {
            summary: 'Incomplete file operation metadata; manual inspection required.',
            detail: 'Operation journal is missing rootPath, targetPaths, or kind.',
            observedFolderExists: false,
            observedRegisteredInGit: false,
            observedBranchExists: false,
            canReconcile: false,
            canDismiss: true,
          },
        };
      }

      const makeNeedsRecovery = (detail: string): OperationReconciliationOutcome => ({
        _tag: 'NeedsRecovery',
        outcome: 'NeedsRecovery',
        recovery: {
          summary: 'File operation postcondition is not satisfied.',
          detail,
          observedFolderExists: true,
          observedRegisteredInGit: false,
          observedBranchExists: false,
          canReconcile: true,
          canDismiss: true,
        },
      });

      if (kind === 'Files.create') {
        const targetPath = targetPaths[0];
        if (targetPath === undefined) return makeNeedsRecovery('Missing create target.');
        const observed = yield* inspectPath(rootPath, targetPath).pipe(
          Effect.mapError(toSourceControlError),
        );
        const expectedKind: FileSystemState['kind'] =
          createKind === 'folder' ? 'directory' : 'file';
        if (observed.exists && observed.kind === expectedKind) {
          return {
            _tag: 'Succeeded',
            detail: `Created ${createKind ?? 'file'} is present as intended.`,
            targetPath: rootPath,
          };
        }
        return makeNeedsRecovery(
          `Expected ${expectedKind} at "${targetPath}" but found ${observed.kind}.`,
        );
      }

      if (kind === 'Files.delete') {
        const observed = yield* Effect.all(
          targetPaths.map((p) => inspectPath(rootPath, p)),
          { concurrency: 1 },
        ).pipe(Effect.mapError(toSourceControlError));
        const remaining = observed.filter((s) => s.exists).length;
        if (remaining === 0) {
          return {
            _tag: 'Succeeded',
            detail: 'Verified all targeted paths were removed as intended.',
            targetPath: rootPath,
          };
        }
        return makeNeedsRecovery(`${String(remaining)} target(s) remain on disk.`);
      }

      // Files.rename
      const sourcePath = targetPaths[0];
      const destinationPath = destinations?.[0];
      if (sourcePath === undefined || destinationPath === undefined) {
        return makeNeedsRecovery('Missing source or destination path for rename.');
      }
      const [sourceState, destState] = yield* Effect.all(
        [inspectPath(rootPath, sourcePath), inspectPath(rootPath, destinationPath)],
        { concurrency: 1 },
      ).pipe(Effect.mapError(toSourceControlError));
      if (!sourceState.exists && destState.exists) {
        return {
          _tag: 'Succeeded',
          detail: 'Verified source was removed and destination is present.',
          targetPath: rootPath,
        };
      }
      return makeNeedsRecovery(
        `Rename postcondition not met: source ${sourceState.exists ? 'still present' : 'removed'}, destination ${destState.exists ? 'present' : 'missing'}.`,
      );
    });

    yield* operations.registerReconciler('Files.create', reconcileFileOperationRecord);
    yield* operations.registerReconciler('Files.rename', reconcileFileOperationRecord);
    yield* operations.registerReconciler('Files.delete', reconcileFileOperationRecord);
    yield* operations.reconcilePendingForKind('Files.create').pipe(Effect.catch(() => Effect.void));
    yield* operations.reconcilePendingForKind('Files.rename').pipe(Effect.catch(() => Effect.void));
    yield* operations.reconcilePendingForKind('Files.delete').pipe(Effect.catch(() => Effect.void));

    return {
      reviewCreate: Effect.fn('FileOperations.reviewCreate')(function* ({
        target,
        dirPath,
        name,
        kind,
      }) {
        const validated = yield* validateCreatePaths(dirPath, name);
        return yield* issueReview({
          target,
          kind: 'Files.create',
          targetPaths: [validated.targetPath],
          createKind: kind,
          mode: 'normal',
        });
      }),

      reviewRename: Effect.fn('FileOperations.reviewRename')(function* ({
        target,
        relativePath,
        newName,
        allowOverwrite,
      }) {
        const validated = yield* validateRenamePaths(relativePath, newName);
        return yield* issueReview({
          target,
          kind: 'Files.rename',
          targetPaths: [validated.sourcePath],
          destinations: [validated.targetPath],
          mode: 'normal',
          allowOverwrite,
        });
      }),

      reviewDelete: Effect.fn('FileOperations.reviewDelete')(function* ({
        target,
        relativePaths,
        permanent,
      }) {
        const validated = yield* validateDeletePaths(relativePaths);
        return yield* issueReview({
          target,
          kind: 'Files.delete',
          targetPaths: validated,
          mode: permanent === true ? 'permanent' : 'trash',
        });
      }),

      execute: Effect.fn('FileOperations.execute')(function* ({
        reviewId,
        operationId,
        allowPermanentDelete,
      }) {
        const record = yield* reviewRegistry.get(reviewId).pipe(
          Effect.flatMap((stored) =>
            stored === undefined
              ? Effect.fail(
                  new FileOperationsError({
                    reason: 'StaleReview',
                    detail:
                      'Review snapshot is no longer active. Refresh the review before continuing.',
                  }),
                )
              : Effect.succeed(stored),
          ),
        );
        if (
          record.kind !== 'Files.create' &&
          record.kind !== 'Files.rename' &&
          record.kind !== 'Files.delete'
        ) {
          return yield* new FileOperationsError({
            reason: 'StaleReview',
            detail: 'Review kind does not match this file operation.',
          });
        }
        const payload = record.payload as ReviewPayload;
        const rootPath = payload.rootPath;
        const targetPaths = payload.targetPaths;
        const kind = payload.kind;
        const createKind = payload.createKind;
        const destinations = payload.destinations;
        const mode = payload.mode;
        const allowOverwrite = payload.allowOverwrite ?? false;

        if (allowPermanentDelete === true && mode !== 'permanent') {
          return yield* new FileOperationsError({
            reason: 'PermanentDeleteRequired',
            detail: 'Permanent deletion is only allowed for reviews issued in permanent mode.',
          });
        }
        if (mode === 'permanent' && allowPermanentDelete !== true) {
          return yield* new FileOperationsError({
            reason: 'PermanentDeleteRequired',
            detail: 'This review requires explicit permanent-delete confirmation.',
          });
        }

        const requestDigest = sha256Hex({
          reviewId,
          operationId,
          kind,
          targetPaths,
          mode,
          allowOverwrite,
        });

        const lockKeys = reservationKeysForPaths(platform, rootPath, targetPaths, destinations);

        const title =
          kind === 'Files.create' ? 'Create file' : kind === 'Files.rename' ? 'Rename' : 'Delete';

        const snapshot = yield* operations
          .execute({
            operationId,
            kind,
            title,
            requestDigest,
            lockKeys,
            sourcePath: rootPath,
            propagateApplyFailure: true,
            metadata: {
              rootPath,
              targetPaths,
              kind,
              mode,
              ...(createKind === undefined ? {} : { createKind }),
              ...(destinations === undefined ? {} : { destinations }),
              ...(allowOverwrite ? { allowOverwrite: true } : {}),
            },
            prepare: Effect.fnUntraced(function* () {
              const liveSourceStates = yield* Effect.all(
                targetPaths.map((p) => inspectPath(rootPath, p)),
                { concurrency: 1 },
              ).pipe(Effect.mapError(toSourceControlError));
              const liveDestinationStates =
                destinations === undefined
                  ? []
                  : yield* Effect.all(
                      destinations.map((p) => inspectPath(rootPath, p)),
                      { concurrency: 1 },
                    ).pipe(Effect.mapError(toSourceControlError));
              const liveStates = [...liveSourceStates, ...liveDestinationStates];
              const liveFingerprint = computeFingerprint(
                { rootPath, expectedRootIdentity: payload.expectedRootIdentity },
                [...targetPaths, ...(destinations ?? [])],
                liveStates,
                createKind,
              );
              if (liveFingerprint !== record.fingerprint) {
                return yield* new SourceControlError({
                  reason: 'StaleReview',
                  detail:
                    'Workspace state changed since this review. Refresh the review and try again.',
                });
              }
              yield* reviewRegistry
                .verifyAndConsume({
                  reviewId,
                  kind,
                  operationId,
                  checkFingerprint: () => Effect.void,
                })
                .pipe(
                  Effect.mapError(mapSourceControlError),
                  Effect.mapError(toSourceControlError),
                );

              const blockers = collectBlockers(targetPaths, liveStates, kind, {
                destinations,
                allowOverwrite,
              });
              const nestedBlockers = yield* inspectDirectoryTargets(
                rootPath,
                targetPaths,
                liveStates,
              ).pipe(Effect.mapError(toSourceControlError));
              const firstBlocker = [...blockers, ...nestedBlockers][0];
              if (firstBlocker !== undefined) {
                return yield* new SourceControlError({
                  reason: 'UntrustedPath',
                  detail: firstBlocker.detail,
                });
              }
              return {};
            }),
            apply: Effect.fnUntraced(function* ({ reportPathResults }) {
              const allPaths =
                destinations === undefined ? targetPaths : [...targetPaths, ...destinations];
              yield* Effect.all(
                allPaths.map((p) => verifyParentContained(rootPath, p).pipe(Effect.asVoid)),
                { concurrency: 1 },
              ).pipe(Effect.mapError(toSourceControlError));

              const liveStates = yield* Effect.all(
                targetPaths.map((p) => inspectPath(rootPath, p)),
                { concurrency: 1 },
              ).pipe(Effect.mapError(toSourceControlError));
              const nestedBlockers = yield* inspectDirectoryTargets(
                rootPath,
                targetPaths,
                liveStates,
              ).pipe(Effect.mapError(toSourceControlError));
              if (nestedBlockers.length > 0) {
                return yield* new SourceControlError({
                  reason: 'UntrustedPath',
                  detail:
                    nestedBlockers[0]?.detail ?? 'Nested repository detected at execution edge.',
                });
              }

              const results: OperationPathResult[] = [];
              let stopped = false;
              let stopReason: 'failed' | 'trashUnavailable' = 'failed';

              for (let i = 0; i < targetPaths.length; i += 1) {
                const targetPath = targetPaths[i];
                if (targetPath === undefined) continue;

                let result: PathOperationResult;
                if (stopped) {
                  result = { status: 'Untouched' };
                } else if (kind === 'Files.create') {
                  result = yield* createPath(rootPath, targetPath, createKind ?? 'file').pipe(
                    Effect.mapError(toSourceControlError),
                  );
                } else if (kind === 'Files.rename') {
                  const destination = destinations?.[i];
                  if (destination === undefined) {
                    result = { status: 'Failed', detail: 'Missing destination path.' };
                  } else {
                    result = yield* renamePath(
                      rootPath,
                      targetPath,
                      destination,
                      allowOverwrite,
                      allowPermanentDelete ?? false,
                      trash,
                    ).pipe(Effect.mapError(toSourceControlError));
                  }
                } else {
                  const state = liveStates[i];
                  if (state === undefined) {
                    result = { status: 'Failed', detail: 'Missing state for target.' };
                  } else {
                    result = yield* removePath(
                      rootPath,
                      targetPath,
                      state,
                      allowPermanentDelete ?? false,
                      trash,
                    ).pipe(Effect.mapError(toSourceControlError));
                  }
                }

                results.push({
                  path: targetPath,
                  status: result.status,
                  ...(result.detail === undefined ? {} : { detail: result.detail }),
                });
                if (result.status === 'Failed') {
                  stopped = true;
                  stopReason = result.detail?.includes('Trash is unavailable')
                    ? 'trashUnavailable'
                    : 'failed';
                }

                yield* reportPathResults(results);
              }

              if (stopReason === 'trashUnavailable') {
                return yield* new SourceControlError({
                  reason: 'OperationFailed',
                  detail: 'Trash is unavailable. Confirm permanent deletion to proceed.',
                });
              }

              const anyFailed = results.some((r) => r.status === 'Failed');
              if (anyFailed) {
                return {
                  _tag: 'Partial' as const,
                  pathResults: results,
                };
              }

              return {
                _tag: 'Succeeded' as const,
                targetPath: rootPath,
              };
            }),
          })
          .pipe(
            Effect.catchTag('SourceControlError', (err) =>
              err.reason === 'OperationFailed' && err.detail.includes('Trash is unavailable')
                ? Effect.fail(
                    new FileOperationsError({
                      reason: 'TrashUnavailable',
                      detail: err.detail,
                    }),
                  )
                : Effect.fail(mapSourceControlError(err)),
            ),
            Effect.catchCause((cause) => {
              const err = Cause.squash(cause);
              if (err instanceof FileOperationsError) return Effect.fail(err);
              return Effect.fail(
                new FileOperationsError({
                  reason: 'IoFailed',
                  detail: err instanceof Error ? err.message : String(err),
                }),
              );
            }),
          );

        return snapshot;
      }),
    } satisfies FileOperationsShape;
  }),
);
