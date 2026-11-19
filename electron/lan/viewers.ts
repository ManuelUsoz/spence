import { Context, Effect, Layer, Stream, SubscriptionRef } from 'effect';
import type { ConnectedViewer, DeviceId } from '../../src/shared/devices/devices.rpc';
import { PairedDevices } from '../devices/paired-devices';

/** One live connection a Remote device holds to this Device's listener. */
export interface ViewerConnection {
  /** Closes it at once. */
  readonly terminate: () => void;
}

export interface ViewersShape {
  /** An authorized connection of `id` is open (the listener calls it). */
  readonly attach: (id: DeviceId, connection: ViewerConnection) => Effect.Effect<void>;
  /** That connection closed. */
  readonly detach: (id: DeviceId, connection: ViewerConnection) => Effect.Effect<void>;
  /** The Remote devices connected now, in the order they connected; then again on every change. */
  readonly changes: Stream.Stream<ReadonlyArray<DeviceId>>;
  /** How many Remote devices are connected now. */
  readonly count: Effect.Effect<number>;
  /** Closes every connection of `id`. It stays paired, so it may reach this Device again. */
  readonly disconnect: (id: DeviceId) => Effect.Effect<void>;
}

/**
 * The Remote devices connected to this Device while it hosts (its viewers): what Settings > Devices lists with
 * Disconnect, what the tray counts and what the quit confirm states. Hosting off closes the listener and so every
 * connection; an unpaired Device's connections are closed by the listener.
 */
export class Viewers extends Context.Service<Viewers, ViewersShape>()('lan/Viewers') {}

type Live = ReadonlyMap<DeviceId, ReadonlySet<ViewerConnection>>;

export const layerViewers: Layer.Layer<Viewers> = Layer.effect(
  Viewers,
  Effect.gen(function* () {
    const live = yield* SubscriptionRef.make<Live>(new Map());

    const change = (id: DeviceId, edit: (set: Set<ViewerConnection>) => void) =>
      SubscriptionRef.update(live, (current) => {
        const next = new Map(current);
        const set = new Set(current.get(id));
        edit(set);
        if (set.size === 0) next.delete(id);
        else next.set(id, set);
        return next;
      });

    return {
      attach: (id, connection) => change(id, (set) => set.add(connection)),
      detach: (id, connection) => change(id, (set) => set.delete(connection)),
      changes: SubscriptionRef.changes(live).pipe(
        Stream.map((current) => [...current.keys()]),
        Stream.changesWith(
          (a, b) => a.length === b.length && a.every((id, index) => id === b[index]),
        ),
      ),
      count: Effect.map(SubscriptionRef.get(live), (current) => current.size),
      disconnect: Effect.fnUntraced(function* (id: DeviceId) {
        const connections = (yield* SubscriptionRef.get(live)).get(id) ?? new Set();
        yield* change(id, (set) => set.clear());
        for (const connection of connections) connection.terminate();
      }),
    };
  }),
);

/** The connected viewers with the names they paired under, now and on every change: Settings > Devices. */
export const viewersState: Stream.Stream<
  ReadonlyArray<ConnectedViewer>,
  never,
  Viewers | PairedDevices
> = Stream.unwrap(
  Effect.gen(function* () {
    const viewers = yield* Viewers;
    const paired = yield* PairedDevices;
    return Stream.zipLatest(viewers.changes, paired.changes).pipe(
      Stream.map(([ids, devices]) =>
        ids.flatMap((id) => {
          const device = devices.find((candidate) => candidate.id === id);
          return device === undefined ? [] : [{ id, name: device.name }];
        }),
      ),
    );
  }),
);
