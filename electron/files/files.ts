import { realpath as realpathCb, watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Context, Effect, Layer, Queue, Stream } from 'effect';
import {
  DEFAULT_FILES_DIR_PAGE_LIMIT,
  DEFAULT_FILES_PREVIEW_MAX_BYTES,
  FilesError,
  type FilesDirectoryPage,
  type FilesPreview,
  type FilesRootTarget,
  type FilesWatchEvent,
} from '../../src/shared/files/files.rpc';
import { Projects } from '../projects/projects';
import { GitWorker } from '../worktrees/git-client';
import { Worktrees } from '../worktrees/worktrees';

const realpathNative = promisify(realpathCb.native);

const WATCH_DEBOUNCE_MS = 80;
const WATCH_MAX_BATCH_PATHS = 200;

/** Effect boundary around OS external file opening (`shell.openPath` in Electron main). */
export interface ExternalOpenerShape {
  readonly openPath: (targetPath: string) => Effect.Effect<void, FilesError>;
}

/** OS external opener service; swapped in tests without launching system applications. */
export class ExternalOpener extends Context.Service<ExternalOpener, ExternalOpenerShape>()(
  'files/ExternalOpener',
) {}

/** Backend Files domain service: validated root browsing, bounded previews, live watch, external open. */
export interface FilesShape {
  readonly listDir: (params: {
    readonly target: FilesRootTarget;
    readonly dirPath: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly showIgnoredFiles?: boolean;
  }) => Effect.Effect<FilesDirectoryPage, FilesError>;
  readonly readPreview: (params: {
    readonly target: FilesRootTarget;
    readonly relativePath: string;
    readonly maxBytes?: number;
  }) => Effect.Effect<FilesPreview, FilesError>;
  readonly openExternal: (params: {
    readonly target: FilesRootTarget;
    readonly relativePath: string;
  }) => Effect.Effect<void, FilesError>;
  readonly watch: (target: FilesRootTarget) => Stream.Stream<FilesWatchEvent, FilesError>;
}

/** Files domain service tag. */
export class Files extends Context.Service<Files, FilesShape>()('files/Files') {}

interface ValidatedRoot {
  readonly rootPath: string;
  readonly expectedRootIdentity: string | null;
  readonly showIgnoredFiles: boolean;
}

const probeDirIdentity = async (
  target: string,
): Promise<{ readonly realPath: string; readonly identity: string } | null> => {
  try {
    const realPath = await realpathNative(target);
    const info = await stat(realPath);
    if (!info.isDirectory()) return null;
    return {
      realPath,
      identity: `${String(info.dev)}:${String(info.ino)}:${String(Math.trunc(info.birthtimeMs))}`,
    };
  } catch {
    return null;
  }
};

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

const startFsWatcher = (
  root: ValidatedRoot,
  emit: (event: FilesWatchEvent) => void,
): (() => void) => {
  let closed = false;
  let overflow = false;
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;

  const stop = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (watcher !== null) {
      try {
        watcher.close();
      } catch {
        // Ignore close races on deleted directories.
      }
      watcher = null;
    }
  };

  const failRoot = (reason: 'RootMissing' | 'IdentityChanged' | 'WatchFailed', detail: string) => {
    if (closed) return;
    stop();
    emit({ _tag: 'Unavailable', reason, detail });
  };

  const flush = () => {
    timer = null;
    if (closed) return;
    const hadOverflow = overflow;
    const paths = hadOverflow ? [''] : [...dirty];
    overflow = false;
    dirty.clear();
    if (!hadOverflow && paths.length === 0) return;

    void probeDirIdentity(root.rootPath).then((current) => {
      if (closed) return;
      if (!current) {
        failRoot('RootMissing', 'Watched workspace root is no longer available.');
        return;
      }
      if (root.expectedRootIdentity !== null && current.identity !== root.expectedRootIdentity) {
        failRoot('IdentityChanged', 'Watched workspace root identity changed.');
        return;
      }
      emit({
        _tag: 'Changed',
        paths,
        overflow: hadOverflow,
      });
    });
  };

  const scheduleFlush = () => {
    if (closed || timer !== null) return;
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  };

  try {
    watcher = watch(root.rootPath, { recursive: true }, (_eventType, filename) => {
      if (closed) return;
      const raw = filename === null ? '' : String(filename).replaceAll('\\', '/');
      if (isGitMetadataPath(raw)) return;
      if (overflow) {
        scheduleFlush();
        return;
      }
      dirty.add(raw);
      if (dirty.size > WATCH_MAX_BATCH_PATHS) {
        overflow = true;
        dirty.clear();
      }
      scheduleFlush();
    });
    watcher.on('error', (error) => {
      void probeDirIdentity(root.rootPath).then((current) => {
        if (closed) return;
        if (!current) {
          failRoot('RootMissing', 'Watched workspace root is no longer available.');
        } else {
          failRoot('WatchFailed', error.message);
        }
      });
    });
  } catch (cause) {
    failRoot('WatchFailed', cause instanceof Error ? cause.message : String(cause));
  }

  return stop;
};

/** Live `Files` implementation validating Project/Worktree identity and offloading heavy I/O to `GitWorker`. */
export const layerFiles = Layer.effect(
  Files,
  Effect.gen(function* () {
    const projects = yield* Projects;
    const worktrees = yield* Worktrees;
    const gitWorker = yield* GitWorker;
    const opener = yield* ExternalOpener;

    const resolveValidatedRoot = Effect.fnUntraced(function* (
      target: FilesRootTarget,
    ): Effect.fn.Return<ValidatedRoot, FilesError> {
      const project = yield* projects.check(target.projectId).pipe(
        Effect.catchTag('ProjectsError', (error) =>
          Effect.fail(
            new FilesError({
              reason: error.reason === 'NotFound' ? 'MissingProject' : 'IoFailed',
              detail: error.detail,
            }),
          ),
        ),
      );
      const showIgnoredFiles = project.settings.showIgnoredFiles ?? false;

      if (target.worktreeId === undefined) {
        if (project.folderMissing) {
          return yield* new FilesError({
            reason: 'NotFound',
            detail: 'Project folder is currently missing.',
          });
        }
        const live = yield* Effect.promise(() => probeDirIdentity(project.path));
        if (!live) {
          return yield* new FilesError({
            reason: 'NotFound',
            detail: 'Project folder is not accessible on disk.',
          });
        }
        return {
          rootPath: live.realPath,
          expectedRootIdentity: live.identity,
          showIgnoredFiles,
        };
      }

      const inventory = yield* worktrees.inventory(project.path, project.id).pipe(
        Effect.catchTag('WorktreesError', (error) =>
          Effect.fail(
            new FilesError({
              reason: error.reason === 'WorkerFailed' ? 'WorkerFailed' : 'MissingWorktree',
              detail: error.detail,
            }),
          ),
        ),
      );
      const entry = inventory.worktrees.find((item) => item.id === target.worktreeId);
      if (!entry || entry.missing) {
        return yield* new FilesError({
          reason: 'MissingWorktree',
          detail: 'Worktree is unavailable or does not belong to this Project.',
        });
      }
      const live = yield* Effect.promise(() => probeDirIdentity(entry.path));
      if (!live) {
        return yield* new FilesError({
          reason: 'MissingWorktree',
          detail: 'Worktree folder is not accessible on disk.',
        });
      }
      return {
        rootPath: live.realPath,
        expectedRootIdentity: live.identity,
        showIgnoredFiles,
      };
    });

    const listDir: FilesShape['listDir'] = Effect.fn('Files.listDir')(function* ({
      target,
      dirPath,
      cursor,
      limit,
      showIgnoredFiles,
    }) {
      const root = yield* resolveValidatedRoot(target);
      return yield* gitWorker.listDir({
        rootPath: root.rootPath,
        expectedRootIdentity: root.expectedRootIdentity,
        dirPath,
        ...(cursor === undefined ? {} : { cursor }),
        limit: limit ?? DEFAULT_FILES_DIR_PAGE_LIMIT,
        showIgnoredFiles: showIgnoredFiles ?? root.showIgnoredFiles,
      });
    });

    const readPreview: FilesShape['readPreview'] = Effect.fn('Files.readPreview')(function* ({
      target,
      relativePath,
      maxBytes,
    }) {
      const root = yield* resolveValidatedRoot(target);
      return yield* gitWorker.readPreview({
        rootPath: root.rootPath,
        expectedRootIdentity: root.expectedRootIdentity,
        relativePath,
        maxBytes: maxBytes ?? DEFAULT_FILES_PREVIEW_MAX_BYTES,
      });
    });

    const openExternal: FilesShape['openExternal'] = Effect.fn('Files.openExternal')(function* ({
      target,
      relativePath,
    }) {
      const root = yield* resolveValidatedRoot(target);
      const { targetPath } = yield* gitWorker.validateOpenTarget({
        rootPath: root.rootPath,
        expectedRootIdentity: root.expectedRootIdentity,
        relativePath,
      });
      yield* opener.openPath(targetPath);
    });

    const watchRoot: FilesShape['watch'] = (target) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const root = yield* resolveValidatedRoot(target);
          // A slow renderer needs only a rescan, not an unbounded backlog of paths.
          const queue = yield* Queue.sliding<FilesWatchEvent>(1);
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              startFsWatcher(root, (event) => {
                Queue.offerUnsafe(
                  queue,
                  event._tag === 'Changed' ? { ...event, paths: [''], overflow: true } : event,
                );
              }),
            ),
            (stop) => Effect.sync(stop),
          );
          return Stream.fromQueue(queue);
        }),
      );

    return {
      listDir,
      readPreview,
      openExternal,
      watch: watchRoot,
    } satisfies FilesShape;
  }),
);
