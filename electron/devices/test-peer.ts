/**
 * Test foundation for the LAN seam: a whole Device in process, with its own temporary data directory, its own
 * identity and certificate, and a real `wss://` listener on loopback (an ephemeral port), serving `RemoteRpcs`
 * through the production server and pairing through the production ceremony. Discovery is not involved; the viewer
 * reaches the host by its loopback address.
 *
 * A spec makes two of these, pairs them with the host's code (`pairDevices`), and drives the host through the same
 * RPC client a Device uses (`connectRemote`). Everything but `Remote.hello` dies unless the spec serves real handlers
 * (`serve`). `desktop` is what the window of that Device would call: `DeviceScopedRpcs`, routed by the Device header.
 */
import { Context, type Duration, Effect, Layer, Option, Stream } from 'effect';
import { type Rpc, type RpcClient, type RpcGroup, RpcTest } from 'effect/rpc';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as connectTcp, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  ConnectedViewer,
  DeviceConnection,
  DeviceId,
  DevicesError,
  DevicesState,
  LocalDevice,
  NearbyDevice,
  PairedDevice,
  PairedDeviceStatus,
  PairingError,
  PairingWindow,
  VersionMismatch,
} from '../../src/shared/devices/devices.rpc';
import { MessagingRpcs } from '../../src/shared/messaging/messaging.rpc';
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { DeviceScopedRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { RemoteEndpoint } from '../lan/client';
import { LanConfig } from '../lan/config';
import { DeviceConnections, type DeviceConnectionsShape } from '../lan/connections';
import { relayRemoteAssets } from '../lan/asset-relay';
import { routeToDevices } from '../lan/router';
import { Discovery } from '../lan/discovery';
import type { Mdns } from '../lan/mdns';
import { type FakeLan, makeFakeLan } from '../lan/mdns-fake';
import { Hosting } from '../lan/hosting';
import { PowerEvents } from '../lan/power';
import { Viewers, viewersState } from '../lan/viewers';
import { Inbox } from '../messaging/inbox';
import { layerInboxHandlersWith, layerMessagingHandlersWith } from '../rpc/messaging';
import { layerRemoteInfoHandlersWith } from '../rpc/remote';
import { layerStore } from '../store/store';
import { DeviceIdentity, layerDeviceIdentity, type LocalDeviceRecord } from './identity';
import { layerDevices } from './layer';
import { PairedDevices } from './paired-devices';
import { checkPaired, devicesState, endpointOf, pairWith } from './pairing';
import { PairingHost } from './pairing-host';
import { layerSecretStorageFake } from './secret-storage';

/** Handlers for every RPC of `group` that die: what a test Device serves for what the test does not exercise. */
export const layerUnusedHandlers = <Rpcs extends Rpc.Any>(group: RpcGroup.RpcGroup<Rpcs>) =>
  group.toLayer(
    Object.fromEntries(
      [...group.requests.keys()].map((tag) => [
        tag,
        () => Effect.die(`${tag} is not served by this test Device`),
      ]),
      // One dying handler per tag; the map is built at run time, so its type is asserted.
    ) as unknown as RpcGroup.HandlersFrom<Rpcs>,
  ) as Layer.Layer<Rpc.ToHandler<Rpcs>>;

export interface TestDevice {
  /** This Device's identity as stored in its own data directory. */
  readonly identity: Effect.Effect<LocalDeviceRecord>;
  readonly local: Effect.Effect<LocalDevice>;
  readonly setHosting: (on: boolean) => Effect.Effect<LocalDevice, DevicesError>;
  readonly rename: (name: string) => Effect.Effect<LocalDevice, DevicesError>;
  /** The Devices announcing nearby, as Settings > Devices sees them; looks only while the stream runs. */
  readonly nearby: Stream.Stream<ReadonlyArray<NearbyDevice>>;
  /** Where this Device listens now (`127.0.0.1:port`); hosting must be on. */
  readonly address: Effect.Effect<string>;
  /** Shows a pairing code (Settings > Devices > Pair a new Device). */
  readonly startPairing: Effect.Effect<PairingWindow, DevicesError>;
  readonly cancelPairing: Effect.Effect<void>;
  /** The pairing window and Paired devices now. */
  readonly state: Effect.Effect<DevicesState>;
  /** The pairing window and Paired devices now, then on every change. */
  readonly watch: Stream.Stream<DevicesState>;
  /** Pairs with the Device hosting at `address` that shows `code` (Settings > Devices > Pair). */
  readonly pair: (
    address: string,
    code: string,
  ) => Effect.Effect<PairedDevice, PairingError | VersionMismatch>;
  readonly paired: Effect.Effect<ReadonlyArray<PairedDevice>>;
  readonly check: (id: DeviceId) => Effect.Effect<PairedDeviceStatus, DevicesError>;
  readonly unpair: (id: DeviceId) => Effect.Effect<void, DevicesError>;
  /** Settings > Devices > Allow Agents from this Device, for a Paired device. */
  readonly setAllowAgents: (id: DeviceId, allow: boolean) => Effect.Effect<void, DevicesError>;
  /** How this Device reaches a Paired device with its own credentials. */
  readonly endpointOf: (id: DeviceId) => Effect.Effect<RemoteEndpoint, DevicesError>;
  /**
   * Where this Device listens now, as `viewer` presenting `token` would reach it: credentials made up by a test,
   * for what a real Paired device cannot produce.
   */
  readonly endpointFor: (viewer: DeviceId, token: string) => Effect.Effect<RemoteEndpoint>;
  /** Every Paired device with its connection now. */
  readonly connections: Effect.Effect<ReadonlyArray<DeviceConnection>>;
  /** Waits until this Device's connection to `id` has `status`. */
  readonly awaitConnection: (
    id: DeviceId,
    status: DeviceConnection['status']['_tag'],
  ) => Effect.Effect<DeviceConnection>;
  /** Reaches a Paired device now (Retry). */
  readonly connect: (id: DeviceId) => Effect.Effect<void, DevicesError>;
  /** The Remote devices connected to this Device now (its viewers), by the name they paired under. */
  readonly viewers: Effect.Effect<ReadonlyArray<ConnectedViewer>>;
  /** Waits until exactly `count` viewers are connected, and returns them. */
  readonly awaitViewers: (count: number) => Effect.Effect<ReadonlyArray<ConnectedViewer>>;
  /** Closes a viewer's connections (Settings > Devices > Disconnect). */
  readonly disconnect: (id: DeviceId) => Effect.Effect<void>;
  /** This Device's identity service, for main-side services that need it. */
  readonly deviceIdentity: DeviceIdentity['Service'];
  /** This Device's outbound connections, for main-side services that follow its Remote devices. */
  readonly deviceConnections: DeviceConnectionsShape;
  /**
   * `DeviceScopedRpcs` as this Device's window calls them, through the production router: with no Device header
   * they run here, with one they go to that Remote device.
   */
  readonly desktop: RpcClient.FromGroup<typeof DeviceScopedRpcs>;
  /** `MessagingRpcs` as this Device's window calls them (Send to another Session); needs the `inbox` option. */
  readonly messaging: RpcClient.FromGroup<typeof MessagingRpcs>;
  /** The data directory, for a restart over the same files. */
  readonly dataDir: string;
}

export interface TestDeviceOptions {
  /** Reuse a data directory (a restart); a fresh temporary one otherwise, removed with the scope. */
  readonly dataDir?: string;
  /** The first port tried and how many follow; by default the OS picks a free one. */
  readonly port?: number;
  readonly portAttempts?: number;
  /** Whether the OS can store secrets safely (Linux without a keyring is `false`). Default `true`. */
  readonly secretStorage?: boolean;
  /** The protocol version this Device speaks; `PROTOCOL_VERSION` by default. */
  readonly protocolVersion?: number;
  /** Real handlers this Device serves, locally and to its Paired devices; anything else dies. */
  readonly serve?: Layer.Layer<never>;
  /** The Inbox this Device receives Cross-device messages with; without one, every Inbox call dies. */
  readonly inbox?: Layer.Layer<Inbox, never, DeviceIdentity>;
  /** The LAN this Device announces on and browses; a LAN of its own by default. Never a real multicast socket. */
  readonly lan?: FakeLan;
  /** Real multicast instead, for the live spec only (`SPENCE_LAN_LIVE=1`). */
  readonly mdns?: Layer.Layer<Mdns>;
  /** How long a dropped Device shows Reconnecting before Offline; the spec's minute by default. */
  readonly reconnectingFor?: Duration.Input;
  /** The OS power events this Device sees; none by default. */
  readonly power?: Layer.Layer<PowerEvents>;
}

/** An Inbox for a test Device that receives no Cross-device messages: every call dies. */
const layerInboxUnused = Layer.succeed(Inbox, {
  deliver: () => Effect.die('Inbox.deliver is not served by this test Device'),
  start: () => Effect.die('Inbox.start is not served by this test Device'),
  result: () => Effect.die('Inbox.result is not served by this test Device'),
});

/** A temporary data directory, removed with the scope. */
export const tempDataDir = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-device-'))),
  (dir) =>
    Effect.promise(() =>
      rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
    ),
);

/** A fresh bearer token, the size Pairing issues. */
export const makeToken = (): string => randomBytes(32).toString('base64url');

/** A Device for the life of the scope. Hosting starts off, as on a fresh install. */
export const makeTestDevice = Effect.fnUntraced(function* (options: TestDeviceOptions = {}) {
  const dataDir = options.dataDir ?? (yield* tempDataDir);
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION;
  const layerMdns = options.mdns ?? (options.lan ?? (yield* makeFakeLan)).layer;

  const layerStoreHere = layerStore(dataDir);
  const layerIdentity = layerDeviceIdentity.pipe(Layer.provide(layerStoreHere));
  const layerScoped = Layer.merge(
    layerUnusedHandlers(DeviceScopedRpcs),
    // Handlers for some tags of the group: they replace the dying ones, so the whole group is still served.
    (options.serve ?? Layer.empty) as Layer.Layer<
      Rpc.ToHandler<RpcGroup.Rpcs<typeof DeviceScopedRpcs>>
    >,
  );
  const layerInboxHere = Layer.provide(options.inbox ?? layerInboxUnused, layerIdentity);
  const layerInboxHandlers = layerInboxHandlersWith.pipe(Layer.provide(layerInboxHere));
  const layerHandlers = Layer.mergeAll(
    layerScoped,
    layerInboxHandlers,
    layerRemoteInfoHandlersWith,
  );
  const layerDevice = layerDevices.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerIdentity,
        layerStoreHere,
        layerMdns,
        layerSecretStorageFake({ available: options.secretStorage ?? true }),
        Layer.succeed(LanConfig, {
          host: '127.0.0.1',
          port: options.port ?? 0,
          portAttempts: options.portAttempts ?? 1,
          protocolVersion,
          reconnectingFor: options.reconnectingFor ?? '1 minute',
        }),
        options.power ?? Layer.succeed(PowerEvents, { resumes: Stream.never }),
      ),
    ),
    Layer.provide(Layer.provide(layerHandlers, layerIdentity)),
  );
  const services = yield* Layer.build(layerDevice);
  const hosting = Context.get(services, Hosting);
  const identity = Context.get(services, DeviceIdentity);
  const run = <A, E>(
    effect: Effect.Effect<A, E, Layer.Success<typeof layerDevice>>,
  ): Effect.Effect<A, E> => Effect.provide(effect, services);

  const connections = Context.get(services, DeviceConnections);
  const desktop = yield* RpcTest.makeClient(DeviceScopedRpcs, { disableFatalDefects: true }).pipe(
    Effect.provide(relayRemoteAssets(routeToDevices(DeviceScopedRpcs)(layerScoped))),
    Effect.provide(services),
  );

  const messaging = yield* RpcTest.makeClient(MessagingRpcs).pipe(
    Effect.provide(layerMessagingHandlersWith.pipe(Layer.provide(layerInboxHere))),
    Effect.provide(services),
  );

  const address = Effect.map(hosting.local, ({ port }) => `127.0.0.1:${port ?? 0}`);

  const device: TestDevice = {
    identity: identity.get,
    local: hosting.local,
    setHosting: hosting.set,
    rename: hosting.rename,
    nearby: Context.get(services, Discovery).nearby,
    address,
    startPairing: hosting.startPairing,
    cancelPairing: Context.get(services, PairingHost).close,
    state: run(Effect.map(Stream.runHead(devicesState), Option.getOrThrow)),
    watch: Stream.provide(devicesState, services),
    pair: (to, code) => run(pairWith({ address: to, code })),
    paired: Context.get(services, PairedDevices).list,
    check: (id) => run(checkPaired(id)),
    unpair: (id) => Context.get(services, PairedDevices).remove(id),
    setAllowAgents: (id, allow) => Context.get(services, PairedDevices).setAllowAgents(id, allow),
    endpointOf: (id) =>
      run(
        Effect.flatMap(endpointOf(id), (endpoint) =>
          Option.isSome(endpoint) ? Effect.succeed(endpoint.value) : Effect.die('no address'),
        ),
      ),
    endpointFor: Effect.fnUntraced(function* (viewer, token) {
      const { port } = yield* hosting.local;
      const { certificate } = yield* identity.get;
      return {
        url: `wss://127.0.0.1:${port ?? 0}`,
        certificate,
        credentials: { deviceId: viewer, token },
        protocolVersion,
      };
    }),
    connections: connections.list,
    awaitConnection: (id, status) =>
      connections.changes.pipe(
        Stream.map((all) => all.find((connection) => connection.id === id)),
        Stream.filter(
          (connection): connection is DeviceConnection =>
            connection !== undefined && connection.status._tag === status,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      ),
    connect: connections.connect,
    viewers: run(Effect.map(Stream.runHead(viewersState), Option.getOrThrow)),
    awaitViewers: (count) =>
      viewersState.pipe(
        Stream.filter((viewers) => viewers.length === count),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.provide(services),
      ),
    disconnect: Context.get(services, Viewers).disconnect,
    deviceIdentity: identity,
    deviceConnections: connections,
    desktop,
    messaging,
    dataDir,
  };
  return device;
});

/** The Pairing ceremony as two people do it: hosting on, a code on `host`, typed on `viewer` with the address. */
export const pairDevices = Effect.fnUntraced(function* (
  host: TestDevice,
  viewer: TestDevice,
  /** Where the viewer reaches the host; the host's own address by default. */
  through?: string,
) {
  if (!(yield* host.local).hosting) yield* host.setHosting(true);
  const window = yield* host.startPairing;
  if (window._tag !== 'Open') return yield* Effect.die('no pairing code');
  return yield* viewer.pair(through ?? (yield* host.address), window.code);
});

/** The network between a viewer and a host, with the faults a real LAN has. */
export interface TestLink {
  /** Where a viewer reaches the host through this link (`127.0.0.1:port`). */
  readonly address: string;
  /** Cuts every connection through the link at once; new ones get through. */
  readonly dropConnection: Effect.Effect<void>;
  /** Cuts every connection and lets none through until `heal`: the host keeps running, unreachable. */
  readonly partition: Effect.Effect<void>;
  readonly heal: Effect.Effect<void>;
}

/**
 * A loopback TCP relay in front of `host`'s listener, for the life of the scope. TLS and the WebSocket pass through
 * it untouched, so pinning and credentials are the real ones; only the network misbehaves.
 */
export const makeTestLink = Effect.fnUntraced(function* (host: TestDevice) {
  if (!(yield* host.local).hosting) yield* host.setHosting(true);
  const target = yield* host.address;
  const [targetHost, targetPort] = target.split(':');
  const live = new Set<Socket>();
  let partitioned = false;
  const cut = () => {
    for (const socket of live) socket.destroy();
    live.clear();
  };
  const relay = createServer((inbound) => {
    if (partitioned) {
      inbound.destroy();
      return;
    }
    const outbound = connectTcp(Number(targetPort), targetHost);
    for (const [from, to] of [
      [inbound, outbound],
      [outbound, inbound],
    ] as const) {
      live.add(from);
      from.on('error', () => to.destroy());
      from.on('close', () => {
        live.delete(from);
        to.destroy();
      });
      from.pipe(to);
    }
  });
  const port = yield* Effect.acquireRelease(
    Effect.callback<number>((resume) => {
      relay.listen(0, '127.0.0.1', () => {
        const address = relay.address();
        resume(Effect.succeed(typeof address === 'object' && address !== null ? address.port : 0));
      });
    }),
    () =>
      Effect.callback<void>((resume) => {
        cut();
        relay.close(() => resume(Effect.void));
      }),
  );
  const link: TestLink = {
    address: `127.0.0.1:${port}`,
    dropConnection: Effect.sync(cut),
    partition: Effect.sync(() => {
      partitioned = true;
      cut();
    }),
    heal: Effect.sync(() => {
      partitioned = false;
    }),
  };
  return link;
});
