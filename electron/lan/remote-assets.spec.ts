/**
 * Remote assets: two in-process Devices over real loopback `wss://`. The host serves a Session whose Transcript holds
 * inline images, audio and blob resources; the viewer reads it as its window would (the Device named in the
 * `DEVICE_SCOPE_HEADER`) and fetches the bytes on demand with `Assets.read`.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { RpcClient } from 'effect/rpc';
import { type AssetHandle, MAX_ASSET_BYTES } from '../../src/shared/assets/assets.rpc';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import {
  MessageId,
  type MessagePart,
  SessionId,
  SessionsRpcs,
  type SessionStreamItem,
  type TranscriptEvent,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import { makeTestDevice, pairDevices, type TestDevice } from '../devices/test-peer';

const TIMEOUT = 30_000;

const SESSION = SessionId.make('s-1');

const onDevice =
  (device: DeviceId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

const base64Of = (bytes: number, fill = 7): string => Buffer.alloc(bytes, fill).toString('base64');

const PNG = base64Of(300, 1);

const messageEvent = (seq: number, parts: ReadonlyArray<MessagePart>): TranscriptEvent => ({
  seq,
  at: Timestamp.make(seq),
  item: {
    _tag: 'Message',
    id: MessageId.make(`m-${seq}`),
    turnId: TurnId.make('t-1'),
    role: 'agent',
    parts,
  },
});

/** A host whose one Session's Transcript is `events`, as `Session.events` streams it (after `afterSeq`). */
const hostWithTranscript = (events: ReadonlyArray<TranscriptEvent>) =>
  makeTestDevice({
    serve: SessionsRpcs.toLayerHandler('Session.events', ({ afterSeq }) =>
      Stream.fromIterable(
        events
          .filter((event) => event.seq > (afterSeq ?? 0))
          .map((event): SessionStreamItem => ({ _tag: 'Transcript', event })),
      ),
    ),
  });

const connected = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  yield* pairDevices(host, viewer);
  const hostId = (yield* host.identity).id;
  yield* viewer.awaitConnection(hostId, 'Online');
  return hostId;
});

/** Every part of every Message the viewer's window gets for the Session on `device`. */
const partsSeen = (viewer: TestDevice, device: DeviceId) =>
  onDevice(device)(
    viewer.desktop['Session.events']({ sessionId: SESSION }).pipe(Stream.runCollect),
  ).pipe(
    Effect.map((items) =>
      items.flatMap((item) =>
        item._tag === 'Transcript' && item.event.item._tag === 'Message'
          ? item.event.item.parts
          : [],
      ),
    ),
  );

/** Every part of every Message a Device's own window gets for its Local Session. */
const partsSeenLocally = (device: TestDevice) =>
  device.desktop['Session.events']({ sessionId: SESSION }).pipe(
    Stream.runCollect,
    Effect.map((items) =>
      items.flatMap((item) =>
        item._tag === 'Transcript' && item.event.item._tag === 'Message'
          ? item.event.item.parts
          : [],
      ),
    ),
  );

const handleOf = (part: MessagePart | undefined): AssetHandle => {
  if (part?._tag !== 'image' || part.asset?.handle === undefined) {
    throw new Error(`no asset handle on ${JSON.stringify(part)}`);
  }
  return part.asset.handle;
};

describe('Remote assets', () => {
  it.live(
    'an image reaches the viewer as a handle, and Assets.read fetches its bytes',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([
          messageEvent(1, [{ _tag: 'image', mimeType: 'image/png', data: PNG }]),
        ]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);

        const [image] = yield* partsSeen(viewer, hostId);
        expect(image).toMatchObject({
          _tag: 'image',
          mimeType: 'image/png',
          data: '',
          asset: { size: 300 },
        });

        const bytes = yield* onDevice(hostId)(
          viewer.desktop['Assets.read']({ handle: handleOf(image) }),
        );
        expect(bytes).toEqual({ data: PNG });
        // The host's own Transcript keeps its bytes inline.
        const [own] = yield* partsSeenLocally(host);
        expect(own).toEqual({ _tag: 'image', mimeType: 'image/png', data: PNG });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'audio and blob resources travel as handles too; text resources stay inline',
    () =>
      Effect.gen(function* () {
        const sound = base64Of(40, 2);
        const blob = base64Of(50, 3);
        const host = yield* hostWithTranscript([
          messageEvent(1, [
            { _tag: 'audio', mimeType: 'audio/wav', data: sound },
            { _tag: 'resource', uri: 'file:///a.bin', contents: { _tag: 'blob', blob } },
            { _tag: 'resource', uri: 'file:///a.txt', contents: { _tag: 'text', text: 'hi' } },
          ]),
        ]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        const read = (handle: AssetHandle | undefined) =>
          handle === undefined
            ? Effect.die('no handle')
            : onDevice(hostId)(viewer.desktop['Assets.read']({ handle }));

        const [audio, binary, text] = yield* partsSeen(viewer, hostId);
        if (audio?._tag !== 'audio' || binary?._tag !== 'resource') {
          return yield* Effect.die('unexpected parts');
        }
        expect(audio).toMatchObject({ data: '', asset: { size: 40 } });
        expect(binary.contents).toMatchObject({ _tag: 'blob', blob: '', asset: { size: 50 } });
        expect(text).toEqual({
          _tag: 'resource',
          uri: 'file:///a.txt',
          contents: { _tag: 'text', text: 'hi' },
        });
        expect(yield* read(audio.asset?.handle)).toEqual({ data: sound });
        const blobHandle =
          binary.contents._tag === 'blob' ? binary.contents.asset?.handle : undefined;
        expect(yield* read(blobHandle)).toEqual({ data: blob });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'an asset over 10 MiB comes with its size and no handle: too large to preview',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([
          messageEvent(1, [
            { _tag: 'image', mimeType: 'image/png', data: base64Of(MAX_ASSET_BYTES + 1) },
          ]),
        ]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);

        const [image] = yield* partsSeen(viewer, hostId);
        expect(image).toEqual({
          _tag: 'image',
          mimeType: 'image/png',
          data: '',
          asset: { size: MAX_ASSET_BYTES + 1 },
        });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a handle is NotFound when unknown, or on another connection than the one it was sent on',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([
          messageEvent(1, [{ _tag: 'image', mimeType: 'image/png', data: PNG }]),
        ]);
        const viewer = yield* makeTestDevice();
        const other = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        yield* connected(host, other);

        const unknown = yield* Effect.flip(
          onDevice(hostId)(
            viewer.desktop['Assets.read']({ handle: 'not-a-handle' as AssetHandle }),
          ),
        );
        expect(unknown).toMatchObject({ _tag: 'AssetsError', reason: 'NotFound' });

        const [image] = yield* partsSeen(viewer, hostId);
        const elsewhere = yield* Effect.flip(
          onDevice(hostId)(other.desktop['Assets.read']({ handle: handleOf(image) })),
        );
        expect(elsewhere).toMatchObject({ _tag: 'AssetsError', reason: 'NotFound' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'an asset the viewer saw before its connection was replaced is read again on the new one',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([
          messageEvent(1, [{ _tag: 'text', text: 'first' }]),
          messageEvent(2, [
            { _tag: 'image', mimeType: 'image/png', data: base64Of(10, 9) },
            { _tag: 'image', mimeType: 'image/png', data: PNG },
          ]),
        ]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        const [, , second] = yield* partsSeen(viewer, hostId);

        // Retry: the old connection, and every handle it was sent, is gone.
        yield* viewer.connect(hostId);
        yield* viewer.awaitConnection(hostId, 'Online');

        const bytes = yield* onDevice(hostId)(
          viewer.desktop['Assets.read']({ handle: handleOf(second) }),
        );
        expect(bytes).toEqual({ data: PNG });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'a handle the host never sent stays NotFound after a reconnect',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        yield* viewer.connect(hostId);
        yield* viewer.awaitConnection(hostId, 'Online');

        const error = yield* Effect.flip(
          onDevice(hostId)(viewer.desktop['Assets.read']({ handle: 'never-sent' as AssetHandle })),
        );
        expect(error).toMatchObject({ _tag: 'AssetsError', reason: 'NotFound' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'an asset of an Offline Device is Unavailable, a typed failure that leaves the window connected',
    () =>
      Effect.gen(function* () {
        const host = yield* hostWithTranscript([
          messageEvent(1, [{ _tag: 'image', mimeType: 'image/png', data: PNG }]),
        ]);
        const viewer = yield* makeTestDevice();
        const hostId = yield* connected(host, viewer);
        const [image] = yield* partsSeen(viewer, hostId);

        yield* host.setHosting(false);
        yield* viewer.awaitConnection(hostId, 'Offline');

        const error = yield* Effect.flip(
          onDevice(hostId)(viewer.desktop['Assets.read']({ handle: handleOf(image) })),
        );
        expect(error).toMatchObject({ _tag: 'AssetsError', reason: 'Unavailable' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
