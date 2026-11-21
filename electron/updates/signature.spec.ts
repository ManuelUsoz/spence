import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { sha512Base64, verifyManifestSignature } from './signature';

describe('signed update verification', () => {
  it('accepts a signed manifest and rejects changes to its bytes or signature', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const key = der.subarray(der.length - 32).toString('base64');
    const manifest = Buffer.from('{"version":"1.0.0-beta.1"}');
    const signature = sign(null, manifest, privateKey).toString('base64');

    expect(verifyManifestSignature(key, manifest, signature)).toBe(true);
    expect(verifyManifestSignature(key, Buffer.from('changed'), signature)).toBe(false);
    expect(verifyManifestSignature(key, manifest, Buffer.alloc(64).toString('base64'))).toBe(false);
    expect(verifyManifestSignature('', manifest, signature)).toBe(false);
    expect(sha512Base64(Buffer.from('artifact'))).not.toBe(sha512Base64(Buffer.from('altered')));
  });
});
