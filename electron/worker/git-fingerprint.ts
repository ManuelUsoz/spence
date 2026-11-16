import { createHash } from 'node:crypto';

/** Hashes supplied bytes; the caller is responsible for obtaining them safely. */
export const fingerprintBytes = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
