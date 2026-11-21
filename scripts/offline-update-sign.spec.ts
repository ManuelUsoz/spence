import { test, expect } from 'vitest';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeManifest, verifyManifestSignature } from '../electron/updates/signature';

test('offline release verification rejects changed metadata and artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spence-sign-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(dir, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(join(dir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    const artifact = Buffer.from('test artifact');
    writeFileSync(join(dir, 'app.exe'), artifact);
    writeFileSync(join(dir, 'app.AppImage'), artifact);
    const entry = (name: string) => ({
      url: `https://example.com/${name}`,
      sizeBytes: artifact.length,
      sha512: createHash('sha512').update(artifact).digest('base64'),
    });
    const manifest = Buffer.from(
      JSON.stringify(
        {
          version: '1.0.0-beta.1',
          channel: 'beta',
          releasedAt: '2026-01-01',
          releaseUrl: 'https://example.com/release',
          releaseNotes: '',
          knownIssues: '',
          artifacts: { 'win-x64': entry('app.exe'), 'linux-x64': entry('app.AppImage') },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, 'update-manifest.json'), manifest);
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [resolve('scripts/offline-update-sign.mjs'), ...args], {
        encoding: 'utf8',
      });
    expect(run('sign', dir, join(dir, 'private.pem')).status).toBe(0);
    expect(readFileSync(join(dir, 'update-manifest.json'))).toEqual(manifest);
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const rawKey = der.subarray(der.length - 32).toString('base64');
    const signature = readFileSync(join(dir, 'update-manifest.sig'), 'utf8').trim();
    expect(verifyManifestSignature(rawKey, manifest, signature)).toBe(true);
    expect(decodeManifest(manifest.toString('utf8'))?.version).toBe('1.0.0-beta.1');
    expect(run('verify', dir, join(dir, 'public.pem')).status).toBe(0);
    writeFileSync(join(dir, 'update-manifest.json'), Buffer.concat([manifest, Buffer.from(' ')]));
    expect(run('verify', dir, join(dir, 'public.pem')).status).not.toBe(0);
    writeFileSync(join(dir, 'update-manifest.json'), manifest);
    writeFileSync(join(dir, 'app.exe'), 'tampered');
    expect(run('verify', dir, join(dir, 'public.pem')).status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
