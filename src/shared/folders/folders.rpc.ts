import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** One folder inside the listed one. A link is shown under its own name and leads to its target. */
export const FolderEntry = Schema.Struct({
  name: Schema.String,
  /** Where it leads: its real path, a link resolved. */
  path: Schema.String,
  /** Its name starts with a dot: listed only when hidden folders are asked for. */
  hidden: Schema.Boolean,
  /** It is a link (a symlink or junction) to another folder. */
  link: Schema.Boolean,
}).annotate({ identifier: 'FolderEntry' });
export type FolderEntry = typeof FolderEntry.Type;

/** A folder of the Device's disk, as the in-app folder browser shows it: its sub-folders only, never files. */
export const FolderListing = Schema.Struct({
  /** The listed folder's real path. */
  path: Schema.String,
  /** The folder above; `null` at a root. */
  parent: Schema.NullOr(Schema.String),
  /** The Device's home folder, where browsing starts. */
  home: Schema.String,
  /** Where the disk starts: the drives on Windows, `/` elsewhere. */
  roots: Schema.Array(Schema.String),
  /** Its sub-folders, by name. */
  entries: Schema.Array(FolderEntry),
}).annotate({ identifier: 'FolderListing' });
export type FolderListing = typeof FolderListing.Type;

/** `Missing`: no folder at the path (or it is a file). `Unreadable`: the folder is there but cannot be listed. */
export class FoldersError extends Schema.TaggedError<FoldersError>()('FoldersError', {
  reason: Schema.Literals(['Missing', 'Unreadable']),
  detail: Schema.String,
}) {}

/**
 * The read-only folder browser a Remote device's Projects are added and located with (the Local device keeps the
 * native dialog). Lists directories only and never reads a file; there is no allow-list.
 */
export const FoldersRpcs = RpcGroup.make(
  /** Lists `path` (`null`: the home folder); folders whose name starts with a dot only when `hidden`. */
  Rpc.make('Folders.browse', {
    payload: { path: Schema.NullOr(Schema.String), hidden: Schema.Boolean },
    success: FolderListing,
    error: FoldersError,
  }),
);
