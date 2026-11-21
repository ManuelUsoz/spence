import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decodeManifest, verifyManifestSignature } from '../electron/updates/signature';

test('offline keygen, signing, and verification reject changed metadata and artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spence-sign-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'spence-keygen-'));
  try {
    // Refuses to write inside the repository tree.
    const insideRepo = spawnSync(
      process.execPath,
      [resolve('scripts/offline-update-keygen.mjs'), resolve('release')],
      { encoding: 'utf8' },
    );
    expect(insideRepo.status).not.toBe(0);

    const keygen = spawnSync(
      process.execPath,
      [resolve('scripts/offline-update-keygen.mjs'), keyDir],
      { encoding: 'utf8' },
    );
    expect(keygen.status).toBe(0);
    expect(keygen.stdout).not.toContain('PRIVATE KEY');
    const rawKey = keygen.stdout.trim().split('\n').pop()?.trim() ?? '';
    expect(Buffer.from(rawKey, 'base64')).toHaveLength(32);

    // Refuses to overwrite an existing keypair.
    expect(
      spawnSync(process.execPath, [resolve('scripts/offline-update-keygen.mjs'), keyDir], {
        encoding: 'utf8',
      }).status,
    ).not.toBe(0);

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
    expect(run('sign', dir, join(keyDir, 'private.pem')).status).toBe(0);
    expect(readFileSync(join(dir, 'update-manifest.json'))).toEqual(manifest);
    const signature = readFileSync(join(dir, 'update-manifest.sig'), 'utf8').trim();
    expect(verifyManifestSignature(rawKey, manifest, signature)).toBe(true);
    expect(decodeManifest(manifest.toString('utf8'))?.version).toBe('1.0.0-beta.1');
    expect(run('verify', dir, join(keyDir, 'public.pem')).status).toBe(0);
    writeFileSync(join(dir, 'update-manifest.json'), Buffer.concat([manifest, Buffer.from(' ')]));
    expect(run('verify', dir, join(keyDir, 'public.pem')).status).not.toBe(0);
    writeFileSync(join(dir, 'update-manifest.json'), manifest);
    writeFileSync(join(dir, 'app.exe'), 'tampered');
    expect(run('verify', dir, join(keyDir, 'public.pem')).status).not.toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});
