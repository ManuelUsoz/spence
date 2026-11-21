import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildBetaManifest,
  releaseCommandArgs,
  UNSIGNED_WINDOWS_NOTICE,
  verifyReleaseStaging,
} from './beta-release.mjs';

describe('beta release preparation and verified publish', () => {
  it('prepares a manifest with unsigned Windows notice, signs offline, and builds a verified prerelease command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spence-release-'));
    const keyDir = mkdtempSync(join(tmpdir(), 'spence-keys-'));
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privatePem = join(keyDir, 'private.pem');
      const publicPem = join(keyDir, 'public.pem');
      writeFileSync(privatePem, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      writeFileSync(publicPem, publicKey.export({ type: 'spki', format: 'pem' }));

      writeFileSync(join(dir, 'Spence Setup 0.2.0-beta.1.exe'), 'win-installer-bytes');
      writeFileSync(join(dir, 'Spence-0.2.0-beta.1.AppImage'), 'linux-appimage-bytes');

      const manifest = buildBetaManifest({
        directory: dir,
        version: '0.2.0-beta.1',
        repo: 'ManuelUsoz/spence',
        releaseNotes: 'First public beta build.',
        knownIssues: 'Settings preview only.',
        releasedAt: '2026-11-21T12:00:00Z',
      });
      expect(manifest.channel).toBe('beta');
      expect(manifest.knownIssues).toContain(UNSIGNED_WINDOWS_NOTICE);
      writeFileSync(join(dir, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

      const signed = spawnSync(
        process.execPath,
        [resolve('scripts/offline-update-sign.mjs'), 'sign', dir, privatePem],
        { encoding: 'utf8' },
      );
      expect(signed.status).toBe(0);

      const verified = verifyReleaseStaging(dir, publicPem);
      const command = releaseCommandArgs(verified, 'ManuelUsoz/spence');
      expect(command.args).toContain('--prerelease');
      expect(command.args).toContain('Spence v0.2.0-beta.1 (Beta)');
      expect(command.notes).toContain(UNSIGNED_WINDOWS_NOTICE);

      // Dry-run CLI succeeds without touching GitHub, and refuses when a private key sits in staging.
      const dryRun = spawnSync(
        process.execPath,
        [resolve('scripts/beta-release.mjs'), 'publish', dir, publicPem, '--dry-run'],
        { encoding: 'utf8' },
      );
      expect(dryRun.status).toBe(0);
      expect(dryRun.stdout).toContain('--prerelease');

      writeFileSync(join(dir, 'leaked.pem'), readFileSync(privatePem));
      expect(() => verifyReleaseStaging(dir, publicPem)).toThrow(/private key/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    }
  });
});
