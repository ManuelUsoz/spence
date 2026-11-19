/**
 * The Remote devices connected to a host (its viewers), as Settings > Devices, the tray and the quit confirm see
 * them: two in-process Devices over real loopback `wss://`.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { makeTestDevice, pairDevices } from '../devices/test-peer';

const TIMEOUT = 60_000;

describe('Connected viewers', () => {
  it.live(
    'a connected viewer is listed on the host by name, and leaves the list once unpaired',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        yield* viewer.rename('Study laptop');
        expect(yield* host.viewers).toEqual([]);

        yield* pairDevices(host, viewer);
        const hostId = (yield* host.identity).id;
        const viewerId = (yield* viewer.identity).id;
        yield* viewer.awaitConnection(hostId, 'Online');

        expect(yield* host.awaitViewers(1)).toEqual([{ id: viewerId, name: 'Study laptop' }]);

        yield* host.unpair(viewerId);
        expect(yield* host.awaitViewers(0)).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'Disconnect closes the viewer’s connections to the host',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        yield* pairDevices(host, viewer);
        const hostId = (yield* host.identity).id;
        const viewerId = (yield* viewer.identity).id;
        yield* viewer.awaitConnection(hostId, 'Online');
        yield* host.awaitViewers(1);

        yield* host.disconnect(viewerId);

        yield* viewer.awaitConnection(hostId, 'Reconnecting').pipe(Effect.timeout('10 seconds'));
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'turning hosting off drops every viewer',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        yield* pairDevices(host, viewer);
        yield* viewer.awaitConnection((yield* host.identity).id, 'Online');
        yield* host.awaitViewers(1);

        yield* host.setHosting(false);

        expect(yield* host.awaitViewers(0)).toEqual([]);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );
});
