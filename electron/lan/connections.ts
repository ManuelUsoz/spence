import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { RpcClient, RpcClientError } from 'effect/rpc';
import type {
  ConnectionStatus,
  DeviceConnection,
  DeviceId,
  DevicesError,
} from '../../src/shared/devices/devices.rpc';
import type { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { DeviceIdentity } from '../devices/identity';
import { PairedDevices } from '../devices/paired-devices';
import { endpointOf, statusOfRefusal } from '../devices/pairing';
import { connectRemote, probe } from './client';
import { LanConfig } from './config';

/** A live RPC client for one Remote device's `RemoteRpcs`. */
export type RemoteClient = RpcClient.FromGroup<typeof RemoteRpcs, RpcClientError.RpcClientError>;

/** How long a Remote device may take to answer `Remote.hello` before it counts as offline. */
const HELLO_TIMEOUT = '5 seconds';

/** A Device-scoped call named a Device this Device has no live connection to. */
export class DeviceUnavailable extends Schema.TaggedError<DeviceUnavailable>()(
  'DeviceUnavailable',
  {
    /** `NotConnected`: paired but not Online now (offline, refused, needs update, or still connecting). */
    reason: Schema.Literals(['NotConnected']),
    detail: Schema.String,
  },
) {}

export interface DeviceConnectionsShape {
  /** Every Paired device with its connection now. */
  readonly list: Effect.Effect<ReadonlyArray<DeviceConnection>>;
  /** Every Paired device with its connection now, then again on every change. */
  readonly changes: Stream.Stream<ReadonlyArray<DeviceConnection>>;
  /** Reaches a Paired device now, replacing any connection it had (Retry). */
  readonly connect: (id: DeviceId) => Effect.Effect<void, DevicesError>;
  /** The live client of an Online Remote device. */
  readonly client: (id: DeviceId) => Effect.Effect<RemoteClient, DeviceUnavailable>;
}

/**
 * The outbound side of the LAN: one RPC client per connected Remote device, pinned to its certificate, presenting
 * this Device's credentials. Every Paired device is reached when the app starts and when it is paired; an unpaired
 * Device's client closes at once (and a re-paired one reconnects with the new credentials).
 */
export class DeviceConnections extends Context.Service<DeviceConnections, DeviceConnectionsShape>()(
  'lan/DeviceConnections',
) {}

interface Entry {
  readonly status: ConnectionStatus;
  readonly client: Option.Option<RemoteClient>;
  readonly scope: Option.Option<Scope.Closeable>;
}

const offline: ConnectionStatus = { _tag: 'Offline' };

export const layerDeviceConnections: Layer.Layer<
  DeviceConnections,
  never,
  PairedDevices | DeviceIdentity | LanConfig
> = Layer.effect(
  DeviceConnections,
  Effect.gen(function* () {
    const paired = yield* PairedDevices;
    const { protocolVersion } = yield* LanConfig;
    const services = yield* Effect.context<PairedDevices | DeviceIdentity | LanConfig>();
    const layerScope = yield* Effect.scope;
    const entries = yield* SubscriptionRef.make<ReadonlyMap<DeviceId, Entry>>(new Map());
    const locks = new Map<DeviceId, Semaphore.Semaphore>();
    /** Devices a connection was started for, so a name change never starts another. */
    const known = new Set<DeviceId>();

    const lockOf = (id: DeviceId): Semaphore.Semaphore => {
      const existing = locks.get(id);
      if (existing !== undefined) return existing;
      const made = Semaphore.makeUnsafe(1);
      locks.set(id, made);
      return made;
    };

    const put = (id: DeviceId, entry: Entry) =>
      SubscriptionRef.update(entries, (current) => new Map(current).set(id, entry));

    /** Closes a Device's client, if any; `status` replaces its entry, none removes it. */
    const close = Effect.fnUntraced(function* (
      id: DeviceId,
      status: Option.Option<ConnectionStatus>,
    ) {
      const entry = (yield* SubscriptionRef.get(entries)).get(id);
      if (entry !== undefined && Option.isSome(entry.scope)) {
        yield* Scope.close(entry.scope.value, Exit.void);
      }
      yield* SubscriptionRef.update(entries, (current) => {
        const next = new Map(current);
        if (Option.isSome(status)) {
          next.set(id, { status: status.value, client: Option.none(), scope: Option.none() });
        } else next.delete(id);
        return next;
      });
    });

    const reach = Effect.fnUntraced(function* (id: DeviceId) {
      yield* close(id, Option.some({ _tag: 'Connecting' }));
      const endpoint = yield* endpointOf(id).pipe(Effect.provide(services));
      if (Option.isNone(endpoint)) return yield* close(id, Option.some(offline));

      const refused = yield* Effect.flip(probe(endpoint.value)).pipe(Effect.option);
      if (Option.isSome(refused)) {
        const status = statusOfRefusal(refused.value, protocolVersion);
        if (status._tag === 'UnpairedByOther') yield* paired.markUnpairedByOther(id);
        return yield* close(id, Option.some(status));
      }

      const scope = yield* Scope.make();
      const client = yield* connectRemote(endpoint.value).pipe(Scope.provide(scope));
      const hello = yield* client['Remote.hello']().pipe(
        Effect.timeout(HELLO_TIMEOUT),
        Effect.option,
      );
      if (Option.isNone(hello)) {
        yield* Scope.close(scope, Exit.void);
        return yield* close(id, Option.some(offline));
      }
      yield* paired.seen(id, hello.value.name);
      yield* put(id, {
        status: { _tag: 'Online', name: hello.value.name },
        client: Option.some(client),
        scope: Option.some(scope),
      });
    });

    const connect = (id: DeviceId) => {
      known.add(id);
      return lockOf(id).withPermit(reach(id));
    };

    /** Starts a connection in the background, for the life of the service. */
    const start = (id: DeviceId) =>
      connect(id).pipe(
        Effect.catchTag('DevicesError', () => close(id, Option.none())),
        Effect.forkIn(layerScope),
        Effect.asVoid,
      );

    const forget = (id: DeviceId) => {
      known.delete(id);
      return lockOf(id).withPermit(close(id, Option.none()));
    };

    // Reach every Paired device once; let go of the ones no longer paired.
    yield* paired.changes.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (devices) {
          const ids = new Set(devices.map((device) => device.id));
          for (const device of devices) {
            if (!known.has(device.id) && !device.unpairedByOther) {
              known.add(device.id);
              yield* start(device.id);
            }
          }
          for (const id of [...known]) if (!ids.has(id)) yield* forget(id);
        }),
      ),
      Effect.forkIn(layerScope),
    );

    // Credentials that stopped being valid close their client; a fresh Pairing reaches the Device again.
    yield* paired.revocations.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (id) {
          yield* lockOf(id).withPermit(close(id, Option.none()));
          const still = (yield* paired.list).find((device) => device.id === id);
          if (still === undefined) known.delete(id);
          else if (!still.unpairedByOther) yield* start(id);
        }),
      ),
      Effect.forkIn(layerScope),
    );

    yield* Effect.addFinalizer(() =>
      Effect.flatMap(SubscriptionRef.get(entries), (current) =>
        Effect.forEach(
          current.values(),
          (entry) =>
            Option.isSome(entry.scope) ? Scope.close(entry.scope.value, Exit.void) : Effect.void,
          { discard: true },
        ),
      ),
    );

    const view = (
      devices: ReadonlyArray<{
        readonly id: DeviceId;
        readonly name: string;
        readonly unpairedByOther: boolean;
      }>,
      current: ReadonlyMap<DeviceId, Entry>,
    ): ReadonlyArray<DeviceConnection> =>
      devices.map((device) => ({
        id: device.id,
        name: device.name,
        status: device.unpairedByOther
          ? { _tag: 'UnpairedByOther' }
          : (current.get(device.id)?.status ?? offline),
      }));

    return {
      list: Effect.zipWith(paired.list, SubscriptionRef.get(entries), view),
      changes: Stream.zipLatest(paired.changes, SubscriptionRef.changes(entries)).pipe(
        Stream.map(([devices, current]) => view(devices, current)),
      ),
      connect,
      client: (id) =>
        Effect.flatMap(SubscriptionRef.get(entries), (current) => {
          const client = current.get(id)?.client ?? Option.none();
          return Option.isSome(client)
            ? Effect.succeed(client.value)
            : Effect.fail(
                new DeviceUnavailable({
                  reason: 'NotConnected',
                  detail: `Device ${id} is not connected.`,
                }),
              );
        }),
    };
  }),
);
