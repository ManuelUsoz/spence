import {
  Context,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from 'effect';
import { DeviceId, DevicesError, type PairedDevice } from '../../src/shared/devices/devices.rpc';
import { Store, type VersionedFile } from '../store/store';
import { fingerprintOf } from './certificate';
import { hashToken, sameDigest } from './pairing-proof';
import { SecretStorage } from './secret-storage';
import { DeviceTrust } from './trust';

/** What only this OS user may read: the token the Paired device issued us and the fingerprint we pinned. */
const Secret = Schema.Struct({ token: Schema.String, fingerprint: Schema.String });
const SecretJson = Schema.fromJsonString(Secret);

/** One Pairing as `paired-devices.json` keeps it. */
const StoredPairing = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  address: Schema.NullOr(Schema.String),
  /** PEM: public, needed as the only trusted root when connecting. Checked against the sealed fingerprint. */
  certificate: Schema.String,
  /** SHA-256 of the token this Device issued it: what it presents when it connects here. */
  tokenHash: Schema.String,
  /** `Secret`, sealed by the OS secret storage. */
  sealed: Schema.String,
  unpairedByOther: Schema.Boolean,
});
type StoredPairing = typeof StoredPairing.Type;

export const pairedDevicesFile: VersionedFile<{ readonly devices: ReadonlyArray<StoredPairing> }> =
  {
    file: 'paired-devices.json',
    version: 1,
    migrations: [],
    schema: Schema.Struct({ devices: Schema.Array(StoredPairing) }),
    initial: () => ({ devices: [] }),
  };

/** A completed ceremony, as either side records it. */
export interface NewPairing {
  readonly id: DeviceId;
  readonly name: string;
  readonly address: string | null;
  /** The other Device's certificate (PEM), as seen on the connection the code proof was bound to. */
  readonly certificate: string;
  /** The token this Device issued it (only its hash is kept). */
  readonly issuedToken: string;
  /** The token it issued this Device (sealed). */
  readonly receivedToken: string;
}

/** How to reach a Paired device as itself: its address hint, pinned certificate and our token for it. */
export interface PairedCredentials {
  readonly id: DeviceId;
  readonly address: string | null;
  readonly certificate: string;
  readonly token: string;
}

export interface PairedDevicesShape {
  readonly list: Effect.Effect<ReadonlyArray<PairedDevice>>;
  /** The list now, then after every change. */
  readonly changes: Stream.Stream<ReadonlyArray<PairedDevice>>;
  /** The pinned certificate of a Paired device, if it is one. */
  readonly certificateOf: (id: DeviceId) => Effect.Effect<Option.Option<string>>;
  /** Records a Pairing, replacing an earlier one with the same Device (same certificate: a fresh ceremony). */
  readonly save: (pairing: NewPairing) => Effect.Effect<PairedDevice>;
  /** Our credentials for a Paired device. */
  readonly credentialsFor: (id: DeviceId) => Effect.Effect<PairedCredentials, DevicesError>;
  /** It answered under its current name. */
  readonly seen: (id: DeviceId, name: string) => Effect.Effect<void>;
  /**
   * It announced itself nearby at `address` under `name`: remembered as where to reach it. Only a hint; reaching it
   * still checks its pinned certificate.
   */
  readonly located: (id: DeviceId, address: string, name: string) => Effect.Effect<void>;
  /** It refused our credentials: it unpaired us. */
  readonly markUnpairedByOther: (id: DeviceId) => Effect.Effect<void>;
  /** Forgets a Paired device; its live connections are closed through `DeviceTrust.revocations`. */
  readonly remove: (id: DeviceId) => Effect.Effect<void, DevicesError>;
  readonly authorize: DeviceTrust['Service']['authorize'];
  readonly revocations: Stream.Stream<DeviceId>;
}

/** The Paired devices in `<userData>/spence/paired-devices.json`; secrets sealed by `SecretStorage`. */
export class PairedDevices extends Context.Service<PairedDevices, PairedDevicesShape>()(
  'devices/PairedDevices',
) {}

const view = (stored: StoredPairing): PairedDevice => ({
  id: stored.id,
  name: stored.name,
  address: stored.address,
  unpairedByOther: stored.unpairedByOther,
});

const notFound = (id: DeviceId) =>
  new DevicesError({ reason: 'NotFound', detail: `No Paired device ${id}.` });

export const layerPairedDevices = Layer.effect(
  PairedDevices,
  Effect.gen(function* () {
    const store = yield* Store;
    const secrets = yield* SecretStorage;
    const lock = yield* Semaphore.make(1);
    // A broken or newer file must not stop the app (this layer is built at start): Pairings start empty instead.
    const initial = yield* store.readVersioned(pairedDevicesFile).pipe(
      Effect.map((file) => file.devices),
      Effect.catchTag('StoreError', (error) =>
        Effect.as(
          Effect.logWarning('paired-devices.json could not be read; no Device is paired.', error),
          [],
        ),
      ),
    );
    const devices = yield* SubscriptionRef.make<ReadonlyArray<StoredPairing>>(initial);
    const revoked = yield* PubSub.unbounded<DeviceId>();

    const write = Effect.fnUntraced(function* (next: ReadonlyArray<StoredPairing>) {
      yield* store.writeVersioned(pairedDevicesFile, { devices: next });
      yield* SubscriptionRef.set(devices, next);
    });

    const update = (id: DeviceId, change: (stored: StoredPairing) => StoredPairing) =>
      lock.withPermit(
        Effect.gen(function* () {
          const current = yield* SubscriptionRef.get(devices);
          const next = current.map((stored) => (stored.id === id ? change(stored) : stored));
          // Nothing changed (or no such Device): no write, no change event.
          if (next.every((stored, index) => stored === current[index])) return;
          yield* write(next);
        }),
      );

    const find = (id: DeviceId) =>
      Effect.map(SubscriptionRef.get(devices), (current) =>
        Option.fromNullishOr(current.find((stored) => stored.id === id)),
      );

    const sealSecret = (token: string, certificate: string) =>
      secrets.seal(
        Schema.encodeSync(SecretJson)({ token, fingerprint: fingerprintOf(certificate) }),
      );

    const save = (pairing: NewPairing) =>
      lock.withPermit(
        Effect.gen(function* () {
          const stored: StoredPairing = {
            id: pairing.id,
            name: pairing.name,
            address: pairing.address,
            certificate: pairing.certificate,
            tokenHash: hashToken(pairing.issuedToken),
            sealed: yield* sealSecret(pairing.receivedToken, pairing.certificate),
            unpairedByOther: false,
          };
          const current = yield* SubscriptionRef.get(devices);
          const replaced = current.some((existing) => existing.id === pairing.id);
          yield* write([...current.filter((existing) => existing.id !== pairing.id), stored]);
          // A fresh ceremony replaces the old tokens: connections made with them end.
          if (replaced) yield* PubSub.publish(revoked, pairing.id);
          return view(stored);
        }),
      );

    const credentialsFor = Effect.fnUntraced(function* (id: DeviceId) {
      const stored = yield* find(id);
      if (Option.isNone(stored)) return yield* notFound(id);
      const { certificate, address, sealed } = stored.value;
      const opened = yield* secrets.open(sealed);
      const secret = Schema.decodeUnknownSync(SecretJson)(opened.plain);
      // The certificate sits in plain JSON; the sealed fingerprint is what was pinned. A file edited by hand to
      // swap the certificate is a defect, never a silent re-trust.
      if (secret.fingerprint !== fingerprintOf(certificate)) {
        return yield* Effect.die(`The pinned certificate of ${id} was changed on disk.`);
      }
      if (opened.stale) {
        const resealed = yield* sealSecret(secret.token, certificate);
        yield* update(id, (current) => ({ ...current, sealed: resealed }));
      }
      return { id, address, certificate, token: secret.token };
    });

    return {
      list: Effect.map(SubscriptionRef.get(devices), (current) => current.map(view)),
      changes: Stream.map(SubscriptionRef.changes(devices), (current) => current.map(view)),
      certificateOf: (id) =>
        Effect.map(
          find(id),
          Option.map((stored) => stored.certificate),
        ),
      save,
      credentialsFor,
      seen: (id, name) =>
        update(id, (stored) =>
          stored.name === name && !stored.unpairedByOther
            ? stored
            : { ...stored, name, unpairedByOther: false },
        ),
      located: (id, address, name) =>
        update(id, (stored) =>
          stored.address === address && stored.name === name
            ? stored
            : { ...stored, address, name },
        ),
      markUnpairedByOther: (id) => update(id, (stored) => ({ ...stored, unpairedByOther: true })),
      remove: (id) =>
        lock.withPermit(
          Effect.gen(function* () {
            const current = yield* SubscriptionRef.get(devices);
            if (!current.some((stored) => stored.id === id)) return yield* notFound(id);
            yield* write(current.filter((stored) => stored.id !== id));
            yield* PubSub.publish(revoked, id);
          }),
        ),
      authorize: ({ deviceId, token }) =>
        Effect.map(SubscriptionRef.get(devices), (current) => {
          const stored = current.find((candidate) => candidate.id === deviceId);
          return stored !== undefined && sameDigest(stored.tokenHash, hashToken(token))
            ? Option.some(stored.id)
            : Option.none();
        }),
      revocations: Stream.fromPubSub(revoked),
    };
  }),
);

/** Lets in the Paired devices only, and closes a Device's connections when it is unpaired. */
export const layerDeviceTrust = Layer.effect(
  DeviceTrust,
  Effect.gen(function* () {
    const paired = yield* PairedDevices;
    return { authorize: paired.authorize, revocations: paired.revocations };
  }),
);
