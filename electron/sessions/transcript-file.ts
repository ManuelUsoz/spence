import { Effect, Schema } from 'effect';
import {
  Compaction,
  ContextCleared,
  LinkPart,
  Message,
  MessageDelta,
  Notice,
  PermissionRequest,
  Plan,
  Step,
  TextContents,
  TextPart,
  Thought,
  ThoughtDelta,
  Timestamp,
  TurnEnded,
  TurnStarted,
  type MessagePart,
  type TranscriptEvent,
} from '../../src/shared/sessions/sessions.rpc';

// How a Transcript is stored: one `StoredEvent` per line of `transcript.jsonl`. The bytes of image, audio and blob
// resource parts live in `blobs/<sha256>` beside it; a stored part names its blob by hash.

const Sha256 = Schema.String;

const StoredImagePart = Schema.TaggedStruct('image', { mimeType: Schema.String, sha256: Sha256 });
const StoredAudioPart = Schema.TaggedStruct('audio', { mimeType: Schema.String, sha256: Sha256 });
const StoredResourcePart = Schema.TaggedStruct('resource', {
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  contents: Schema.Union([TextContents, Schema.TaggedStruct('blob', { sha256: Sha256 })]),
});

const StoredPart = Schema.Union([
  TextPart,
  LinkPart,
  StoredImagePart,
  StoredAudioPart,
  StoredResourcePart,
]);
type StoredPart = typeof StoredPart.Type;

const StoredMessage = Schema.TaggedStruct('Message', {
  ...Message.fields,
  parts: Schema.Array(StoredPart),
});

const StoredItem = Schema.Union([
  TurnStarted,
  TurnEnded,
  StoredMessage,
  MessageDelta,
  Thought,
  ThoughtDelta,
  Step,
  Plan,
  PermissionRequest,
  Compaction,
  Notice,
  ContextCleared,
]);

export const StoredEvent = Schema.Struct({ seq: Schema.Number, at: Timestamp, item: StoredItem });
export type StoredEvent = typeof StoredEvent.Type;

/** A Session's blob folder. */
export interface BlobBytes {
  /** Stores the bytes (once per content) and returns their sha256. */
  readonly put: (bytes: Uint8Array) => Effect.Effect<string>;
  readonly get: (sha256: string) => Effect.Effect<Uint8Array>;
}

const fromBase64 = (data: string): Uint8Array => new Uint8Array(Buffer.from(data, 'base64'));
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const storePart =
  (blobs: BlobBytes) =>
  (part: MessagePart): Effect.Effect<StoredPart> => {
    switch (part._tag) {
      case 'text':
      case 'link':
        return Effect.succeed(part);
      case 'image':
      case 'audio':
        return blobs
          .put(fromBase64(part.data))
          .pipe(Effect.map((sha256) => ({ _tag: part._tag, mimeType: part.mimeType, sha256 })));
      case 'resource': {
        const { contents } = part;
        if (contents._tag === 'text') return Effect.succeed({ ...part, contents });
        return blobs
          .put(fromBase64(contents.blob))
          .pipe(Effect.map((sha256) => ({ ...part, contents: { _tag: 'blob', sha256 } })));
      }
    }
  };

const inlinePart =
  (blobs: BlobBytes) =>
  (part: StoredPart): Effect.Effect<MessagePart> => {
    switch (part._tag) {
      case 'text':
      case 'link':
        return Effect.succeed(part);
      case 'image':
      case 'audio':
        return blobs.get(part.sha256).pipe(
          Effect.map((bytes) => ({
            _tag: part._tag,
            mimeType: part.mimeType,
            data: toBase64(bytes),
          })),
        );
      case 'resource': {
        const { contents } = part;
        if (contents._tag === 'text') return Effect.succeed({ ...part, contents });
        return blobs
          .get(contents.sha256)
          .pipe(
            Effect.map((bytes) => ({ ...part, contents: { _tag: 'blob', blob: toBase64(bytes) } })),
          );
      }
    }
  };

/** Moves an event's binary parts into blobs, leaving their hashes. */
export const storeEvent =
  (blobs: BlobBytes) =>
  (event: TranscriptEvent): Effect.Effect<StoredEvent> => {
    const { item } = event;
    if (item._tag !== 'Message') return Effect.succeed({ ...event, item });
    return Effect.forEach(item.parts, storePart(blobs)).pipe(
      Effect.map((parts) => ({ ...event, item: { ...item, parts } })),
    );
  };

/** Puts the bytes of an event's blobs back into its parts. */
export const inlineEvent =
  (blobs: BlobBytes) =>
  (event: StoredEvent): Effect.Effect<TranscriptEvent> => {
    const { item } = event;
    if (item._tag !== 'Message') return Effect.succeed({ ...event, item });
    return Effect.forEach(item.parts, inlinePart(blobs)).pipe(
      Effect.map((parts) => ({ ...event, item: { ...item, parts } })),
    );
  };
