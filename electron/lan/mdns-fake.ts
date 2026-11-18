import { Effect, Layer, PubSub, Queue, Stream, SubscriptionRef } from 'effect';
import { Mdns, type Announcement, type MdnsResponder, type SightingEvent } from './mdns';

/**
 * An in-memory LAN for specs and e2e: every Device joined to it sees the others' announcements, as on one multicast
 * segment, without opening a socket. Announced addresses are loopback, so pairing from a sighting really connects.
 */
export interface FakeLan {
  /** The `Mdns` of one Device on this LAN. */
  readonly layer: Layer.Layer<Mdns>;
  /** Responders open now (each is a bound socket on a real LAN). */
  readonly responders: Effect.Effect<number>;
  /** Browsers running now. */
  readonly browsers: Effect.Effect<number>;
  /** How many browsers run, now and on every change. */
  readonly browsing: Stream.Stream<number>;
  /** What is announced now. */
  readonly announced: Effect.Effect<ReadonlyArray<Announcement>>;
  /** The network interfaces change for every Device on this LAN. */
  readonly changeNetwork: Effect.Effect<void>;
}

const up = (announcement: Announcement): SightingEvent => ({
  _tag: 'Up',
  device: {
    id: announcement.id,
    name: announcement.name,
    address: `127.0.0.1:${announcement.port}`,
    protocolVersion: announcement.protocolVersion,
  },
});

export const makeFakeLan = Effect.gen(function* () {
  const announcements = new Set<{ readonly current: Announcement }>();
  const listeners = new Set<(event: SightingEvent) => void>();
  let responders = 0;
  const browserCount = yield* SubscriptionRef.make(0);
  const network = yield* PubSub.unbounded<void>();
  const emit = (event: SightingEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const open = Effect.acquireRelease(
    Effect.sync(() => {
      responders += 1;
    }),
    () =>
      Effect.sync(() => {
        responders -= 1;
      }),
  ).pipe(
    Effect.as<MdnsResponder>({
      announce: (announcement) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const entry = { current: announcement };
            announcements.add(entry);
            emit(up(announcement));
            return entry;
          }),
          (entry) =>
            Effect.sync(() => {
              announcements.delete(entry);
              emit({ _tag: 'Down', id: entry.current.id });
            }),
        ).pipe(Effect.asVoid),
      browse: Stream.callback<SightingEvent>((queue) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const listener = (event: SightingEvent) => {
              Queue.offerUnsafe(queue, event);
            };
            listeners.add(listener);
            for (const entry of announcements) listener(up(entry.current));
            yield* SubscriptionRef.set(browserCount, listeners.size);
            return listener;
          }),
          (listener) =>
            Effect.suspend(() => {
              listeners.delete(listener);
              return SubscriptionRef.set(browserCount, listeners.size);
            }),
        ),
      ),
    }),
  );

  const lan: FakeLan = {
    layer: Layer.succeed(Mdns, { open, networkChanges: Stream.fromPubSub(network) }),
    responders: Effect.sync(() => responders),
    browsers: Effect.sync(() => listeners.size),
    browsing: SubscriptionRef.changes(browserCount),
    announced: Effect.sync(() => [...announcements].map((entry) => entry.current)),
    changeNetwork: PubSub.publish(network, undefined),
  };
  return lan;
});

/** No LAN at all: nothing is announced or seen (e2e, which pairs by typed address only). */
export const layerMdnsNone = Layer.succeed(Mdns, {
  open: Effect.succeed<MdnsResponder>({
    announce: () => Effect.void,
    browse: Stream.never,
  }),
  networkChanges: Stream.never,
});
