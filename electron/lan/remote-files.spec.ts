/**
 * Files over Remote: the viewer lists and reads a Remote Session's folder exactly as a Local one, and the caps (2,000
 * entries per listing, 1 MiB of text) are applied on the host before anything crosses the LAN. The Session lookup is
 * the only stand-in: it maps the Session to a temporary folder on the host.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { RpcClient } from 'effect/rpc';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEVICE_SCOPE_HEADER, type DeviceId } from '../../src/shared/devices/devices.rpc';
import { SessionError, SessionId } from '../../src/shared/sessions/sessions.rpc';
import { makeTestDevice, pairDevices } from '../devices/test-peer';
import { MAX_LISTED_ENTRIES, MAX_TEXT_BYTES } from '../files/files-core';
import { layerFiles } from '../files/files';
import { layerFilesHandlersWith } from '../rpc/files';
import { Sessions, type SessionsShape } from '../sessions/sessions';

const TIMEOUT = 60_000;
const SESSION = SessionId.make('s-files');

const onDevice =
  (device: DeviceId) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RpcClient.withHeaders(effect, { [DEVICE_SCOPE_HEADER]: device });

/** A folder with more entries than one listing shows, and one text file over the preview cap. */
const crowdedFolder = Effect.acquireRelease(
  Effect.promise(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-remote-files-'));
    await Promise.all(
      Array.from({ length: MAX_LISTED_ENTRIES + 1 }, (_, i) =>
        writeFile(path.join(dir, `f-${String(i).padStart(5, '0')}.txt`), 'x'),
      ),
    );
    await writeFile(path.join(dir, 'big.txt'), 'a'.repeat(MAX_TEXT_BYTES + 1));
    return dir;
  }),
  (dir) =>
    Effect.promise(() =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ),
);

const sessionsIn = (folder: string) =>
  Layer.succeed(Sessions, {
    folderOf: (id: SessionId) =>
      id === SESSION
        ? Effect.succeed(folder)
        : Effect.fail(new SessionError({ reason: 'NotFound', detail: 'No Session.' })),
  } as unknown as SessionsShape);

describe('Files over Remote', () => {
  it.live(
    'a listing and a preview are capped on the host',
    () =>
      Effect.gen(function* () {
        const folder = yield* crowdedFolder;
        const host = yield* makeTestDevice({
          serve: layerFilesHandlersWith.pipe(
            Layer.provide(layerFiles),
            Layer.provide(sessionsIn(folder)),
          ),
        });
        const viewer = yield* makeTestDevice();
        yield* pairDevices(host, viewer);
        const hostId = (yield* host.identity).id;
        yield* viewer.awaitConnection(hostId, 'Online');
        const remote = onDevice(hostId);

        const listing = yield* remote(
          viewer.desktop['Files.list']({ sessionId: SESSION, path: '' }),
        );
        expect(listing._tag === 'Listing' && listing.entries.length).toBe(MAX_LISTED_ENTRIES);
        expect(listing).toMatchObject({ _tag: 'Listing', truncated: true });

        const big = yield* remote(
          viewer.desktop['Files.read']({ sessionId: SESSION, path: 'big.txt' }),
        );
        expect(big).toEqual({ _tag: 'NoPreview', reason: 'TooLarge' });
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
