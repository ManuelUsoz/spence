/**
 * Discovery over real multicast on this machine's network: two in-process Devices find each other through
 * `bonjour-service`. Opt-in (`SPENCE_LAN_LIVE=1`): `npm run verify` never opens a multicast socket.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Fiber, Option, Stream } from 'effect';
import { makeTestDevice } from '../devices/test-peer';
import { layerMdnsLive } from './mdns-bonjour';

describe.runIf(process.env['SPENCE_LAN_LIVE'] === '1')('Nearby Device discovery (live LAN)', () => {
  it.live(
    'a hosting Device is found over mDNS and withdrawn when hosting turns off',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice({ mdns: layerMdnsLive });
        const viewer = yield* makeTestDevice({ mdns: layerMdnsLive });
        yield* host.rename('Live host');
        yield* host.setHosting(true);
        const { id } = yield* host.identity;
        const { port } = yield* host.local;

        const found = yield* viewer.nearby.pipe(
          Stream.map((list) => list.find((device) => device.id === id)),
          Stream.filter((device) => device !== undefined),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout('20 seconds'),
        );
        expect(found).toMatchObject({ id, name: 'Live host' });
        expect(found.address.endsWith(`:${port}`)).toBe(true);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const watching = yield* viewer.nearby.pipe(
              Stream.filter((list) => !list.some((device) => device.id === id)),
              Stream.runHead,
              Effect.timeout('20 seconds'),
              Effect.forkScoped,
            );
            yield* host.setHosting(false);
            yield* Fiber.join(watching);
          }),
        );
      }).pipe(Effect.scoped),
    60_000,
  );
});
