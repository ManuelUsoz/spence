import { Effect, Layer, Option, Stream } from 'effect';
import {
  DeviceId,
  type DevicesState,
  PairingError,
  type PairedDevice,
  type PairedDeviceStatus,
  VersionMismatch,
} from '../../src/shared/devices/devices.rpc';
import {
  connectRemote,
  fetchCertificate,
  parseAddress,
  probe,
  type RemoteEndpoint,
  requestPairing,
  urlOf,
} from '../lan/client';
import { LanConfig } from '../lan/config';
import { Hosting } from '../lan/hosting';
import { deviceIdOf, fingerprintOf } from './certificate';
import { DeviceIdentity } from './identity';
import { PairedDevices } from './paired-devices';
import { PairingHost } from './pairing-host';
import { DevicePresence } from './presence';
import { hostProof, isPairingCode, issueToken, sameDigest, viewerProof } from './pairing-proof';
import { SecretStorage } from './secret-storage';

const failPairing = (reason: PairingError['reason'], detail: string) =>
  Effect.fail(new PairingError({ reason, detail }));

const versionMismatch = (localVersion: number, remoteVersion: number) =>
  new VersionMismatch({
    reason: localVersion < remoteVersion ? 'UpdateLocal' : 'UpdateRemote',
    detail: `This Device speaks protocol ${localVersion}, the other ${remoteVersion}.`,
    localVersion,
    remoteVersion,
  });

/**
 * The viewer's side of Pairing: reaches the Device hosting at `address`, learns the certificate it presents, proves
 * the code bound to that certificate's fingerprint, checks the host's proof back, then records the Pairing (its
 * certificate pinned, its token sealed). Refused up front when this Device cannot store secrets safely.
 */
export const pairWith = Effect.fn('Devices.pair')(function* (input: {
  readonly address: string;
  readonly code: string;
}) {
  const secrets = yield* SecretStorage;
  const identity = yield* DeviceIdentity;
  const paired = yield* PairedDevices;
  const { protocolVersion } = yield* LanConfig;
  if (!(yield* secrets.available)) {
    return yield* failPairing(
      'SecretStorageUnavailable',
      'The OS cannot store secrets safely on this Device.',
    );
  }
  const address = parseAddress(input.address);
  if (address === undefined) return yield* failPairing('InvalidAddress', 'Expected host:port.');
  const code = input.code.trim();
  if (!isPairingCode(code)) return yield* failPairing('WrongCode', 'A code has 6 digits.');

  const certificate = yield* fetchCertificate(address).pipe(
    Effect.catchTag('RemoteRefused', (refused) => failPairing('Unreachable', refused.detail)),
  );
  const hostId = deviceIdOf(certificate);
  if (hostId === undefined) {
    return yield* failPairing('Unreachable', 'That address is not a Spence Device.');
  }
  const local = yield* identity.get;
  if (hostId === local.id) return yield* failPairing('SelfPair', 'That is this Device.');
  const hostFingerprint = fingerprintOf(certificate);
  const known = yield* paired.certificateOf(DeviceId.make(hostId));
  if (Option.isSome(known) && fingerprintOf(known.value) !== hostFingerprint) {
    return yield* failPairing(
      'AlreadyPaired',
      'This Device id is paired with another certificate.',
    );
  }

  const token = issueToken();
  const hosting = yield* (yield* Hosting).local;
  const reply = yield* requestPairing(address, certificate, {
    protocolVersion,
    deviceId: local.id,
    name: local.name,
    certificate: local.certificate,
    port: hosting.port,
    token,
    proof: viewerProof(code, {
      hostFingerprint,
      viewerFingerprint: local.fingerprint,
      deviceId: local.id,
    }),
  }).pipe(
    Effect.catchTags({
      RemoteRefused: (refused) => failPairing('Unreachable', refused.detail),
      // The certificate changed between learning it and pairing: whoever answered is not who was asked.
      IdentityChanged: (changed) => failPairing('Rejected', changed.detail),
    }),
  );

  switch (reply._tag) {
    case 'VersionMismatch':
      return yield* versionMismatch(protocolVersion, reply.protocolVersion);
    case 'Refused':
      return yield* failPairing(reply.reason, reply.detail);
    case 'Paired': {
      const expected = hostProof(code, {
        hostFingerprint,
        viewerFingerprint: local.fingerprint,
        deviceId: reply.deviceId,
      });
      if (reply.deviceId !== hostId || !sameDigest(expected, reply.proof)) {
        return yield* failPairing('Rejected', 'The other Device did not prove the code.');
      }
      const device: PairedDevice = yield* paired.save({
        id: reply.deviceId,
        name: reply.name,
        address: input.address.trim(),
        certificate,
        issuedToken: token,
        receivedToken: reply.token,
      });
      return device;
    }
  }
});

/** How this Device reaches a Paired device as itself, if it knows where. */
export const endpointOf = Effect.fnUntraced(function* (id: DeviceId) {
  const paired = yield* PairedDevices;
  const local = yield* (yield* DeviceIdentity).get;
  const { protocolVersion } = yield* LanConfig;
  const credentials = yield* paired.credentialsFor(id);
  const address = credentials.address === null ? undefined : parseAddress(credentials.address);
  if (address === undefined) return Option.none<RemoteEndpoint>();
  return Option.some<RemoteEndpoint>({
    url: urlOf(address),
    certificate: credentials.certificate,
    credentials: { deviceId: local.id, token: credentials.token },
    protocolVersion,
  });
});

/** Reaches a Paired device with this Device's credentials and says how it went. */
const reach = Effect.fnUntraced(function* (id: DeviceId) {
  const paired = yield* PairedDevices;
  const { protocolVersion } = yield* LanConfig;
  const endpoint = yield* endpointOf(id);
  if (Option.isNone(endpoint)) return { _tag: 'Offline' } satisfies PairedDeviceStatus;

  const refused = yield* Effect.flip(probe(endpoint.value)).pipe(Effect.option);
  if (Option.isSome(refused)) {
    switch (refused.value.reason) {
      case 'Unreachable':
        return { _tag: 'Offline' } satisfies PairedDeviceStatus;
      case 'Unauthorized':
        yield* paired.markUnpairedByOther(id);
        return { _tag: 'UnpairedByOther' } satisfies PairedDeviceStatus;
      case 'IdentityChanged':
        return { _tag: 'IdentityChanged' } satisfies PairedDeviceStatus;
      case 'VersionMismatch': {
        const remoteVersion = refused.value.remoteVersion ?? protocolVersion;
        return {
          _tag: 'NeedsUpdate',
          update:
            versionMismatch(protocolVersion, remoteVersion).reason === 'UpdateLocal'
              ? 'Local'
              : 'Remote',
          localVersion: protocolVersion,
          remoteVersion,
        } satisfies PairedDeviceStatus;
      }
    }
  }

  const hello = yield* Effect.scoped(
    Effect.flatMap(connectRemote(endpoint.value), (client) => client['Remote.hello']()),
  ).pipe(Effect.timeout('5 seconds'), Effect.option);
  if (Option.isNone(hello)) return { _tag: 'Offline' } satisfies PairedDeviceStatus;
  yield* paired.seen(id, hello.value.name);
  return { _tag: 'Online', name: hello.value.name } satisfies PairedDeviceStatus;
});

/**
 * Reaches a Paired device with this Device's credentials and says how it went. A refusal of the credentials marks
 * it "unpaired by the other side"; an answer refreshes its name. Never fails for an unreachable Device. The outcome
 * is recorded, so discovery looks for a Device found Offline.
 */
export const checkPaired = Effect.fn('Devices.check')(function* (id: DeviceId) {
  const status = yield* reach(id);
  yield* DevicePresence.use((presence) => presence.record(id, status));
  return status;
});

/**
 * Tries a Paired device again at once when discovery says it may be back (it announced itself again, or the network
 * changed). Until the device connections exist, the attempt is the same check Settings > Devices makes.
 */
export const layerRetryPaired = Layer.effectDiscard(
  Effect.gen(function* () {
    const presence = yield* DevicePresence;
    const context = yield* Effect.context<
      DeviceIdentity | DevicePresence | LanConfig | PairedDevices | SecretStorage
    >();
    yield* Effect.forkScoped(
      Stream.runForEach(presence.retries, (id) =>
        checkPaired(id).pipe(Effect.ignore, Effect.provide(context)),
      ),
    );
  }),
);

/** Forgets a Paired device; its connections here close. The other side finds out when it next connects. */
export const unpair = (id: DeviceId) => PairedDevices.use((paired) => paired.remove(id));

/** What Settings > Devices shows about Pairing: now, then on every change. */
export const devicesState: Stream.Stream<DevicesState, never, PairingHost | PairedDevices> =
  Stream.unwrap(
    Effect.gen(function* () {
      const host = yield* PairingHost;
      const paired = yield* PairedDevices;
      return Stream.zipLatest(host.changes, paired.changes).pipe(
        Stream.map(([pairing, devices]): DevicesState => ({ pairing, paired: devices })),
      );
    }),
  );
