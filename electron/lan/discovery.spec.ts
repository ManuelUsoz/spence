/**
 * Nearby Device discovery over the LAN seam: in-process Devices on one fake LAN (no multicast socket), each with
 * its own data directory and a real loopback listener, observed through what Settings > Devices uses.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Option, Stream } from 'effect';
import type { DevicesState, NearbyDevice } from '../../src/shared/devices/devices.rpc';
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { makeTestDevice, pairDevices, type TestDevice } from '../devices/test-peer';
import { type FakeLan, makeFakeLan } from './mdns-fake';

/** The first nearby list `device` sees that satisfies `found`, looking only while it waits. */
const nearbyUntil = (device: TestDevice, found: (nearby: ReadonlyArray<NearbyDevice>) => boolean) =>
  device.nearby.pipe(
    Stream.filter(found),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.timeout('5 seconds'),
  );

const stateUntil = (device: TestDevice, found: (state: DevicesState) => boolean) =>
  device.watch.pipe(Stream.filter(found), Stream.runHead, Effect.timeout('5 seconds'));

const untilBrowsers = (lan: FakeLan, found: (count: number) => boolean) =>
  lan.browsing.pipe(Stream.filter(found), Stream.runHead, Effect.timeout('5 seconds'));

describe('Nearby Device discovery', () => {
  it.live('nothing is announced or browsed while hosting is off and nobody looks', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const device = yield* makeTestDevice({ lan });
      yield* device.local;
      expect(yield* lan.responders).toBe(0);
      expect(yield* lan.browsers).toBe(0);

      yield* device.setHosting(true);
      yield* device.setHosting(false);
      expect(yield* lan.announced).toEqual([]);
      expect(yield* lan.responders).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live('a hosting Device is seen nearby with its name, address and protocol only', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const host = yield* makeTestDevice({ lan });
      const viewer = yield* makeTestDevice({ lan });
      yield* host.rename('Studio PC');
      yield* host.setHosting(true);
      const { id } = yield* host.identity;

      const nearby = yield* nearbyUntil(viewer, (list) => list.length > 0);
      expect(nearby).toEqual([
        { id, name: 'Studio PC', address: yield* host.address, protocolVersion: PROTOCOL_VERSION },
      ]);
      expect(yield* lan.announced).toEqual([
        {
          id,
          name: 'Studio PC',
          port: (yield* host.local).port,
          protocolVersion: PROTOCOL_VERSION,
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.live('the announcement follows a rename and is withdrawn when hosting turns off', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const host = yield* makeTestDevice({ lan });
      const viewer = yield* makeTestDevice({ lan });
      yield* host.setHosting(true);
      yield* host.rename('Attic PC');
      expect(
        (yield* nearbyUntil(viewer, (list) => list.length > 0)).map((device) => device.name),
      ).toEqual(['Attic PC']);
      yield* host.setHosting(false);
      expect(yield* nearbyUntil(viewer, (list) => list.length === 0)).toEqual([]);
      expect(yield* lan.announced).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live('looks only while someone watches the nearby list', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const host = yield* makeTestDevice({ lan });
      const viewer = yield* makeTestDevice({ lan });
      yield* host.setHosting(true);
      yield* nearbyUntil(viewer, (list) => list.length > 0);
      // The nearby list was closed: the viewer stops browsing and, hosting off, closes its responder.
      expect(yield* lan.browsers).toBe(0);
      expect(yield* lan.responders).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live(
    'pairs with a nearby Device by its announced address; identity is still its certificate',
    () =>
      Effect.gen(function* () {
        const lan = yield* makeFakeLan;
        const host = yield* makeTestDevice({ lan });
        const viewer = yield* makeTestDevice({ lan });
        yield* host.rename('Studio PC');
        yield* host.setHosting(true);
        const [nearby] = yield* nearbyUntil(viewer, (list) => list.length > 0);
        if (nearby === undefined) return yield* Effect.die('nothing nearby');
        const window = yield* host.startPairing;
        if (window._tag !== 'Open') return yield* Effect.die('no pairing code');

        const paired = yield* viewer.pair(nearby.address, window.code);
        expect(paired).toMatchObject({ id: nearby.id, name: 'Studio PC' });
        expect(yield* viewer.check(nearby.id)).toEqual({ _tag: 'Online', name: 'Studio PC' });
      }).pipe(Effect.scoped),
  );

  it.live('a Paired device seen at a new address is remembered there', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const host = yield* makeTestDevice({ lan });
      const viewer = yield* makeTestDevice({ lan });
      // The host learns no address for the viewer: the viewer does not host while pairing.
      yield* pairDevices(host, viewer);
      const viewerId = (yield* viewer.identity).id;
      expect((yield* host.paired)[0]?.address).toBeNull();

      yield* viewer.setHosting(true);
      const address = yield* viewer.address;
      yield* nearbyUntil(host, (list) => list.some((device) => device.id === viewerId));
      yield* stateUntil(host, (state) => state.paired[0]?.address === address);
      expect(yield* host.check(viewerId)).toMatchObject({ _tag: 'Online' });
    }).pipe(Effect.scoped),
  );

  it.live(
    'looks for a Paired device found Offline, and tries it again as soon as it announces itself',
    () =>
      Effect.gen(function* () {
        const lan = yield* makeFakeLan;
        const host = yield* makeTestDevice({ lan });
        const viewer = yield* makeTestDevice({ lan });
        yield* pairDevices(host, viewer);
        const hostId = (yield* host.identity).id;
        yield* host.setHosting(false);
        expect(yield* viewer.check(hostId)).toEqual({ _tag: 'Offline' });
        // Nobody has Settings > Devices open: the viewer looks only because its Paired device is Offline.
        yield* untilBrowsers(lan, (count) => count === 1);

        // Back on another port: the viewer follows the announcement and reaches it there, then stops looking.
        yield* host.setHosting(true);
        const address = yield* host.address;
        yield* stateUntil(viewer, (state) => state.paired[0]?.address === address);
        yield* untilBrowsers(lan, (count) => count === 0);
      }).pipe(Effect.scoped),
  );

  it.live('a network change destroys the responder and announces again on the new one', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      const host = yield* makeTestDevice({ lan });
      const viewer = yield* makeTestDevice({ lan });
      yield* host.setHosting(true);
      const { id } = yield* host.identity;
      yield* lan.changeNetwork;
      expect(yield* lan.responders).toBe(1);
      expect((yield* lan.announced).map((announcement) => announcement.id)).toEqual([id]);
      expect(
        (yield* nearbyUntil(viewer, (list) => list.length > 0)).map((device) => device.id),
      ).toEqual([id]);
    }).pipe(Effect.scoped),
  );

  it.live('shutting down withdraws the announcement and destroys the responder', () =>
    Effect.gen(function* () {
      const lan = yield* makeFakeLan;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeTestDevice({ lan });
          yield* host.setHosting(true);
          expect(yield* lan.responders).toBe(1);
        }),
      );
      expect(yield* lan.announced).toEqual([]);
      expect(yield* lan.responders).toBe(0);
    }).pipe(Effect.scoped),
  );
});
