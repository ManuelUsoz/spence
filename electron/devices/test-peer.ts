/**
 * Test foundation for the LAN seam: a whole Device in process, with its own temporary data directory, its own
 * identity and certificate, and a real `wss://` listener on loopback (an ephemeral port), serving `RemoteRpcs`
 * through the production server and pairing through the production ceremony. Discovery is not involved; the viewer
 * reaches the host by its loopback address.
 *
 * A spec makes two of these, pairs them with the host's code (`pairDevices`), and drives the host through the same
 * RPC client a Device uses (`connectRemote`). Everything but `Remote.hello` dies until a later spec serves real
 * handlers.
 */
import { Context, Effect, Layer, Option, Stream } from 'effect';
import { type Rpc, type RpcGroup } from 'effect/rpc';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
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
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { RemoteEndpoint } from '../lan/client';
import { LanConfig } from '../lan/config';
import { Discovery } from '../lan/discovery';
import type { Mdns } from '../lan/mdns';
import { type FakeLan, makeFakeLan } from '../lan/mdns-fake';
import { Hosting } from '../lan/hosting';
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
  /** How this Device reaches a Paired device with its own credentials. */
  readonly endpointOf: (id: DeviceId) => Effect.Effect<RemoteEndpoint, DevicesError>;
  /**
   * Where this Device listens now, as `viewer` presenting `token` would reach it: credentials made up by a test,
   * for what a real Paired device cannot produce.
   */
  readonly endpointFor: (viewer: DeviceId, token: string) => Effect.Effect<RemoteEndpoint>;
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
  /** The LAN this Device announces on and browses; a LAN of its own by default. Never a real multicast socket. */
  readonly lan?: FakeLan;
  /** Real multicast instead, for the live spec only (`SPENCE_LAN_LIVE=1`). */
  readonly mdns?: Layer.Layer<Mdns>;
}

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
  const layerHandlers = Layer.mergeAll(
    layerUnusedHandlers(RemoteRpcs),
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
        }),
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
    dataDir,
  };
  return device;
});

/** The Pairing ceremony as two people do it: hosting on, a code on `host`, typed on `viewer` with the address. */
export const pairDevices = Effect.fnUntraced(function* (host: TestDevice, viewer: TestDevice) {
  if (!(yield* host.local).hosting) yield* host.setHosting(true);
  const window = yield* host.startPairing;
  if (window._tag !== 'Open') return yield* Effect.die('no pairing code');
  return yield* viewer.pair(yield* host.address, window.code);
});
