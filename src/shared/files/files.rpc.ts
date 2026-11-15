import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { ProjectId } from '../projects/projects.rpc';
import { WorktreeId } from '../worktrees/worktrees.rpc';

/** Default maximum bytes decoded for read-only saved-file previews (2 MiB). */
export const DEFAULT_FILES_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Default page size returned for one bounded directory listing call. */
export const DEFAULT_FILES_DIR_PAGE_LIMIT = 200;

/** Tagged error reason codes for the Files domain. */
export const FilesErrorReason = Schema.Literals([
  'NotFound',
  'OutsideRoot',
  'MissingProject',
  'MissingWorktree',
  'UnsupportedFile',
  'WorkerFailed',
  'IoFailed',
]).annotate({ identifier: 'FilesErrorReason' });
export type FilesErrorReason = typeof FilesErrorReason.Type;

/** Tagged error for the Files RPC domain. */
export class FilesError extends Schema.TaggedError<FilesError>()('FilesError', {
  reason: FilesErrorReason,
  detail: Schema.String,
}) {}

/** Domain root identity passed by callers; main resolves and verifies canonical containment from it. */
export const FilesRootTarget = Schema.Struct({
  projectId: ProjectId,
  worktreeId: Schema.optionalKey(WorktreeId),
}).annotate({ identifier: 'FilesRootTarget' });
export type FilesRootTarget = typeof FilesRootTarget.Type;

/** Entry kinds distinguished in directory listings without traversing symlinks or nested repos. */
export const FilesEntryKind = Schema.Literals([
  'file',
  'directory',
  'symlink',
  'nestedRepo',
  'special',
]).annotate({ identifier: 'FilesEntryKind' });
export type FilesEntryKind = typeof FilesEntryKind.Type;

/** One entry returned inside a bounded directory listing page. */
export const FilesEntry = Schema.Struct({
  /** Normalized POSIX relative path from the validated root (no leading `./`, never `.git` or `..`). */
  path: Schema.String,
  name: Schema.String,
  kind: FilesEntryKind,
  ignored: Schema.Boolean,
  size: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: 'FilesEntry' });
export type FilesEntry = typeof FilesEntry.Type;

/** One bounded page of entries in a validated directory under a Project or Worktree root. */
export const FilesDirectoryPage = Schema.Struct({
  /** Normalized POSIX relative directory path (`''` for root). */
  dirPath: Schema.String,
  isGitRepo: Schema.Boolean,
  showIgnoredFiles: Schema.Boolean,
  entries: Schema.Array(FilesEntry),
  nextCursor: Schema.optionalKey(Schema.String),
  hasMore: Schema.Boolean,
}).annotate({ identifier: 'FilesDirectoryPage' });
export type FilesDirectoryPage = typeof FilesDirectoryPage.Type;

/** Explicit non-error reasons a requested saved-file preview cannot show text. */
export const FilesUnavailableReason = Schema.Literals([
  'Missing',
  'Symlink',
  'SpecialFile',
  'NestedRepo',
  'Directory',
  'Unreadable',
]).annotate({ identifier: 'FilesUnavailableReason' });
export type FilesUnavailableReason = typeof FilesUnavailableReason.Type;

/** Bounded UTF-8 text preview, with `truncated: true` when total bytes exceed the cap. */
export const FilesTextPreview = Schema.Struct({
  _tag: Schema.Literal('Text'),
  path: Schema.String,
  content: Schema.String,
  byteLength: Schema.Number,
  totalBytes: Schema.Number,
  truncated: Schema.Boolean,
  previewLimitBytes: Schema.Number,
  mtimeMs: Schema.Number,
}).annotate({ identifier: 'FilesTextPreview' });
export type FilesTextPreview = typeof FilesTextPreview.Type;

/** Preview metadata returned when binary bytes are detected without dumping raw binary content. */
export const FilesBinaryPreview = Schema.Struct({
  _tag: Schema.Literal('Binary'),
  path: Schema.String,
  totalBytes: Schema.Number,
  mtimeMs: Schema.Number,
}).annotate({ identifier: 'FilesBinaryPreview' });
export type FilesBinaryPreview = typeof FilesBinaryPreview.Type;

/** Preview result when a valid relative path cannot be previewed cleanly. */
export const FilesUnavailablePreview = Schema.Struct({
  _tag: Schema.Literal('Unavailable'),
  path: Schema.String,
  reason: FilesUnavailableReason,
  detail: Schema.String,
}).annotate({ identifier: 'FilesUnavailablePreview' });
export type FilesUnavailablePreview = typeof FilesUnavailablePreview.Type;

/** Discriminated read-only preview of a saved workspace file. */
export const FilesPreview = Schema.Union([
  FilesTextPreview,
  FilesBinaryPreview,
  FilesUnavailablePreview,
]).annotate({ identifier: 'FilesPreview' });
export type FilesPreview = typeof FilesPreview.Type;

/** Live watch event emitted for a validated Project or Worktree root. */
export const FilesWatchEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('Changed'),
    /** Normalized relative POSIX paths affected, or `['']` when the root / wide tree changed. */
    paths: Schema.Array(Schema.String),
    overflow: Schema.Boolean,
  }),
  Schema.Struct({
    _tag: Schema.Literal('Unavailable'),
    reason: Schema.Literals(['RootMissing', 'IdentityChanged', 'WatchFailed']),
    detail: Schema.String,
  }),
]).annotate({ identifier: 'FilesWatchEvent' });
export type FilesWatchEvent = typeof FilesWatchEvent.Type;

/** Files RPC contract for browsing and opening live saved files under a Project or Worktree. */
export class FilesRpcs extends RpcGroup.make(
  /** Lists one bounded page of entries in a directory under a validated Project or Worktree root. */
  Rpc.make('Files.listDir', {
    payload: {
      target: FilesRootTarget,
      dirPath: Schema.String,
      cursor: Schema.optionalKey(Schema.String),
      limit: Schema.optionalKey(Schema.Number),
      showIgnoredFiles: Schema.optionalKey(Schema.Boolean),
    },
    success: FilesDirectoryPage,
    error: FilesError,
  }),
  /** Reads a bounded, read-only preview of a saved file under a validated Project or Worktree root. */
  Rpc.make('Files.readPreview', {
    payload: {
      target: FilesRootTarget,
      relativePath: Schema.String,
      maxBytes: Schema.optionalKey(Schema.Number),
    },
    success: FilesPreview,
    error: FilesError,
  }),
  /** Opens a validated regular file inside a Project or Worktree with the OS default handler. */
  Rpc.make('Files.openExternal', {
    payload: {
      target: FilesRootTarget,
      relativePath: Schema.String,
    },
    error: FilesError,
  }),
  /** Streams debounced live file change notifications with overflow rescan signals. */
  Rpc.make('Files.watch', {
    payload: {
      target: FilesRootTarget,
    },
    success: FilesWatchEvent,
    error: FilesError,
    stream: true,
  }),
) {}
