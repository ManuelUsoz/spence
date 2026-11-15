import { Schema } from 'effect';
import { RpcGroup } from 'effect/rpc';

/** Tagged error reserved for the Wave 2 Files RPC domain. */
export class FilesError extends Schema.TaggedError<FilesError>()('FilesError', {
  reason: Schema.Literals(['NotFound', 'OutsideRoot', 'IoFailed']),
  detail: Schema.String,
}) {}

/** Placeholder RPC group merged into `DesktopRpcs` for Wave 2 workspace file browsing. */
export class FilesRpcs extends RpcGroup.make() {}
