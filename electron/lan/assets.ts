import { type Cause, Context, Effect, Layer, type Queue, Stream } from 'effect';
import type { Rpc } from 'effect/rpc';
import { randomBytes } from 'node:crypto';
import {
  AssetHandle,
  type AssetRef,
  AssetsError,
  MAX_ASSET_BYTES,
} from '../../src/shared/assets/assets.rpc';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type {
  MessagePart,
  SessionStreamItem,
  TranscriptItem,
} from '../../src/shared/sessions/sessions.rpc';

/** The assets one LAN connection was sent handles for: bytes by handle, and the handle of bytes already sent. */
interface ConnectionAssets {
  readonly bytes: Map<AssetHandle, string>;
  readonly handles: Map<string, AssetHandle>;
}

/**
 * Kept on the connection's `ServerClient` itself, so the handles live exactly as long as the connection: a dropped
 * connection takes them with it, and a new one starts with none.
 */
class ConnectionAssetsKey extends Context.Service<ConnectionAssetsKey, ConnectionAssets>()(
  'lan/ConnectionAssets',
) {}

const assetsOf = (client: Rpc.ServerClient): ConnectionAssets => {
  const known = Context.getOption(client.annotations, ConnectionAssetsKey);
  if (known._tag === 'Some') return known.value;
  const made: ConnectionAssets = { bytes: new Map(), handles: new Map() };
  client.annotate(ConnectionAssetsKey, made);
  return made;
};

/** The decoded size of base64 `data`, without decoding it. */
const sizeOf = (data: string): number => Buffer.byteLength(data, 'base64');

/** A reference to `data` for this connection: a handle to fetch it with, or none when it is too large to preview. */
const refer = (assets: ConnectionAssets, data: string): AssetRef => {
  const size = sizeOf(data);
  if (size > MAX_ASSET_BYTES) return { size };
  const sent = assets.handles.get(data);
  if (sent !== undefined) return { size, handle: sent };
  const handle = AssetHandle.make(randomBytes(18).toString('base64url'));
  assets.bytes.set(handle, data);
  assets.handles.set(data, handle);
  return { size, handle };
};

/** `part` with its inline bytes swapped for a reference; parts with no bytes are left as they are. */
const swapPart = (assets: ConnectionAssets, part: MessagePart): MessagePart => {
  switch (part._tag) {
    case 'image':
    case 'audio':
      return part.data === '' ? part : { ...part, data: '', asset: refer(assets, part.data) };
    case 'resource':
      return part.contents._tag === 'blob' && part.contents.blob !== ''
        ? {
            ...part,
            contents: { _tag: 'blob', blob: '', asset: refer(assets, part.contents.blob) },
          }
        : part;
    case 'text':
    case 'link':
      return part;
  }
};

const swapItem = (assets: ConnectionAssets, item: TranscriptItem): TranscriptItem =>
  item._tag === 'Message'
    ? { ...item, parts: item.parts.map((part) => swapPart(assets, part)) }
    : item;

const swapStreamItem = (assets: ConnectionAssets, item: SessionStreamItem): SessionStreamItem =>
  item._tag === 'Transcript'
    ? { ...item, event: { ...item.event, item: swapItem(assets, item.event.item) } }
    : item;

/** The references of a Message's parts, in order: what a viewer relocates a handle by. */
export const assetRefsOf = (parts: ReadonlyArray<MessagePart>): ReadonlyArray<AssetRef> =>
  parts.flatMap((part) => {
    switch (part._tag) {
      case 'image':
      case 'audio':
        return part.asset === undefined ? [] : [part.asset];
      case 'resource':
        return part.contents._tag === 'blob' && part.contents.asset !== undefined
          ? [part.contents.asset]
          : [];
      case 'text':
      case 'link':
        return [];
    }
  });

/** A stream handler's result as a stream: a handler answers with a stream, or with a queue to read it from. */
export const streamOfResult = <A, E>(
  result: Stream.Stream<A, E> | Effect.Effect<Queue.Dequeue<A, E | Cause.Done>, E>,
): Stream.Stream<A, E> =>
  Stream.isStream(result)
    ? result
    : Stream.unwrap(Effect.map(result, (queue) => Stream.fromQueue(queue)));

/**
 * What the LAN server serves on top of the shared handlers: a Session's Transcript goes out with every inline image,
 * audio and blob resource swapped for a handle minted for the receiving connection (the host's Transcript is left as
 * it is), and `Assets.read` answers those handles. Only Transcript items carry handles: the Live state (the Queue)
 * keeps its bytes, so editing the Queue from a viewer sends them back whole.
 */
export const layerRemoteAssets = Layer.mergeAll(
  RemoteRpcs.toLayerHandler(
    'Session.events',
    Effect.map(RemoteRpcs.accessHandler('Session.events'), (events) => (payload, options) => {
      return Stream.map(streamOfResult(events(payload, options)), (item) =>
        swapStreamItem(assetsOf(options.client), item),
      );
    }),
  ),
  RemoteRpcs.toLayerHandler('Assets.read', ({ handle }, { client }) => {
    const data = assetsOf(client).bytes.get(handle);
    return data === undefined
      ? Effect.fail(
          new AssetsError({ reason: 'NotFound', detail: `No asset ${handle} on this connection.` }),
        )
      : Effect.succeed({ data });
  }),
);
