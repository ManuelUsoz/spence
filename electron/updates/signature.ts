import { Schema } from 'effect';
import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  type UpdateArtifact,
  UpdateManifest,
  type UpdateTarget as UpdateTargetValue,
} from '../../src/shared/updates/manifest';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A public key as a `KeyObject`, from the base64 raw 32-byte form kept in `public-key.ts`. */
export const ed25519PublicKey = (rawBase64: string) => {
  const raw = Buffer.from(rawBase64, 'base64');
  if (raw.length !== 32) return null;
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
};

/**
 * Verifies the detached Ed25519 signature over the exact bytes of `update-manifest.json`. A changed byte, a
 * signature made with another key, or a manifest from another release all fail here. This runs before anything
 * in the manifest is trusted, including the artifact URL and its SHA-512.
 */
export const verifyManifestSignature = (
  publicKeyBase64: string,
  manifestBytes: Uint8Array,
  signatureBase64: string,
): boolean => {
  try {
    const signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length !== 64) return false;
    const key = ed25519PublicKey(publicKeyBase64);
    return key !== null && verify(null, manifestBytes, key, signature);
  } catch {
    return false;
  }
};

/** Decodes a verified manifest; `null` when it is not the shape Spence ships. */
export const decodeManifest = (text: string): UpdateManifest | null => {
  try {
    const json: unknown = JSON.parse(text);
    return Schema.decodeUnknownSync(UpdateManifest)(json);
  } catch {
    return null;
  }
};

/** base64 SHA-512, the form electron-builder and the release scripts write. */
export const sha512Base64 = (bytes: Uint8Array): string =>
  createHash('sha512').update(bytes).digest('base64');

/** The artifact this machine runs, or `null` when the release does not package it. */
export const artifactFor = (
  manifest: UpdateManifest,
  target: UpdateTargetValue,
): UpdateArtifact | null => manifest.artifacts[target] ?? null;

/** The release asset's file name, from its signed URL. */
export const fileNameOf = (url: string): string | null => {
  try {
    const name = new URL(url).pathname.split('/').pop();
    return name === undefined || name === '' ? null : name;
  } catch {
    return null;
  }
};

/** The target this build installs, or `null` where Spence does not ship a package. */
export const currentTarget = (platform: string, arch: string): UpdateTargetValue | null => {
  if (arch !== 'x64') return null;
  if (platform === 'win32') return 'win-x64';
  if (platform === 'linux') return 'linux-x64';
  return null;
};
