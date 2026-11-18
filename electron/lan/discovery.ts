import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { DeviceId, NearbyDevice } from '../../src/shared/devices/devices.rpc';
import { DeviceIdentity } from '../devices/identity';
import { type Announcement, Mdns, type MdnsResponder, type SightingEvent } from './mdns';

export interface DiscoveryShape {
  /** What this Device announces; `none` withdraws it. Hosting sets it: hosting off announces nothing. */
  readonly announce: (announcement: Option.Option<Announcement>) => Effect.Effect<void>;
  /** The Devices announcing nearby (never this one), now and on every change; browses while it runs. */
  readonly nearby: Stream.Stream<ReadonlyArray<NearbyDevice>>;
  /** Keeps browsing for the scope, for a reason other than someone watching `nearby`. */
  readonly browse: Effect.Effect<void, never, Scope.Scope>;
  /** Every announcement of another Device seen while browsing, re-announcements included. */
  readonly sightings: Stream.Stream<NearbyDevice>;
  /** The network interfaces changed (discovery has already started over on the new ones). */
  readonly networkChanges: Stream.Stream<void>;
}

/**
 * Nearby Device discovery over mDNS. A responder exists only while something is announced or someone browses, so a
 * Device that does not host and is not looking opens no socket. A network change destroys the responder and opens a
 * new one, announcing and browsing again as before.
 */
export class Discovery extends Context.Service<Discovery, DiscoveryShape>()('lan/Discovery') {}

interface Live {
  readonly scope: Scope.Closeable;
  readonly responder: MdnsResponder;
  announced: Option.Option<{
    readonly announcement: Announcement;
    readonly scope: Scope.Closeable;
  }>;
  browsing: Option.Option<Scope.Closeable>;
}

const sameAnnouncement = (a: Announcement, b: Announcement): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.port === b.port &&
  a.protocolVersion === b.protocolVersion;

export const layerDiscovery: Layer.Layer<Discovery, never, Mdns | DeviceIdentity> = Layer.effect(
  Discovery,
  Effect.gen(function* () {
    const mdns = yield* Mdns;
    const identity = yield* DeviceIdentity;
    const lock = yield* Semaphore.make(1);
    const seen = yield* SubscriptionRef.make<ReadonlyMap<DeviceId, NearbyDevice>>(new Map());
    const sightings = yield* PubSub.unbounded<NearbyDevice>();
    const changes = yield* PubSub.unbounded<void>();
    let wanted: Option.Option<Announcement> = Option.none();
    let demand = 0;
    let live: Option.Option<Live> = Option.none();

    const closeScope = (scope: Scope.Closeable) => Scope.close(scope, Exit.void);

    const apply = Effect.fnUntraced(function* (event: SightingEvent) {
      const self = (yield* identity.get).id;
      switch (event._tag) {
        case 'Up': {
          if (event.device.id === self) return;
          // Published before the list changes: a watcher of the list may stop browsing as soon as it sees it.
          yield* PubSub.publish(sightings, event.device);
          yield* SubscriptionRef.update(seen, (current) =>
            new Map(current).set(event.device.id, event.device),
          );
          return;
        }
        case 'Down':
          yield* SubscriptionRef.update(seen, (current) => {
            const next = new Map(current);
            next.delete(event.id);
            return next;
          });
      }
    });

    const forget = SubscriptionRef.set(seen, new Map());

    const teardown = Effect.gen(function* () {
      if (Option.isNone(live)) return;
      const current = live.value;
      live = Option.none();
      yield* closeScope(current.scope);
      yield* forget;
    });

    const openResponder = Effect.gen(function* () {
      const scope = yield* Scope.make();
      const responder = yield* Scope.provide(scope)(mdns.open);
      const opened: Live = {
        scope,
        responder,
        announced: Option.none(),
        browsing: Option.none(),
      };
      live = Option.some(opened);
      return opened;
    });

    /** Brings the responder, its announcement and its browser in line with what is wanted now. */
    const reconcile = Effect.gen(function* () {
      if (Option.isNone(wanted) && demand === 0) return yield* teardown;
      const current: Live = yield* Option.match(live, {
        onSome: Effect.succeed,
        onNone: () => openResponder,
      });

      const announced = current.announced;
      const unchanged =
        Option.isSome(announced) &&
        Option.isSome(wanted) &&
        sameAnnouncement(announced.value.announcement, wanted.value);
      if (!unchanged) {
        if (Option.isSome(announced)) {
          current.announced = Option.none();
          yield* closeScope(announced.value.scope);
        }
        if (Option.isSome(wanted)) {
          const scope = yield* Scope.fork(current.scope);
          yield* Scope.provide(scope)(current.responder.announce(wanted.value));
          current.announced = Option.some({ announcement: wanted.value, scope });
        }
      }

      if (demand > 0 && Option.isNone(current.browsing)) {
        const scope = yield* Scope.fork(current.scope);
        yield* Effect.forkIn(Stream.runForEach(current.responder.browse, apply), scope);
        current.browsing = Option.some(scope);
      } else if (demand === 0 && Option.isSome(current.browsing)) {
        const scope = current.browsing.value;
        current.browsing = Option.none();
        yield* closeScope(scope);
        yield* forget;
      }
    });

    const browse = Effect.acquireRelease(
      lock.withPermit(
        Effect.suspend(() => {
          demand += 1;
          return reconcile;
        }),
      ),
      () =>
        lock.withPermit(
          Effect.suspend(() => {
            demand -= 1;
            return reconcile;
          }),
        ),
    );

    // A network change: start over on the new interfaces, as if the responder had never been opened.
    yield* Effect.forkScoped(
      Stream.runForEach(mdns.networkChanges, () =>
        Effect.andThen(
          lock.withPermit(Effect.andThen(teardown, reconcile)),
          PubSub.publish(changes, undefined),
        ),
      ),
    );
    yield* Effect.addFinalizer(() => lock.withPermit(teardown));

    return {
      announce: (announcement) =>
        lock.withPermit(
          Effect.suspend(() => {
            wanted = announcement;
            return reconcile;
          }),
        ),
      nearby: Stream.unwrap(
        Effect.as(
          browse,
          Stream.map(SubscriptionRef.changes(seen), (current) => [...current.values()]),
        ),
      ),
      browse,
      sightings: Stream.fromPubSub(sightings),
      networkChanges: Stream.fromPubSub(changes),
    };
  }),
);
