/**
 * Test foundation for the LAN seam: a whole Device in process, with its own temporary data directory, its own
 * identity and certificate, and a real `wss://` listener on loopback (an ephemeral port), serving `RemoteRpcs`
 * through the production server. Discovery is not involved; the viewer reaches the host by its endpoint.
 *
 * A spec makes two of these, lets one trust the other (`trust`, standing in for Pairing until it exists), and drives
 * the host through the same RPC client a Device uses (`connectRemote`). Everything but `Remote.hello` dies until a
 * later spec serves real handlers.
 */
import { Context, Effect, Layer, Option } from 'effect';
import { type Rpc, type RpcGroup } from 'effect/rpc';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  DeviceId,
  type DevicesError,
  type LocalDevice,
} from '../../src/shared/devices/devices.rpc';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { RemoteEndpoint } from '../lan/client';
import { Hosting, layerHosting } from '../lan/hosting';
import { LanConfig } from '../lan/server';
import { layerRemoteInfoHandlersWith } from '../rpc/remote';
import { layerStore } from '../store/store';
import { DeviceIdentity, layerDeviceIdentity, type LocalDeviceRecord } from './identity';
import { DeviceTrust } from './trust';

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
  readonly rename: (name: string) => Effect.Effect<LocalDeviceRecord, DevicesError>;
  /** Lets `viewer` in with `token`: what Pairing will record. */
  readonly trust: (viewer: DeviceId, token: string) => Effect.Effect<void>;
  /** Where this Device listens now, as `viewer` presenting `token` would reach it. */
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
  const trusted = new Map<string, string>();

  const layerTrust = Layer.succeed(DeviceTrust, {
    authorize: ({ deviceId, token }) =>
      Effect.sync(() =>
        trusted.get(deviceId) === token ? Option.some(DeviceId.make(deviceId)) : Option.none(),
      ),
  });
  const layerIdentity = layerDeviceIdentity.pipe(Layer.provide(layerStore(dataDir)));
  const layerHandlers = Layer.mergeAll(
    layerUnusedHandlers(RemoteRpcs),
    layerRemoteInfoHandlersWith,
  );
  const layerDevice = layerHosting.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerHandlers,
        layerTrust,
        Layer.succeed(LanConfig, {
          host: '127.0.0.1',
          port: options.port ?? 0,
          portAttempts: options.portAttempts ?? 1,
        }),
      ),
    ),
    Layer.provideMerge(layerIdentity),
  );
  const services = yield* Layer.build(layerDevice);
  const hosting = Context.get(services, Hosting);
  const identity = Context.get(services, DeviceIdentity);

  const device: TestDevice = {
    identity: identity.get,
    local: hosting.local,
    setHosting: hosting.set,
    rename: identity.rename,
    trust: (viewer, token) => Effect.sync(() => void trusted.set(viewer, token)),
    endpointFor: Effect.fnUntraced(function* (viewer, token) {
      const { port } = yield* hosting.local;
      const { certificate } = yield* identity.get;
      return {
        url: `wss://127.0.0.1:${port ?? 0}`,
        certificate,
        credentials: { deviceId: viewer, token },
      };
    }),
    dataDir,
  };
  return device;
});
