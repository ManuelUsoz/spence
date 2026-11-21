import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit, Fiber, Layer, Scope, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { RpcTest } from 'effect/rpc';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UpdatesError, UpdatesRpcs, type UpdateState } from '../../src/shared/updates/updates.rpc';
import { layerStore } from '../store/store';
import { makeUpdatesHandlers } from './handlers';
import { appImageNotWritable, UpdateInstaller } from './installer';
import { sha512Base64 } from './signature';
import { UpdateTransport, UpdateTransportError, type FeedRelease } from './transport';
import { makeUpdates, startUpdateSchedule, Updates } from './updater';

const makeKeypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return {
    privateKey,
    publicKeyBase64: der.subarray(der.length - 32).toString('base64'),
  };
};

const signRelease = (privateKey: KeyObject, version: string, artifact: Buffer) => {
  const manifest = JSON.stringify({
    version,
    channel: 'beta',
    releasedAt: '2026-01-01T00:00:00Z',
    releaseUrl: `https://example.com/releases/v${version}`,
    releaseNotes: `Notes for ${version}`,
    knownIssues: 'Windows installer is unsigned.',
    artifacts: {
      'win-x64': {
        url: `https://example.com/Spence-${version}.exe`,
        sha512: sha512Base64(artifact),
        sizeBytes: artifact.length,
      },
      'linux-x64': {
        url: `https://example.com/Spence-${version}.AppImage`,
        sha512: sha512Base64(artifact),
        sizeBytes: artifact.length,
      },
    },
  });
  return {
    manifest,
    signature: sign(null, Buffer.from(manifest), privateKey).toString('base64'),
  };
};

describe('updates', () => {
  it('rejects unsigned metadata before downloading or installing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { publicKeyBase64 } = makeKeypair();
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
            publicKey: publicKeyBase64,
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
      const { privateKey, publicKeyBase64 } = makeKeypair();
      const artifact = Buffer.from('test artifact');
      const { manifest, signature } = signRelease(privateKey, '1.0.1-beta.1', artifact);
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
            publicKey: publicKeyBase64,
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

  it('fails closed when publicKey is empty or target is unsupported', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { publicKeyBase64 } = makeKeypair();
      let feedCalls = 0;
      const dependencies = Layer.mergeAll(
        layerStore(root),
        Layer.succeed(UpdateTransport, {
          releases: Effect.sync(() => {
            feedCalls += 1;
            return [];
          }),
          text: () => Effect.die('unused'),
          download: () => Effect.die('unused'),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.void,
          apply: Effect.succeed(false),
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const emptyKey = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: '',
            target: 'win-x64',
            channel: 'beta',
          });
          expect(yield* emptyKey.check).toMatchObject({
            _tag: 'Failed',
            reason: 'Unsupported',
          });

          const noTarget = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: publicKeyBase64,
            target: null,
            channel: 'beta',
          });
          expect(yield* noTarget.check).toMatchObject({
            _tag: 'Failed',
            reason: 'Unsupported',
          });
          expect(feedCalls).toBe(0);
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a newer stable release on beta and prevents downgrades over newer Store history', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { privateKey, publicKeyBase64 } = makeKeypair();
      const artifact = Buffer.from('stable-bytes');
      const stable = signRelease(privateKey, '1.2.0', artifact);
      const older = signRelease(privateKey, '1.1.0', artifact);
      let currentReleases: ReadonlyArray<FeedRelease> = [
        {
          version: '1.2.0',
          prerelease: false,
          manifestUrl: 'm-1.2.0',
          signatureUrl: 's-1.2.0',
        },
      ];
      const dependencies = Layer.mergeAll(
        layerStore(root),
        Layer.succeed(UpdateTransport, {
          releases: Effect.sync(() => currentReleases),
          text: (url) =>
            Effect.succeed(
              url === 'm-1.2.0'
                ? stable.manifest
                : url === 's-1.2.0'
                  ? stable.signature
                  : url === 'm-1.1.0'
                    ? older.manifest
                    : older.signature,
            ),
          download: () =>
            Effect.succeed({
              totalBytes: artifact.length,
              chunks: Stream.make(artifact),
            }),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.void,
          apply: Effect.succeed(false),
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          // A beta installation sees and verifies a newer stable release (1.2.0 > 1.0.0-beta.2).
          const betaUpdater = yield* makeUpdates({
            currentVersion: '1.0.0-beta.2',
            publicKey: publicKeyBase64,
            target: 'linux-x64',
            channel: 'beta',
          });
          const ready = yield* betaUpdater.check;
          expect(ready).toMatchObject({ _tag: 'Ready', info: { version: '1.2.0' } });

          // A second run on the same Store running an older build (1.0.0) refuses to downgrade to 1.1.0 < 1.2.0.
          currentReleases = [
            {
              version: '1.1.0',
              prerelease: false,
              manifestUrl: 'm-1.1.0',
              signatureUrl: 's-1.1.0',
            },
          ];
          const downgradedUpdater = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: publicKeyBase64,
            target: 'linux-x64',
            channel: 'beta',
          });
          expect(yield* downgradedUpdater.check).toMatchObject({ _tag: 'UpToDate' });
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('transitions to NotWritable when Linux AppImage replacement is blocked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { privateKey, publicKeyBase64 } = makeKeypair();
      const artifact = Buffer.from('linux-appimage');
      const { manifest, signature } = signRelease(privateKey, '1.0.1-beta.1', artifact);
      const target = '/opt/Spence/Spence.AppImage';
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
            Effect.succeed({
              totalBytes: artifact.length,
              chunks: Stream.make(artifact),
            }),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.fail(appImageNotWritable(target)),
          apply: Effect.succeed(false),
        }),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const updates = yield* makeUpdates({
            currentVersion: '1.0.0',
            publicKey: publicKeyBase64,
            target: 'linux-x64',
            channel: 'beta',
          });
          expect((yield* updates.check)._tag).toBe('Ready');
          const restartExit = yield* Effect.exit(updates.restart);
          expect(restartExit._tag).toBe('Failure');
          if (Exit.isFailure(restartExit)) {
            expect(Cause.squash(restartExit.cause)).toEqual(appImageNotWritable(target));
          }
          expect(yield* updates.state).toMatchObject({
            _tag: 'Failed',
            reason: 'NotWritable',
            info: { version: '1.0.1-beta.1' },
          });
        }).pipe(Effect.provide(dependencies)),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.effect('checks at startup and every 24 hours without dropping an active download', () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-update-')));
      let checks = 0;
      const dependencies = Layer.mergeAll(
        layerStore(root),
        Layer.succeed(UpdateTransport, {
          releases: Effect.sync(() => {
            checks += 1;
            return [];
          }),
          text: () => Effect.die('unused'),
          download: () => Effect.die('unused'),
        }),
        Layer.succeed(UpdateInstaller, {
          prepare: () => Effect.void,
          apply: Effect.succeed(false),
        }),
      );
      const { publicKeyBase64 } = makeKeypair();
      yield* Effect.gen(function* () {
        const updates = yield* makeUpdates({
          currentVersion: '1.0.0',
          publicKey: publicKeyBase64,
          target: 'win-x64',
          channel: 'beta',
        });
        const scope = yield* Scope.make();
        yield* startUpdateSchedule(updates, scope);
        yield* TestClock.adjust('1 millis');
        expect(checks).toBe(1);
        yield* TestClock.adjust('24 hours');
        expect(checks).toBe(2);
        yield* Scope.close(scope, Exit.void);
      }).pipe(
        Effect.provide(dependencies),
        Effect.ensuring(Effect.promise(() => rm(root, { recursive: true, force: true }))),
      );
    }),
  );

  it('streams download progress and triggers quit through UpdatesRpcs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spence-update-'));
    try {
      const { privateKey, publicKeyBase64 } = makeKeypair();
      const firstChunk = Buffer.from('first-');
      const secondChunk = Buffer.from('second');
      const artifact = Buffer.concat([firstChunk, secondChunk]);
      const { manifest, signature } = signRelease(privateKey, '1.0.1-beta.1', artifact);
      let quits = 0;
      const updatesLayer = Layer.effect(
        Updates,
        makeUpdates({
          currentVersion: '1.0.0',
          publicKey: publicKeyBase64,
          target: 'win-x64',
          channel: 'beta',
        }),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
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
                Effect.succeed({
                  totalBytes: artifact.length,
                  chunks: Stream.make(firstChunk, secondChunk),
                }),
            }),
            Layer.succeed(UpdateInstaller, {
              prepare: () => Effect.void,
              apply: Effect.succeed(false),
            }),
          ),
        ),
      );
      const handlersLayer = makeUpdatesHandlers(() => {
        quits += 1;
      }).pipe(Layer.provide(updatesLayer));

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* RpcTest.makeClient(UpdatesRpcs);
            const watched: UpdateState[] = [];
            const watcher = yield* client['Updates.watch']().pipe(
              Stream.takeUntil((state) => state._tag === 'Ready'),
              Stream.runCollect,
              Effect.forkChild,
            );
            // Allow the stream subscription to register before checking.
            yield* Effect.yieldNow;
            const checked = yield* client['Updates.check']();
            expect(checked._tag).toBe('Ready');
            watched.push(...(yield* Fiber.join(watcher)));
            expect(watched.some((state) => state._tag === 'Checking')).toBe(true);
            expect(
              watched.some(
                (state) =>
                  state._tag === 'Downloading' && state.receivedBytes === firstChunk.length,
              ),
            ).toBe(true);
            expect(watched.at(-1)?._tag).toBe('Ready');

            yield* client['Updates.restart']();
            expect(quits).toBe(1);
          }).pipe(Effect.provide(handlersLayer)),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
