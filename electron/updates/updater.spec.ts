import { describe, expect, it } from 'vitest';
import { Effect, Layer, Stream } from 'effect';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdatesError } from '../../src/shared/updates/updates.rpc';
import { layerStore } from '../store/store';
import { UpdateInstaller } from './installer';
import { sha512Base64 } from './signature';
import { UpdateTransport, UpdateTransportError } from './transport';
import { makeUpdates } from './updater';

describe('updates', () => {
  it('rejects unsigned metadata before downloading or installing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { publicKey } = generateKeyPairSync('ed25519');
      const der = publicKey.export({ type: 'spki', format: 'der' });
      let downloads = 0;
      let installs = 0;
      const dependencies = Layer.mergeAll(
        layerStore(root),
        Layer.succeed(UpdateTransport, {
          releases: Effect.succeed([
            {
              version: '1.0.1-beta.1',
              prerelease: true,
              manifestUrl: 'manifest',
              signatureUrl: 'signature',
            },
          ]),
          text: (url) =>
            Effect.succeed(url === 'manifest' ? '{}' : Buffer.alloc(64).toString('base64')),
          download: () =>
            Effect.sync(() => {
              downloads += 1;
              return { totalBytes: 0, chunks: Stream.empty };
            }),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.void,
          apply: Effect.suspend(() => {
            installs += 1;
            return Effect.fail(
              new UpdatesError({ reason: 'NotReady', detail: 'Installer failed' }),
            );
          }),
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const updates = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: der.subarray(der.length - 32).toString('base64'),
            target: 'win-x64',
            channel: 'beta',
          });
          expect(yield* updates.check).toMatchObject({
            _tag: 'Failed',
            reason: 'VerificationFailed',
          });
          expect(downloads).toBe(0);
          expect(installs).toBe(0);
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['valid', 'altered', 'retry'] as const)('handles a %s download', async (scenario) => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const der = publicKey.export({ type: 'spki', format: 'der' });
      const key = der.subarray(der.length - 32).toString('base64');
      const artifact = Buffer.from('test artifact');
      const manifest = JSON.stringify({
        version: '1.0.1-beta.1',
        channel: 'beta',
        releasedAt: '2026-01-01',
        releaseUrl: 'https://example.com/release',
        releaseNotes: 'Notes',
        knownIssues: 'None',
        artifacts: {
          'win-x64': {
            url: 'https://example.com/update.exe',
            sha512: sha512Base64(artifact),
            sizeBytes: artifact.length,
          },
          'linux-x64': {
            url: 'https://example.com/update.AppImage',
            sha512: sha512Base64(artifact),
            sizeBytes: artifact.length,
          },
        },
      });
      const signature = sign(null, Buffer.from(manifest), privateKey).toString('base64');
      let installs = 0;
      let downloads = 0;
      const dependencies = Layer.mergeAll(
        layerStore(root),
        Layer.succeed(UpdateTransport, {
          releases: Effect.succeed([
            {
              version: '1.0.1-beta.1',
              prerelease: true,
              manifestUrl: 'manifest',
              signatureUrl: 'signature',
            },
          ]),
          text: (url) => Effect.succeed(url === 'manifest' ? manifest : signature),
          download: () =>
            Effect.suspend(() => {
              downloads += 1;
              return scenario === 'retry' && downloads === 1
                ? Effect.fail(new UpdateTransportError({ reason: 'Offline', detail: 'offline' }))
                : Effect.succeed({
                    totalBytes: artifact.length,
                    chunks: Stream.make(
                      scenario === 'altered' ? Buffer.from('bad artifact!') : artifact,
                    ),
                  });
            }),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.void,
          apply: Effect.suspend(() => {
            installs += 1;
            return Effect.fail(
              new UpdatesError({ reason: 'NotReady', detail: 'Installer failed' }),
            );
          }),
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const updates = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: key,
            target: 'win-x64',
            channel: 'beta',
          });
          let checked = yield* updates.check;
          if (scenario === 'retry') {
            expect(checked).toMatchObject({ _tag: 'Failed', reason: 'DownloadFailed' });
            checked = yield* updates.check;
          }
          if (scenario === 'altered') {
            expect(checked).toMatchObject({ _tag: 'Failed', reason: 'VerificationFailed' });
            expect(yield* Effect.exit(updates.restart)).toMatchObject({ _tag: 'Failure' });
            expect(installs).toBe(0);
            return;
          }
          expect(checked._tag, JSON.stringify(checked)).toBe('Ready');
          yield* updates.restart;
          yield* updates.cancelRestart;
          expect(yield* updates.applyPending).toBe(false);
          expect((yield* updates.state)._tag).toBe('Ready');
          expect(installs).toBe(0);
          yield* updates.restart;
          expect(yield* Effect.exit(updates.applyPending)).toMatchObject({ _tag: 'Failure' });
          expect(yield* updates.state).toMatchObject({ _tag: 'Failed', reason: 'InstallFailed' });
          expect(installs).toBe(1);
          expect(yield* updates.applyPending).toBe(false);
          expect((yield* updates.check)._tag).toBe('Ready');
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
