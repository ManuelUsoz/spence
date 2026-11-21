/**
 * Pairing over the LAN seam: two in-process Devices, each over its own temporary data directory, pairing over real
 * TLS on loopback through the production ceremony, then reaching each other through the client a Device uses.
 */
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { TestClock } from 'effect/testing';
import { readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';
import { connectRemote, fetchCertificate, parseAddress, requestPairing } from '../lan/client';
import { fingerprintOf } from './certificate';
import { viewerProof } from './pairing-proof';
import { makeTestDevice, makeToken, pairDevices, tempDataDir, type TestDevice } from './test-peer';

const idOf = (device: TestDevice) => Effect.map(device.identity, (identity) => identity.id);

const openCode = Effect.fnUntraced(function* (host: TestDevice) {
  if (!(yield* host.local).hosting) yield* host.setHosting(true);
  const window = yield* host.startPairing;
  if (window._tag !== 'Open') return yield* Effect.die('no pairing code');
  return window.code;
});

const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

const callHello = (endpoint: Parameters<typeof connectRemote>[0]) =>
  Effect.scoped(Effect.flatMap(connectRemote(endpoint), (client) => client['Remote.hello']()));

describe('Pairing', () => {
  it.live('pairs two Devices with the host code; each then reaches the other as itself', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* host.rename('Studio PC');
      yield* viewer.rename('Kitchen laptop');
      // The viewer hosts too, so the host learns where to reach it.
      yield* viewer.setHosting(true);

      const paired = yield* pairDevices(host, viewer);
      const hostId = yield* idOf(host);
      const viewerId = yield* idOf(viewer);
      expect(paired).toMatchObject({ id: hostId, name: 'Studio PC', unpairedByOther: false });
      expect((yield* host.state).pairing).toEqual({ _tag: 'Paired', name: 'Kitchen laptop' });
      expect((yield* host.paired).map((device) => device.id)).toEqual([viewerId]);

      const toHost = yield* callHello(yield* viewer.endpointOf(hostId));
      expect(toHost).toMatchObject({ deviceId: hostId, name: 'Studio PC' });
      const toViewer = yield* callHello(yield* host.endpointOf(viewerId));
      expect(toViewer).toMatchObject({ deviceId: viewerId, name: 'Kitchen laptop' });

      expect(yield* viewer.check(hostId)).toEqual({ _tag: 'Online', name: 'Studio PC' });
      expect(yield* host.check(viewerId)).toEqual({ _tag: 'Online', name: 'Kitchen laptop' });
    }).pipe(Effect.scoped),
  );

  it.live('keeps only token hashes and sealed secrets on disk', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* viewer.setHosting(true);
      yield* pairDevices(host, viewer);
      const toHost = yield* viewer.endpointOf(yield* idOf(host));
      const toViewer = yield* host.endpointOf(yield* idOf(viewer));
      for (const device of [host, viewer]) {
        const file = yield* Effect.promise(() =>
          readFile(path.join(device.dataDir, 'paired-devices.json'), 'utf8'),
        );
        expect(file).not.toContain(toHost.credentials.token);
        expect(file).not.toContain(toViewer.credentials.token);
      }
    }).pipe(Effect.scoped),
  );

  it.live('a code is single use', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      const other = yield* makeTestDevice();
      const code = yield* openCode(host);
      yield* viewer.pair(yield* host.address, code);

      const again = yield* Effect.flip(other.pair(yield* host.address, code));
      expect(again).toMatchObject({ _tag: 'PairingError', reason: 'NoCode' });
      expect(yield* other.paired).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live('closes the code after three wrong ones', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      const code = yield* openCode(host);
      const address = yield* host.address;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refused = yield* Effect.flip(viewer.pair(address, wrong(code)));
        expect(refused).toMatchObject({ _tag: 'PairingError', reason: 'WrongCode' });
      }
      expect((yield* host.state).pairing).toEqual({ _tag: 'TooManyAttempts' });
      const late = yield* Effect.flip(viewer.pair(address, code));
      expect(late).toMatchObject({ _tag: 'PairingError', reason: 'NoCode' });
      expect(yield* host.paired).toEqual([]);
      expect(yield* viewer.paired).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect('a code expires after two minutes', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      const code = yield* openCode(host);
      yield* TestClock.adjust('119 seconds');
      expect((yield* host.state).pairing._tag).toBe('Open');
      yield* TestClock.adjust('1 second');
      expect((yield* host.state).pairing).toEqual({ _tag: 'Expired' });

      const late = yield* Effect.flip(viewer.pair(yield* host.address, code));
      expect(late).toMatchObject({ _tag: 'PairingError', reason: 'NoCode' });
    }).pipe(Effect.scoped),
  );

  it.live('a code needs hosting on, and turning hosting off closes it', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const refused = yield* Effect.flip(host.startPairing);
      expect(refused).toMatchObject({ _tag: 'DevicesError', reason: 'NotHosting' });

      yield* openCode(host);
      yield* host.setHosting(false);
      expect((yield* host.state).pairing).toEqual({ _tag: 'Idle' });
    }).pipe(Effect.scoped),
  );

  it.live('is refused, with nothing stored, when either Device cannot store secrets safely', () =>
    Effect.gen(function* () {
      const noKeyringHost = yield* makeTestDevice({ secretStorage: false });
      yield* noKeyringHost.setHosting(true);
      const hostRefused = yield* Effect.flip(noKeyringHost.startPairing);
      expect(hostRefused).toMatchObject({
        _tag: 'DevicesError',
        reason: 'SecretStorageUnavailable',
      });

      const host = yield* makeTestDevice();
      const noKeyringViewer = yield* makeTestDevice({ secretStorage: false });
      const code = yield* openCode(host);
      const viewerRefused = yield* Effect.flip(noKeyringViewer.pair(yield* host.address, code));
      expect(viewerRefused).toMatchObject({
        _tag: 'PairingError',
        reason: 'SecretStorageUnavailable',
      });
      expect(yield* noKeyringViewer.paired).toEqual([]);
      expect(yield* host.paired).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live(
    'refuses a proof bound to another certificate than the host one (a man in the middle)',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        const impostor = yield* makeTestDevice();
        const code = yield* openCode(host);
        const address = parseAddress(yield* host.address);
        if (address === undefined) return expect.unreachable('a loopback address');
        const hostCertificate = yield* fetchCertificate(address);
        const viewerIdentity = yield* viewer.identity;
        // The viewer was shown the impostor's certificate, so its proof binds that one, with the right code.
        const proof = viewerProof(code, {
          hostFingerprint: fingerprintOf((yield* impostor.identity).certificate),
          viewerFingerprint: viewerIdentity.fingerprint,
          deviceId: viewerIdentity.id,
        });
        const reply = yield* requestPairing(address, hostCertificate, {
          protocolVersion: PROTOCOL_VERSION,
          deviceId: viewerIdentity.id,
          name: viewerIdentity.name,
          certificate: viewerIdentity.certificate,
          port: null,
          token: makeToken(),
          proof,
        });
        expect(reply).toMatchObject({ _tag: 'Refused', reason: 'WrongCode' });
        expect(yield* host.paired).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live('pairing is the only thing served without credentials', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      yield* host.setHosting(true);
      const { certificate } = yield* host.identity;
      const { port } = yield* host.local;
      const status = (method: string, pathname: string) =>
        Effect.callback<number>((resume) => {
          const sent = request(
            {
              host: '127.0.0.1',
              port,
              method,
              path: pathname,
              ca: certificate,
              checkServerIdentity: () => undefined,
            },
            (response) => {
              response.resume();
              resume(Effect.succeed(response.statusCode ?? 0));
            },
          );
          sent.on('error', () => resume(Effect.succeed(-1)));
          sent.end();
        });
      expect(yield* status('GET', '/')).toBe(404);
      expect(yield* status('GET', '/pair')).toBe(404);
      expect(yield* status('POST', '/pair')).toBe(400);
    }).pipe(Effect.scoped),
  );

  it.live(
    'unpairing on the host closes the viewer connection; the viewer sees it was unpaired',
    () =>
      Effect.gen(function* () {
        const host = yield* makeTestDevice();
        const viewer = yield* makeTestDevice();
        yield* pairDevices(host, viewer);
        const hostId = yield* idOf(host);
        const viewerId = yield* idOf(viewer);

        const client = yield* connectRemote(yield* viewer.endpointOf(hostId));
        yield* client['Remote.hello']();
        yield* host.unpair(viewerId);
        expect(yield* host.paired).toEqual([]);
        // The live connection is gone and its credentials no longer open a new one.
        const after = yield* Effect.exit(
          client['Remote.hello']().pipe(Effect.timeout('2 seconds')),
        );
        expect(Exit.isFailure(after)).toBe(true);

        expect(yield* viewer.check(hostId)).toEqual({ _tag: 'UnpairedByOther' });
        expect(yield* viewer.paired).toMatchObject([{ id: hostId, unpairedByOther: true }]);
        yield* viewer.unpair(hostId);
        expect(yield* viewer.paired).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live('unpairing on the viewer refuses the host when it reaches back', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* viewer.setHosting(true);
      yield* pairDevices(host, viewer);
      yield* viewer.unpair(yield* idOf(host));
      expect(yield* host.check(yield* idOf(viewer))).toEqual({ _tag: 'UnpairedByOther' });
    }).pipe(Effect.scoped),
  );

  it.live('a host that comes back with another identity is refused as identity changed', () =>
    Effect.gen(function* () {
      const viewer = yield* makeTestDevice();
      const dataDir = yield* tempDataDir;
      const { hostId, port } = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeTestDevice({ dataDir });
          yield* pairDevices(host, viewer);
          const { port } = yield* host.local;
          return { hostId: yield* idOf(host), port: port ?? 0 };
        }),
      );
      // Same address, new key: device.json is gone, so it makes a new identity.
      yield* Effect.promise(() => rm(path.join(dataDir, 'device.json')));
      const replaced = yield* makeTestDevice({ dataDir, port });
      expect((yield* replaced.setHosting(true)).port).toBe(port);

      expect(yield* viewer.check(hostId)).toEqual({ _tag: 'IdentityChanged' });
      const toHost = yield* viewer.endpointOf(hostId);
      expect(
        Exit.isFailure(yield* Effect.exit(callHello(toHost).pipe(Effect.timeout('2 seconds')))),
      ).toBe(true);
      expect(yield* viewer.paired).toMatchObject([{ id: hostId, unpairedByOther: false }]);
    }).pipe(Effect.scoped),
  );

  it.live('a protocol version mismatch names the side to update and keeps the Pairing', () =>
    Effect.gen(function* () {
      const newer = yield* makeTestDevice({ protocolVersion: PROTOCOL_VERSION + 1 });
      const viewer = yield* makeTestDevice();
      const code = yield* openCode(newer);
      const refused = yield* Effect.flip(viewer.pair(yield* newer.address, code));
      expect(refused).toMatchObject({
        _tag: 'VersionMismatch',
        reason: 'UpdateLocal',
        localVersion: PROTOCOL_VERSION,
        remoteVersion: PROTOCOL_VERSION + 1,
      });

      const dataDir = yield* tempDataDir;
      const { hostId, port } = yield* Effect.scoped(
        Effect.gen(function* () {
          const host = yield* makeTestDevice({ dataDir });
          yield* pairDevices(host, viewer);
          const { port } = yield* host.local;
          return { hostId: yield* idOf(host), port: port ?? 0 };
        }),
      );
      const updated = yield* makeTestDevice({
        dataDir,
        port,
        protocolVersion: PROTOCOL_VERSION + 1,
      });
      expect((yield* updated.local).port).toBe(port);
      expect(yield* viewer.check(hostId)).toEqual({
        _tag: 'NeedsUpdate',
        update: 'Local',
        localVersion: PROTOCOL_VERSION,
        remoteVersion: PROTOCOL_VERSION + 1,
      });
      expect(yield* viewer.paired).toMatchObject([{ id: hostId, unpairedByOther: false }]);
    }).pipe(Effect.scoped),
  );

  it.live('a Paired device that is not hosting is offline, and still paired', () =>
    Effect.gen(function* () {
      const host = yield* makeTestDevice();
      const viewer = yield* makeTestDevice();
      yield* pairDevices(host, viewer);
      yield* host.setHosting(false);
      expect(yield* viewer.check(yield* idOf(host))).toEqual({ _tag: 'Offline' });
      // The host never learned where the viewer listens (it was not hosting): offline, not an error.
      expect(yield* host.check(yield* idOf(viewer))).toEqual({ _tag: 'Offline' });
      expect(yield* viewer.paired).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.live('refuses an address that is not host:port, and this Device itself', () =>
    Effect.gen(function* () {
      const device = yield* makeTestDevice();
      const code = yield* openCode(device);
      const invalid = yield* Effect.flip(device.pair('not an address', code));
      expect(invalid).toMatchObject({ _tag: 'PairingError', reason: 'InvalidAddress' });
      const self = yield* Effect.flip(device.pair(yield* device.address, code));
      expect(self).toMatchObject({ _tag: 'PairingError', reason: 'SelfPair' });
    }).pipe(Effect.scoped),
  );
});
