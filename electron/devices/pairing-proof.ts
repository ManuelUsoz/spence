import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PAIRING_CODE_LENGTH } from '../../src/shared/devices/devices.rpc';

/** A fresh pairing code: `PAIRING_CODE_LENGTH` random digits. */
export const makePairingCode = (): string =>
  randomInt(0, 10 ** PAIRING_CODE_LENGTH)
    .toString()
    .padStart(PAIRING_CODE_LENGTH, '0');

/** Whether `code` looks like a pairing code at all. */
export const isPairingCode = (code: string): boolean =>
  code.length === PAIRING_CODE_LENGTH && /^[0-9]+$/.test(code);

/** A bearer token: 256 random bits, no expiry. */
export const issueToken = (): string => randomBytes(32).toString('base64url');

/** What the issuing Device keeps of a token: never the token itself. */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** Compares two hex digests in constant time. */
export const sameDigest = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};

/** The two certificates a pairing ceremony binds together, and who is proving. */
export interface PairingBinding {
  /** SHA-256 fingerprint of the hosting Device's certificate, as the viewer saw it on the TLS connection. */
  readonly hostFingerprint: string;
  /** SHA-256 fingerprint of the certificate the viewer presents for itself. */
  readonly viewerFingerprint: string;
  /** The id of the Device making this proof. */
  readonly deviceId: string;
}

const hmac = (code: string, message: string): string =>
  createHmac('sha256', code).update(message, 'utf8').digest('hex');

/**
 * The viewer's proof that it knows the code, bound to the host certificate it actually connected to: a man in the
 * middle presenting its own certificate makes the host compute another value, so the attempt fails.
 */
export const viewerProof = (code: string, binding: PairingBinding): string =>
  hmac(
    code,
    `spence-pair/viewer|${binding.hostFingerprint}|${binding.viewerFingerprint}|${binding.deviceId}`,
  );

/** The host's answer: it knows the code too, so the viewer is not pairing with a stranger. */
export const hostProof = (code: string, binding: PairingBinding): string =>
  hmac(
    code,
    `spence-pair/host|${binding.hostFingerprint}|${binding.viewerFingerprint}|${binding.deviceId}`,
  );
