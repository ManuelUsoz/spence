import { Context, Effect, Layer, Option, Schema, Semaphore } from 'effect';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { DEVICE_NAME_MAX, DeviceId, DevicesError } from '../../src/shared/devices/devices.rpc';
import { toWireDefect } from '../../src/shared/rpc/wire-error';
import { layerStoreUserData, Store, type VersionedFile } from '../store/store';
import { fingerprintOf, generateCertificate } from './certificate';

/** This Device as stored in `device.json`: who it is, how it proves it, and whether it hosts. */
const StoredDevice = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  hosting: Schema.Boolean,
  /** PEM. The private key stays on this Device; only the certificate is ever shown to another. */
  certificate: Schema.String,
  privateKey: Schema.String,
});
type StoredDevice = typeof StoredDevice.Type;

/** `null` until the Device is first needed, then created once and kept for good. */
export const deviceFile: VersionedFile<StoredDevice | null> = {
  file: 'device.json',
  version: 1,
  migrations: [],
  schema: Schema.NullOr(StoredDevice),
  initial: () => null,
};

/** The Local device's identity and hosting choice, resolved. */
export interface LocalDeviceRecord extends StoredDevice {
  /** SHA-256 fingerprint of `certificate`: what Paired devices pin. */
  readonly fingerprint: string;
}

export interface DeviceIdentityShape {
  /** This Device; the first call makes its id, name and certificate and stores them. */
  readonly get: Effect.Effect<LocalDeviceRecord>;
  /** Changes the display name; a blank or overlong name is refused (`InvalidName`). */
  readonly rename: (name: string) => Effect.Effect<LocalDeviceRecord, DevicesError>;
  /** Stores whether this Device hosts. Opening or closing the listener is `Hosting`'s job. */
  readonly setHosting: (on: boolean) => Effect.Effect<LocalDeviceRecord>;
}

/** The Local device's identity in `<userData>/spence/device.json`. Main is the only writer. */
export class DeviceIdentity extends Context.Service<DeviceIdentity, DeviceIdentityShape>()(
  'devices/DeviceIdentity',
) {}

const defaultName = (): string => hostname().trim().slice(0, DEVICE_NAME_MAX) || 'Spence';

const withFingerprint = (stored: StoredDevice): LocalDeviceRecord => ({
  ...stored,
  fingerprint: fingerprintOf(stored.certificate),
});

export const layerDeviceIdentity = Layer.effect(
  DeviceIdentity,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Semaphore.make(1);
    let cached: Option.Option<LocalDeviceRecord> = Option.none();

    const create = Effect.gen(function* () {
      const id = DeviceId.make(randomUUID());
      const { certificate, privateKey } = yield* generateCertificate(id);
      const stored: StoredDevice = {
        id,
        name: defaultName(),
        hosting: false,
        certificate,
        privateKey,
      };
      yield* store.writeVersioned(deviceFile, stored);
      return stored;
    });

    const load = Effect.gen(function* () {
      if (Option.isSome(cached)) return cached.value;
      const stored = (yield* toWireDefect(store.readVersioned(deviceFile))) ?? (yield* create);
      const record = withFingerprint(stored);
      cached = Option.some(record);
      return record;
    });

    const save = Effect.fnUntraced(function* (change: Partial<StoredDevice>) {
      const { fingerprint: _derived, ...current } = yield* load;
      const next = { ...current, ...change };
      yield* store.writeVersioned(deviceFile, next);
      const record = withFingerprint(next);
      cached = Option.some(record);
      return record;
    });

    return {
      get: lock.withPermit(load),
      rename: (name) => {
        const trimmed = name.trim();
        return trimmed === '' || trimmed.length > DEVICE_NAME_MAX
          ? Effect.fail(
              new DevicesError({
                reason: 'InvalidName',
                detail: `A Device name has 1 to ${DEVICE_NAME_MAX} characters.`,
              }),
            )
          : lock.withPermit(save({ name: trimmed }));
      },
      setHosting: (on) => lock.withPermit(save({ hosting: on })),
    };
  }),
);

/** The identity over `<userData>/spence/`. */
export const layerDeviceIdentityLive = layerDeviceIdentity.pipe(Layer.provide(layerStoreUserData));
