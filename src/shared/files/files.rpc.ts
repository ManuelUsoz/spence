import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId } from '../sessions/sessions.rpc';

export const FolderEntry = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literals(['Dir', 'File', 'Symlink', 'Other']),
  /** Matched by .gitignore; always false outside a repository. */
  ignored: Schema.Boolean,
}).annotate({ identifier: 'FolderEntry' });
export type FolderEntry = typeof FolderEntry.Type;

/** One folder of the Session's working folder: folders first, each group by name. `.git` is never listed. */
export const FolderListing = Schema.Union([
  Schema.TaggedStruct('Listing', {
    entries: Schema.Array(FolderEntry),
    /** More entries exist than were returned. */
    truncated: Schema.Boolean,
  }),
  /** The path is absolute, leaves the folder or reaches `.git`. */
  Schema.TaggedStruct('Invalid', { detail: Schema.String }),
  Schema.TaggedStruct('Missing', { detail: Schema.String }),
]).annotate({ identifier: 'FolderListing' });
export type FolderListing = typeof FolderListing.Type;

export const NoPreviewReason = Schema.Literals([
  'Binary',
  'TooLarge',
  'NotFile',
  'Unreadable',
  'Missing',
]).annotate({ identifier: 'NoPreviewReason' });
export type NoPreviewReason = typeof NoPreviewReason.Type;

/** The text of one file, or why there is none to show. */
export const TextFile = Schema.Union([
  Schema.TaggedStruct('Text', { content: Schema.String, size: Schema.Number }),
  Schema.TaggedStruct('NoPreview', { reason: NoPreviewReason }),
  Schema.TaggedStruct('Invalid', { detail: Schema.String }),
]).annotate({ identifier: 'TextFile' });
export type TextFile = typeof TextFile.Type;

export class FilesError extends Schema.TaggedError<FilesError>()('FilesError', {
  reason: Schema.Literals(['SessionNotFound']),
  detail: Schema.String,
}) {}

export const FilesRpcs = RpcGroup.make(
  /** The entries of a folder, `path` relative to the Session's folder (`''` for the folder itself). */
  Rpc.make('Files.list', {
    payload: { sessionId: SessionId, path: Schema.String },
    success: FolderListing,
    error: FilesError,
  }),
  /** The text of a file, `path` relative to the Session's folder. Read only. */
  Rpc.make('Files.read', {
    payload: { sessionId: SessionId, path: Schema.String },
    success: TextFile,
    error: FilesError,
  }),
);
