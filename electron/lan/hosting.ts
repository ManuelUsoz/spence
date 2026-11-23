import { Context, Effect, Layer, Option, Semaphore, Stream, SubscriptionRef } from 'effect';
import {
  DevicesError,
  type LocalDevice,
  type PairingWindow,
} from '../../src/shared/devices/devices.rpc';
import { DeviceIdentity, type LocalDeviceRecord } from '../devices/identity';
import { PairingHost } from '../devices/pairing-host';
import { type DeviceTrust } from '../devices/trust';
import { LanConfig } from './config';
import { Discovery } from './discovery';
import { PowerEvents } from './power';
import { openListener, type RemoteHandlers } from './server';
import { type Viewers } from './viewers';

export interface HostingShape {
  /** The Local device with whether it hosts and, while it does, its port. */
  readonly local: Effect.Effect<LocalDevice>;
  /**
   * Turns hosting on (opens the listener, then stores the choice) or off (closes it and every connection). Turning
   * it on when no port is free fails with `ListenFailed` and leaves hosting off.
   */
  readonly set: (on: boolean) => Effect.Effect<LocalDevice, DevicesError>;
  /** Whether the listener is open now, then again on every change (hosting on or off, a failed rebind). */
  readonly serving: Stream.Stream<boolean>;
  /** Changes the display name; while hosting, the announcement nearby follows it. */
  readonly rename: (name: string) => Effect.Effect<LocalDevice, DevicesError>;
  /** Shows a fresh pairing code; only while hosting (`NotHosting` otherwise). Turning hosting off closes it. */
  readonly startPairing: Effect.Effect<PairingWindow, DevicesError>;
}

/**
 * Whether other Devices may connect. Off means no listener and no announcement at all; on serves `RemoteRpcs` and
 * announces this Device nearby (id, display name and protocol version only).
 */
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
  | DeviceIdentity
  | DeviceTrust
  | Discovery
  | LanConfig
  | PairingHost
  | PowerEvents
  | RemoteHandlers
  | Viewers
> = Layer.effect(
  Hosting,
  Effect.gen(function* () {
    const identity = yield* DeviceIdentity;
    const pairing = yield* PairingHost;
    const discovery = yield* Discovery;
    const { protocolVersion } = yield* LanConfig;
    const services = yield* Effect.context<
      DeviceTrust | LanConfig | PairingHost | RemoteHandlers | Viewers
    >();
    const lock = yield* Semaphore.make(1);
    let open: Option.Option<Open> = Option.none();
    let lastPort: number | undefined;
    const servingNow = yield* SubscriptionRef.make(false);

    /** Tells discovery (and `serving`) whether and where this Device listens now. */
    const announce = Effect.gen(function* () {
      yield* SubscriptionRef.set(servingNow, Option.isSome(open));
      if (Option.isNone(open)) return yield* discovery.announce(Option.none());
      const record = yield* identity.get;
      yield* discovery.announce(
        Option.some({
          id: record.id,
          name: record.name,
          port: open.value.port,
          protocolVersion,
        }),
      );
    });

    const start = Effect.gen(function* () {
      if (Option.isSome(open)) return;
      const record = yield* identity.get;
      const opened = yield* openListener(record, lastPort).pipe(Effect.provide(services));
      open = Option.some(opened);
      lastPort = opened.port;
      yield* announce;
    });

    /**
     * After the computer woke up: the listener is opened again (on the same port when it is free), discovery starts
     * over on the interfaces there are now and announces it. Viewers whose connection did not survive reconnect.
     */
    const rebind = Effect.gen(function* () {
      if (Option.isNone(open)) return;
      const { port, close } = open.value;
      open = Option.none();
      yield* close;
      const record = yield* identity.get;
      const reopened = yield* openListener(record, port).pipe(Effect.provide(services));
      open = Option.some(reopened);
      lastPort = reopened.port;
      yield* discovery.restart;
      yield* announce;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.andThen(
          Effect.logWarning(
            'Hosting could not listen again after waking up; it is off for now.',
            cause,
          ),
          announce,
        ),
      ),
    );

    const stop = Effect.gen(function* () {
      if (Option.isNone(open)) return;
      const current = open.value;
      open = Option.none();
      yield* announce;
      yield* pairing.close;
      yield* current.close;
    });

    const local = Effect.map(identity.get, (record) => view(record, open));

    yield* Effect.addFinalizer(() => lock.withPermit(stop));

    const power = yield* PowerEvents;
    yield* power.resumes.pipe(
      Stream.runForEach(() => lock.withPermit(rebind)),
      Effect.forkScoped,
    );

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
      serving: SubscriptionRef.changes(servingNow),
      set: (on) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (on) yield* start;
            else yield* stop;
            const record = yield* identity.setHosting(on);
            return view(record, open);
          }),
        ),
      rename: (name) =>
        lock.withPermit(
          Effect.gen(function* () {
            const record = yield* identity.rename(name);
            yield* announce;
            return view(record, open);
          }),
        ),
      startPairing: lock.withPermit(
        Effect.suspend(() =>
          Option.isSome(open)
            ? pairing.open
            : Effect.fail(
                new DevicesError({
                  reason: 'NotHosting',
                  detail: 'Turn hosting on to show a pairing code.',
                }),
              ),
        ),
      ),
    };
  }),
);
