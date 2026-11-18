import { Context, Effect, Layer, Option, Semaphore } from 'effect';
import type { DevicesError, LocalDevice } from '../../src/shared/devices/devices.rpc';
import { DeviceIdentity, type LocalDeviceRecord } from '../devices/identity';
import { type DeviceTrust } from '../devices/trust';
import { type LanConfig, openListener, type RemoteHandlers } from './server';

export interface HostingShape {
  /** The Local device with whether it hosts and, while it does, its port. */
  readonly local: Effect.Effect<LocalDevice>;
  /**
   * Turns hosting on (opens the listener, then stores the choice) or off (closes it and every connection). Turning
   * it on when no port is free fails with `ListenFailed` and leaves hosting off.
   */
  readonly set: (on: boolean) => Effect.Effect<LocalDevice, DevicesError>;
}

/** Whether other Devices may connect. Off means no listener at all; on serves `RemoteRpcs`. */
export class Hosting extends Context.Service<Hosting, HostingShape>()('lan/Hosting') {}

interface Open {
  readonly port: number;
  readonly close: Effect.Effect<void>;
}

const view = (record: LocalDeviceRecord, open: Option.Option<Open>): LocalDevice => ({
  id: record.id,
  name: record.name,
  hosting: Option.isSome(open),
  port: Option.match(open, { onNone: () => null, onSome: ({ port }) => port }),
});

/**
 * Hosting over the Local device's identity. The listener is served by the handlers in context, so the Remote
 * group runs on the same instances as the local window. A Device that hosted when it quit hosts again on start.
 */
export const layerHosting: Layer.Layer<
  Hosting,
  never,
  DeviceIdentity | DeviceTrust | LanConfig | RemoteHandlers
> = Layer.effect(
  Hosting,
  Effect.gen(function* () {
    const identity = yield* DeviceIdentity;
    const services = yield* Effect.context<DeviceTrust | LanConfig | RemoteHandlers>();
    const lock = yield* Semaphore.make(1);
    let open: Option.Option<Open> = Option.none();

    const start = Effect.gen(function* () {
      if (Option.isSome(open)) return;
      const record = yield* identity.get;
      const opened = yield* openListener(record).pipe(Effect.provide(services));
      open = Option.some(opened);
    });

    const stop = Effect.gen(function* () {
      if (Option.isNone(open)) return;
      const current = open.value;
      open = Option.none();
      yield* current.close;
    });

    const local = Effect.map(identity.get, (record) => view(record, open));

    yield* Effect.addFinalizer(() => lock.withPermit(stop));

    // A Device that hosted when it quit hosts again. A busy port (or a broken device.json) must not fail the app:
    // hosting then stays off until the user turns it on again.
    yield* lock
      .withPermit(
        Effect.gen(function* () {
          const record = yield* identity.get;
          if (record.hosting) yield* start;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('Hosting could not resume; it stays off for now.', cause),
        ),
      );

    return {
      local: lock.withPermit(local),
      set: (on) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (on) yield* start;
            else yield* stop;
            const record = yield* identity.setHosting(on);
            return view(record, open);
          }),
        ),
    };
  }),
);
