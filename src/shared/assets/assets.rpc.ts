import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** The largest asset a Remote device serves; a bigger one shows a "too large to preview" placeholder. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/**
 * An opaque token a host mints for one inline asset of a Remote Session, valid only on the connection that received
 * it and only while it lasts: unknown or expired, `Assets.read` fails with `NotFound`.
 */
export const AssetHandle = Schema.String.pipe(Schema.brand('AssetHandle')).annotate({
  identifier: 'AssetHandle',
});
export type AssetHandle = typeof AssetHandle.Type;

/**
 * What a host sends in place of an asset's bytes over the LAN: its decoded size and, unless it is bigger than
 * `MAX_ASSET_BYTES`, the handle to fetch it with. The part's inline bytes are then empty.
 */
export const AssetRef = Schema.Struct({
  size: Schema.Number,
  /** Absent when the asset is too large to preview: there is nothing to fetch. */
  handle: Schema.optionalKey(AssetHandle),
}).annotate({ identifier: 'AssetRef' });
export type AssetRef = typeof AssetRef.Type;

/** The bytes of one asset, base64 as in the part it stands for. */
export const AssetBytes = Schema.Struct({
  data: Schema.String,
}).annotate({ identifier: 'AssetBytes' });
export type AssetBytes = typeof AssetBytes.Type;

export class AssetsError extends Schema.TaggedError<AssetsError>()('AssetsError', {
  /**
   * `NotFound`: the handle is unknown here, or its connection has gone. `Unavailable`: its Device is not connected
   * now; worth asking again once it reconnects.
   */
  reason: Schema.Literals(['NotFound', 'Unavailable']),
  detail: Schema.String,
}) {}

export const AssetsRpcs = RpcGroup.make(
  /** The bytes behind a handle a Remote device sent with a Session's Transcript. Read on demand, never stored. */
  Rpc.make('Assets.read', {
    payload: { handle: AssetHandle },
    success: AssetBytes,
    error: AssetsError,
  }),
);
