import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import type { RpcClient, RpcClientError } from 'effect/rpc';
import {
  type ConnectionStatus,
  type DeviceConnection,
  type DeviceId,
  DevicesError,
} from '../../src/shared/devices/devices.rpc';
import type { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { DeviceIdentity } from '../devices/identity';
import { PairedDevices } from '../devices/paired-devices';
import { endpointOf, statusOfRefusal } from '../devices/pairing';
import { DevicePresence } from '../devices/presence';
import { connectRemote, probe } from './client';
import { LanConfig } from './config';
import { PowerEvents } from './power';
import { reconnectSchedule } from './reconnect';

/** A live RPC client for one Remote device's `RemoteRpcs`. */
export type RemoteClient = RpcClient.FromGroup<typeof RemoteRpcs, RpcClientError.RpcClientError>;

/** How long a Remote device may take to answer `Remote.hello` before it counts as offline. */
const HELLO_TIMEOUT = '5 seconds';

/** A Device-scoped call named a Device this Device has no live connection to. */
export class DeviceUnavailable extends Schema.TaggedError<DeviceUnavailable>()(
  'DeviceUnavailable',
  {
    /**
     * `NotConnected`: paired but not Online now (offline, reconnecting, refused, needs update, or still connecting).
     * `NotPaired`: not a Paired device, or it refused this Device for good (unpaired by it, identity changed).
     */
    reason: Schema.Literals(['NotConnected', 'NotPaired']),
    detail: Schema.String,
  },
) {}

export interface DeviceConnectionsShape {
  /** Every Paired device with its connection now. */
  readonly list: Effect.Effect<ReadonlyArray<DeviceConnection>>;
  /** Every Paired device with its connection now, then again on every change. */
  readonly changes: Stream.Stream<ReadonlyArray<DeviceConnection>>;
  /** Reaches a Paired device now, replacing any connection it had (Retry); backoff starts over. */
  readonly connect: (id: DeviceId) => Effect.Effect<void, DevicesError>;
  /** The live client of an Online Remote device. */
  readonly client: (id: DeviceId) => Effect.Effect<RemoteClient, DeviceUnavailable>;
  /**
   * The live client of a Remote device as soon as it is Online, waiting while it is offline or reconnecting; never
   * `stale`, a client whose connection already failed. Fails once the Device is no longer one to wait for.
   */
  readonly awaitClient: (
    id: DeviceId,
    stale?: RemoteClient,
  ) => Effect.Effect<RemoteClient, DeviceUnavailable>;
}

/**
 * The outbound side of the LAN, and the only thing that reaches Paired devices: one RPC client per connected Remote
 * device, pinned to its certificate, presenting this Device's credentials. Every Paired device is reached when the
 * app starts and when it is paired. A Device that cannot be reached, or whose connection drops, is reached again
 * with backoff (`reconnectSchedule`) for as long as it stays paired, showing Reconnecting after a drop, then Offline.
 * Discovery seeing it again, a network change, the computer waking up or Retry reach it again at once. An unpaired
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

/** How a run of attempts starts: a first reach, or reaching again a Device that was connected. */
type Mode = 'Connecting' | 'Reconnecting';

const offline: ConnectionStatus = { _tag: 'Offline' };

/** Outcomes after which nothing is retried: connected, or refused for good. */
const isSettled = (status: ConnectionStatus): boolean =>
  status._tag === 'Online' ||
  status._tag === 'UnpairedByOther' ||
  status._tag === 'IdentityChanged';

/** An attempt that did not settle the Device: the backoff tries again. */
const UNSETTLED = 'Unsettled' as const;

export const layerDeviceConnections: Layer.Layer<
  DeviceConnections,
  never,
  PairedDevices | DevicePresence | DeviceIdentity | LanConfig | PowerEvents
> = Layer.effect(
  DeviceConnections,
  Effect.gen(function* () {
    const paired = yield* PairedDevices;
    const presence = yield* DevicePresence;
    const power = yield* PowerEvents;
    const { protocolVersion, reconnectingFor } = yield* LanConfig;
    const reconnectingMillis = Duration.toMillis(Duration.fromInputUnsafe(reconnectingFor));
    const services = yield* Effect.context<PairedDevices | DeviceIdentity | LanConfig>();
    const layerScope = yield* Effect.scope;
    const runFork = yield* FiberSet.makeRuntime<never, unknown, never>();
    const entries = yield* SubscriptionRef.make<ReadonlyMap<DeviceId, Entry>>(new Map());
    const locks = new Map<DeviceId, Semaphore.Semaphore>();
    /** The run of attempts reaching each Device, while one runs. */
    const loops = new Map<DeviceId, Fiber.Fiber<void>>();
    /** Devices a connection was started for, so a name change never starts another. */
    const known = new Set<DeviceId>();
    /** Devices that were Online during this run: reaching them again shows Reconnecting. */
    const everOnline = new Set<DeviceId>();

    const lockOf = (id: DeviceId): Semaphore.Semaphore => {
      const existing = locks.get(id);
      if (existing !== undefined) return existing;
      const made = Semaphore.makeUnsafe(1);
      locks.set(id, made);
      return made;
    };

    const entryOf = (id: DeviceId) =>
      Effect.map(SubscriptionRef.get(entries), (current) => current.get(id));

    const put = (id: DeviceId, entry: Entry) =>
      SubscriptionRef.update(entries, (current) => new Map(current).set(id, entry));

    /** Closes a Device's client, if any; `status` replaces its entry, none removes it. */
    const close = Effect.fnUntraced(function* (
      id: DeviceId,
      status: Option.Option<ConnectionStatus>,
    ) {
      const entry = yield* entryOf(id);
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

    /**
     * One try at reaching a Device, replacing its client. `pending` is what it shows meanwhile (none keeps what it
     * shows now). An unreachable Device shows Reconnecting until `reconnectingUntil`, Offline after.
     */
    const reach = Effect.fnUntraced(function* (
      id: DeviceId,
      pending: Option.Option<ConnectionStatus>,
      reconnectingUntil: number,
    ) {
      const shown = (yield* entryOf(id))?.status ?? offline;
      yield* close(id, Option.some(Option.getOrElse(pending, () => shown)));
      const unreachable = Effect.map(Clock.currentTimeMillis, (now): ConnectionStatus =>
        now < reconnectingUntil ? { _tag: 'Reconnecting' } : offline,
      );
      const settle = (status: ConnectionStatus) =>
        Effect.as(close(id, Option.some(status)), status);

      const endpoint = yield* endpointOf(id).pipe(Effect.provide(services));
      if (Option.isNone(endpoint)) return yield* Effect.flatMap(unreachable, settle);

      const refused = yield* Effect.flip(probe(endpoint.value)).pipe(Effect.option);
      if (Option.isSome(refused)) {
        const status = statusOfRefusal(refused.value, protocolVersion);
        if (status._tag === 'UnpairedByOther') yield* paired.markUnpairedByOther(id);
        return yield* settle(status._tag === 'Offline' ? yield* unreachable : status);
      }

      const scope = yield* Scope.make();
      return yield* Effect.gen(function* () {
        // The client would reconnect forever on its own, refused or not: a dropped connection is reached again
        // here instead, so a refusal (unpaired, identity changed, needs update) shows and the backoff is ours.
        let dropped = false;
        const onClose = () => {
          if (dropped) return;
          dropped = true;
          runFork(reachAgainAfterDrop(id, scope));
        };
        const client = yield* connectRemote(endpoint.value, { onClose }).pipe(Scope.provide(scope));
        const hello = yield* client['Remote.hello']().pipe(
          Effect.timeout(HELLO_TIMEOUT),
          Effect.option,
        );
        if (Option.isNone(hello)) {
          yield* Scope.close(scope, Exit.void);
          return yield* Effect.flatMap(unreachable, settle);
        }
        yield* paired.seen(id, hello.value.name);
        const status: ConnectionStatus = { _tag: 'Online', name: hello.value.name };
        everOnline.add(id);
        yield* put(id, { status, client: Option.some(client), scope: Option.some(scope) });
        return status;
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });

    /** Tells discovery how the Device answered, so one not answering is looked for (and retried here). */
    const record = Effect.fnUntraced(function* (id: DeviceId) {
      const status = (yield* entryOf(id))?.status;
      if (status === undefined || status._tag === 'Connecting') return;
      yield* presence.record(id, status._tag === 'Reconnecting' ? offline : status);
    });

    /**
     * Reaches a Device until it settles, with backoff, signalling `first` once the first try is done. A Device no
     * longer paired ends it and is dropped.
     */
    const keepReaching = Effect.fnUntraced(function* (
      id: DeviceId,
      mode: Mode,
      first: Deferred.Deferred<void>,
    ) {
      const reconnectingUntil =
        mode === 'Reconnecting' ? (yield* Clock.currentTimeMillis) + reconnectingMillis : 0;
      let pending: Option.Option<ConnectionStatus> = Option.some({ _tag: mode });
      const once = lockOf(id)
        .withPermit(
          Effect.suspend(() => {
            const shown = pending;
            pending = Option.none();
            return reach(id, shown, reconnectingUntil);
          }),
        )
        .pipe(
          Effect.tap(() => record(id)),
          Effect.ensuring(Deferred.succeed(first, undefined)),
          Effect.flatMap((status) => (isSettled(status) ? Effect.void : Effect.fail(UNSETTLED))),
        );
      yield* once.pipe(
        Effect.retry({
          schedule: reconnectSchedule(reconnectingFor),
          while: (error) => error === UNSETTLED,
        }),
        Effect.catchTag('DevicesError', () => close(id, Option.none())),
        Effect.ignore,
      );
    });

    /** Starts reaching a Device over, at once, replacing any run of attempts it had. */
    const restart = Effect.fnUntraced(function* (id: DeviceId, mode: Mode) {
      const running = loops.get(id);
      if (running !== undefined) yield* Fiber.interrupt(running);
      const first = yield* Deferred.make<void>();
      const fiber = yield* keepReaching(id, mode, first).pipe(Effect.forkIn(layerScope));
      loops.set(id, fiber);
      return first;
    });

    const stop = Effect.fnUntraced(function* (id: DeviceId) {
      const running = loops.get(id);
      loops.delete(id);
      if (running !== undefined) yield* Fiber.interrupt(running);
    });

    /** A connection dropped: reached again, unless it was replaced or closed meanwhile. */
    const reachAgainAfterDrop = Effect.fnUntraced(function* (id: DeviceId, scope: Scope.Closeable) {
      const entry = yield* entryOf(id);
      if (entry === undefined || Option.getOrUndefined(entry.scope) !== scope) return;
      yield* restart(id, 'Reconnecting');
    });

    /** How a Device is reached again at once: a Device that was connected shows Reconnecting. */
    const modeOf = (id: DeviceId): Mode => (everOnline.has(id) ? 'Reconnecting' : 'Connecting');

    /** Reaches again at once a Device that is not connected and could be (not refused for good). */
    const retryNow = Effect.fnUntraced(function* (id: DeviceId) {
      const status = (yield* entryOf(id))?.status;
      if (!known.has(id) || (status !== undefined && isSettled(status))) return;
      yield* restart(id, modeOf(id));
    });

    const connect = Effect.fnUntraced(function* (id: DeviceId) {
      if (!(yield* paired.list).some((device) => device.id === id)) {
        return yield* new DevicesError({ reason: 'NotFound', detail: `No Paired device ${id}.` });
      }
      known.add(id);
      const first = yield* restart(id, modeOf(id));
      yield* Deferred.await(first);
    });

    const forget = Effect.fnUntraced(function* (id: DeviceId) {
      known.delete(id);
      everOnline.delete(id);
      yield* stop(id);
      yield* lockOf(id).withPermit(close(id, Option.none()));
    });

    // Reach every Paired device once; let go of the ones no longer paired.
    yield* paired.changes.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (devices) {
          const ids = new Set(devices.map((device) => device.id));
          for (const device of devices) {
            if (!known.has(device.id) && !device.unpairedByOther) {
              known.add(device.id);
              yield* restart(device.id, 'Connecting');
            }
          }
          for (const id of [...known]) if (!ids.has(id)) yield* forget(id);
        }),
      ),
      Effect.forkIn(layerScope),
    );

    // Discovery saw a Device that is not connected announce itself again, or the network changed: at once.
    yield* presence.retries.pipe(Stream.runForEach(retryNow), Effect.forkIn(layerScope));

    // The computer woke up: whatever is not connected may be back, with no backoff left to wait out.
    yield* power.resumes.pipe(
      Stream.runForEach(() => Effect.forEach([...known], retryNow, { discard: true })),
      Effect.forkIn(layerScope),
    );

    // Credentials that stopped being valid close their client; a fresh Pairing reaches the Device again.
    yield* paired.revocations.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (id) {
          yield* stop(id);
          yield* lockOf(id).withPermit(close(id, Option.none()));
          const still = (yield* paired.list).find((device) => device.id === id);
          if (still === undefined) known.delete(id);
          else if (!still.unpairedByOther) yield* restart(id, 'Connecting');
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

    const unavailable = (id: DeviceId, reason: DeviceUnavailable['reason']) =>
      new DeviceUnavailable({
        reason,
        detail:
          reason === 'NotPaired'
            ? `Device ${id} is not a Paired device that can connect.`
            : `Device ${id} is not connected.`,
      });

    return {
      list: Effect.zipWith(paired.list, SubscriptionRef.get(entries), view),
      changes: Stream.zipLatest(paired.changes, SubscriptionRef.changes(entries)).pipe(
        Stream.map(([devices, current]) => view(devices, current)),
      ),
      connect,
      client: (id) =>
        Effect.flatMap(entryOf(id), (entry) => {
          const client = entry?.client ?? Option.none();
          return Option.isSome(client)
            ? Effect.succeed(client.value)
            : Effect.fail(unavailable(id, 'NotConnected'));
        }),
      awaitClient: (id, stale) =>
        SubscriptionRef.changes(entries).pipe(
          Stream.map((current): Exit.Exit<RemoteClient, DeviceUnavailable> | undefined => {
            const entry = current.get(id);
            if (!known.has(id)) return Exit.fail(unavailable(id, 'NotPaired'));
            if (entry === undefined) return undefined;
            if (Option.isSome(entry.client) && entry.client.value !== stale) {
              return Exit.succeed(entry.client.value);
            }
            return entry.status._tag === 'UnpairedByOther' ||
              entry.status._tag === 'IdentityChanged'
              ? Exit.fail(unavailable(id, 'NotPaired'))
              : undefined;
          }),
          Stream.filter(
            (outcome): outcome is Exit.Exit<RemoteClient, DeviceUnavailable> =>
              outcome !== undefined,
          ),
          Stream.runHead,
          Effect.flatMap((head) =>
            Option.isSome(head) ? head.value : Effect.fail(unavailable(id, 'NotPaired')),
          ),
        ),
    };
  }),
);
