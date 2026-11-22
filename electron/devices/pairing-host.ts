import {
  Context,
  Duration,
  Effect,
  FiberHandle,
  Layer,
  Option,
  Semaphore,
  type Stream,
  SubscriptionRef,
} from 'effect';
import { DevicesError, type PairingWindow } from '../../src/shared/devices/devices.rpc';
import { LanConfig } from '../lan/config';
import type { PairReply, PairRequest } from '../lan/pairing-wire';
import { deviceIdOf, fingerprintOf } from './certificate';
import { DeviceIdentity } from './identity';
import { PairedDevices } from './paired-devices';
import { hostProof, issueToken, makePairingCode, sameDigest, viewerProof } from './pairing-proof';
import { SecretStorage } from './secret-storage';

/** How long a pairing code stays open. */
export const PAIRING_CODE_TTL = Duration.minutes(2);
/** Wrong codes after which the window closes. */
export const PAIRING_MAX_ATTEMPTS = 3;

export interface PairingHostShape {
  readonly current: Effect.Effect<PairingWindow>;
  /** The window now, then after every change. */
  readonly changes: Stream.Stream<PairingWindow>;
  /** Shows a fresh code, replacing an open one. Refused when secrets cannot be stored safely. */
  readonly open: Effect.Effect<PairingWindow, DevicesError>;
  /** Closes the code, if one is open. */
  readonly close: Effect.Effect<void>;
  /**
   * The hosting side of the ceremony, for the one unauthenticated request a listener serves. `remoteHost` is
   * where the request came from: with the viewer's port, the address hint for reaching it later.
   */
  readonly accept: (
    request: PairRequest,
    remoteHost: string | undefined,
  ) => Effect.Effect<PairReply>;
}

/** The hosting side of Pairing: one code at a time, single use, closed on expiry or after too many wrong tries. */
export class PairingHost extends Context.Service<PairingHost, PairingHostShape>()(
  'devices/PairingHost',
) {}

const refused = (reason: Extract<PairReply, { _tag: 'Refused' }>['reason'], detail: string) =>
  ({ _tag: 'Refused', reason, detail }) as const;

/** `host:port` for an address hint; IPv6 in brackets, IPv4-mapped IPv6 as plain IPv4. */
const addressHint = (host: string | undefined, port: number | null): string | null => {
  if (host === undefined || port === null) return null;
  const plain = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  return plain.includes(':') ? `[${plain}]:${port}` : `${plain}:${port}`;
};

const fingerprintOrUndefined = (certificate: string): string | undefined => {
  try {
    return fingerprintOf(certificate);
  } catch {
    return undefined;
  }
};

export const layerPairingHost = Layer.effect(
  PairingHost,
  Effect.gen(function* () {
    const identity = yield* DeviceIdentity;
    const paired = yield* PairedDevices;
    const secrets = yield* SecretStorage;
    const config = yield* LanConfig;
    const lock = yield* Semaphore.make(1);
    const expiry = yield* FiberHandle.make();
    const window = yield* SubscriptionRef.make<PairingWindow>({ _tag: 'Idle' });
    let attempts = 0;

    const settle = Effect.fnUntraced(function* (next: PairingWindow) {
      yield* FiberHandle.clear(expiry);
      yield* SubscriptionRef.set(window, next);
    });

    const open = lock.withPermit(
      Effect.gen(function* () {
        if (!(yield* secrets.available)) {
          return yield* new DevicesError({
            reason: 'SecretStorageUnavailable',
            detail: 'The OS cannot store secrets safely on this Device.',
          });
        }
        const code = makePairingCode();
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const opened: PairingWindow = {
          _tag: 'Open',
          code,
          expiresAt: now + Duration.toMillis(PAIRING_CODE_TTL),
        };
        attempts = 0;
        yield* SubscriptionRef.set(window, opened);
        yield* FiberHandle.run(
          expiry,
          Effect.sleep(PAIRING_CODE_TTL).pipe(
            Effect.andThen(
              lock.withPermit(
                SubscriptionRef.update(window, (current) =>
                  current._tag === 'Open' && current.code === code
                    ? ({ _tag: 'Expired' } as const)
                    : current,
                ),
              ),
            ),
          ),
        );
        return opened;
      }),
    );

    const accept = (request: PairRequest, remoteHost: string | undefined) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (request.protocolVersion !== config.protocolVersion) {
            return { _tag: 'VersionMismatch', protocolVersion: config.protocolVersion } as const;
          }
          const current = yield* SubscriptionRef.get(window);
          if (current._tag !== 'Open') return refused('NoCode', 'No pairing code is open.');
          if (!(yield* secrets.available)) {
            return refused('SecretStorageUnavailable', 'The host cannot store secrets safely.');
          }
          const local = yield* identity.get;
          if (request.deviceId === local.id) return refused('SelfPair', 'That is this Device.');
          const viewerFingerprint = fingerprintOrUndefined(request.certificate);
          if (
            viewerFingerprint === undefined ||
            deviceIdOf(request.certificate) !== request.deviceId
          ) {
            return refused('Rejected', 'The certificate does not carry this Device id.');
          }

          const expected = viewerProof(current.code, {
            hostFingerprint: local.fingerprint,
            viewerFingerprint,
            deviceId: request.deviceId,
          });
          if (!sameDigest(expected, request.proof)) {
            attempts += 1;
            if (attempts >= PAIRING_MAX_ATTEMPTS) {
              yield* settle({ _tag: 'TooManyAttempts' });
              return refused('WrongCode', 'Wrong code; the code is now closed.');
            }
            return refused('WrongCode', 'Wrong code.');
          }

          const known = yield* paired.certificateOf(request.deviceId);
          if (Option.isSome(known) && fingerprintOf(known.value) !== viewerFingerprint) {
            return refused('AlreadyPaired', 'This Device id is paired with another certificate.');
          }

          const token = issueToken();
          yield* paired.save({
            id: request.deviceId,
            name: request.name,
            address: addressHint(remoteHost, request.port),
            certificate: request.certificate,
            issuedToken: token,
            receivedToken: request.token,
          });
          yield* settle({ _tag: 'Paired', name: request.name });
          return {
            _tag: 'Paired',
            deviceId: local.id,
            name: local.name,
            token,
            proof: hostProof(current.code, {
              hostFingerprint: local.fingerprint,
              viewerFingerprint,
              deviceId: local.id,
            }),
          } as const;
        }),
      );

    return {
      current: SubscriptionRef.get(window),
      changes: SubscriptionRef.changes(window),
      open,
      close: lock.withPermit(settle({ _tag: 'Idle' })),
      accept,
    };
  }),
);
