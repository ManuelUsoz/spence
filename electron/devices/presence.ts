import { Context, Effect, Exit, Layer, Option, PubSub, Scope, Semaphore, Stream } from 'effect';
import type {
  DeviceId,
  NearbyDevice,
  PairedDeviceStatus,
} from '../../src/shared/devices/devices.rpc';
import { Discovery } from '../lan/discovery';
import { PairedDevices } from './paired-devices';

export interface DevicePresenceShape {
  /** How a Paired device last answered. While one is `Offline`, discovery keeps looking for it. */
  readonly record: (id: DeviceId, status: PairedDeviceStatus) => Effect.Effect<void>;
  /**
   * A Paired device to try again at once: it announced itself again, or the network changed. The device
   * connections, the only thing that reaches Paired devices, subscribe.
   */
  readonly retries: Stream.Stream<DeviceId>;
}

/**
 * What discovery means for the Paired devices: one seen nearby is remembered at its announced address, and one that
 * was Offline is tried again at once when it announces itself again or the network changes. Browsing for them runs
 * only while at least one is known Offline.
 */
export class DevicePresence extends Context.Service<DevicePresence, DevicePresenceShape>()(
  'devices/DevicePresence',
) {}

export const layerDevicePresence: Layer.Layer<DevicePresence, never, Discovery | PairedDevices> =
  Layer.effect(
    DevicePresence,
    Effect.gen(function* () {
      const discovery = yield* Discovery;
      const paired = yield* PairedDevices;
      const lock = yield* Semaphore.make(1);
      const scope = yield* Effect.scope;
      const offline = new Set<DeviceId>();
      let browsing: Option.Option<Scope.Closeable> = Option.none();

      /** Browses exactly while some Paired device is known Offline. */
      const follow = Effect.gen(function* () {
        if (offline.size > 0 && Option.isNone(browsing)) {
          const held = yield* Scope.fork(scope);
          yield* Scope.provide(held)(discovery.browse);
          browsing = Option.some(held);
        } else if (offline.size === 0 && Option.isSome(browsing)) {
          const held = browsing.value;
          browsing = Option.none();
          yield* Scope.close(held, Exit.void);
        }
      });

      const retries = yield* PubSub.unbounded<DeviceId>();

      // A Paired device seen nearby: remember where it is now (a host that met a viewer only when the viewer did
      // not host has no address for it until then), then, if it was Offline, try it again there at once.
      yield* Effect.forkScoped(
        Stream.runForEach(
          discovery.sightings,
          Effect.fnUntraced(function* (device: NearbyDevice) {
            const known = (yield* paired.list).find((stored) => stored.id === device.id);
            if (known === undefined || known.unpairedByOther) return;
            yield* paired.located(device.id, device.address, device.name);
            if (offline.has(device.id)) yield* PubSub.publish(retries, device.id);
          }),
        ),
      );
      // New interfaces: whatever was Offline may be reachable now.
      yield* Effect.forkScoped(
        Stream.runForEach(discovery.networkChanges, () => PubSub.publishAll(retries, [...offline])),
      );
      // An unpaired Device is no longer looked for.
      yield* Effect.forkScoped(
        Stream.runForEach(paired.changes, (devices) =>
          lock.withPermit(
            Effect.suspend(() => {
              const ids = new Set(devices.map((device) => device.id));
              for (const id of offline) if (!ids.has(id)) offline.delete(id);
              return follow;
            }),
          ),
        ),
      );

      return {
        record: (id, status) =>
          lock.withPermit(
            Effect.suspend(() => {
              if (status._tag === 'Offline') offline.add(id);
              else offline.delete(id);
              return follow;
            }),
          ),
        retries: Stream.fromPubSub(retries),
      };
    }),
  );
