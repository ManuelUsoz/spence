/**
 * The LAN seam: two in-process Devices, each over its own temporary data directory, talking over real `wss://` on
 * loopback through the production server and the client a Device uses, after pairing with a code. Discovery is not
 * involved.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import type { RpcClient, RpcClientError } from 'effect/rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { DeviceId } from '../../src/shared/devices/devices.rpc';
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { makeTestDevice, makeToken, pairDevices, tempDataDir } from '../devices/test-peer';
import { connect, connectRemote } from './client';

describe('LAN Devices', () => {
  it.live('a viewer calls an allow-listed RPC on a hosting Device', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      const viewerId = (yield* viewer.identity).id;
      yield* pairDevices(host, viewer);
      const hostId = (yield* host.identity).id;

      const client = yield* connectRemote(yield* viewer.endpointOf(hostId));
      const hello = yield* client['Remote.hello']();

      const hostIdentity = yield* host.identity;
      expect(hello).toEqual({
        deviceId: hostIdentity.id,
        name: hostIdentity.name,
        protocolVersion: PROTOCOL_VERSION,
      });
      expect(hello.deviceId).not.toBe(viewerId);
    }).pipe(Effect.scoped),
  );

  it.live('hosting is off on a fresh Device', () =>
    Effect.gen(function* () {
      const device = yield* makeTestDevice();
      const local = yield* device.local;
      expect(local).toMatchObject({ hosting: false, port: null });
      expect(DeviceId.make(local.id)).toBe((yield* device.identity).id);
    }).pipe(Effect.scoped),
  );

  it.live('turning hosting off closes the listener', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* pairDevices(host, viewer);
      const on = yield* host.local;
      expect(on.hosting).toBe(true);
      expect(on.port).toBeGreaterThan(0);
      const endpoint = yield* viewer.endpointOf((yield* host.identity).id);

      const off = yield* host.setHosting(false);
      expect(off).toMatchObject({ hosting: false, port: null });

      const client = yield* connectRemote(endpoint);
      expect(Exit.isFailure(yield* Effect.exit(client['Remote.hello']()))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live('a Device that is not trusted is refused', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      const viewerId = (yield* viewer.identity).id;
      yield* pairDevices(host, viewer);

      const client = yield* connectRemote(yield* host.endpointFor(viewerId, makeToken()));
      expect(Exit.isFailure(yield* Effect.exit(client['Remote.hello']()))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live('a host presenting another certificate than the pinned one is refused', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const impostor = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* pairDevices(host, viewer);
      const hostId = (yield* host.identity).id;

      const endpoint = yield* viewer.endpointOf(hostId);
      const client = yield* connectRemote({
        ...endpoint,
        certificate: (yield* impostor.identity).certificate,
      });
      expect(Exit.isFailure(yield* Effect.exit(client['Remote.hello']()))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live('Tabs, Links, Devices, Settings and AppInfo are unreachable from a Remote device', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* pairDevices(host, viewer);
      const hostId = (yield* host.identity).id;
      const endpoint = yield* viewer.endpointOf(hostId);

      // A client for everything the local window can call, as a hostile Device could build; one connection per call.
      const probe = <A, E>(
        call: (
          client: RpcClient.FromGroup<typeof DesktopRpcs, RpcClientError.RpcClientError>,
        ) => Effect.Effect<A, E>,
      ) =>
        Effect.scoped(
          Effect.flatMap(connect(DesktopRpcs, endpoint), (client) => Effect.exit(call(client))),
        );

      expect(Exit.isSuccess(yield* probe((client) => client['Remote.hello']()))).toBe(true);
      const refused = [
        yield* probe((client) => client['Tabs.restore']()),
        yield* probe((client) => client['Links.openExternal']({ url: 'https://example.com' })),
        yield* probe((client) => client['Devices.local']()),
        yield* probe((client) => client['Devices.setHosting']({ on: false })),
        yield* probe((client) => client['Settings.get']()),
        yield* probe((client) => client['AppInfo.get']()),
      ];
      // Refused by the server for not being in the group it serves, not by a broken connection.
      for (const exit of refused) expect(String(exit)).toContain('Unknown request tag');
      // Still hosting: the refused calls changed nothing.
      expect((yield* host.local).hosting).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live('a Device keeps its identity and resumes hosting after a restart', () =>
    Effect.gen(function* () {
      const dataDir = yield* tempDataDir;
      const first = yield* Effect.scoped(
        Effect.gen(function* () {
          const device = yield* makeTestDevice({ dataDir });
          yield* device.setHosting(true);
          return (yield* device.identity).id;
        }),
      );
      const restarted = yield* makeTestDevice({ dataDir });
      expect((yield* restarted.identity).id).toBe(first);
      expect((yield* restarted.local).hosting).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live(
    'hosting takes the next port when the first is in use, and stays off when none is free',
    () =>
      Effect.gen(function* () {
        const first = yield* makeTestDevice();
        const { port } = yield* first.setHosting(true);
        if (port === null) return expect.unreachable('hosting reports its port');

        const blocked = yield* makeTestDevice({ port, portAttempts: 1 });
        const refused = yield* Effect.flip(blocked.setHosting(true));
        expect(refused).toMatchObject({ _tag: 'DevicesError', reason: 'ListenFailed' });
        expect(yield* blocked.local).toMatchObject({ hosting: false, port: null });

        const next = yield* makeTestDevice({ port, portAttempts: 5 });
        const on = yield* next.setHosting(true);
        expect(on.hosting).toBe(true);
        expect(on.port).toBeGreaterThan(port);
      }).pipe(Effect.scoped),
  );

  it.live('a viewer sees the name the host was renamed to; a blank name is refused', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* pairDevices(host, viewer);
      const hostId = (yield* host.identity).id;

      yield* host.rename('  Studio PC  ');
      const refused = yield* Effect.flip(host.rename('   '));
      expect(refused).toMatchObject({ _tag: 'DevicesError', reason: 'InvalidName' });

      const client = yield* connectRemote(yield* viewer.endpointOf(hostId));
      expect((yield* client['Remote.hello']()).name).toBe('Studio PC');
    }).pipe(Effect.scoped),
  );
});
