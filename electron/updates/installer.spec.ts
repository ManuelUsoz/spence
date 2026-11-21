import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appImageNotWritable, makeInstaller } from './installer';

describe('update installer', () => {
  it.effect('runs the Windows installer detached and returns false for relaunch', () =>
    Effect.gen(function* () {
      const launched: Array<{ file: string; args: ReadonlyArray<string> }> = [];
      const installer = makeInstaller({
        platform: 'win32',
        appImagePath: () => undefined,
        startDetached: (file, args) => {
          launched.push({ file, args });
          return Promise.resolve();
        },
      });
      yield* installer.prepare('C:/updates/Spence Setup.exe');
      expect(yield* installer.apply).toBe(false);
      expect(launched).toEqual([{ file: 'C:/updates/Spence Setup.exe', args: ['/S'] }]);
      // Pending install is cleared once applied.
      expect(yield* installer.apply).toBe(false);
    }),
  );

  it.effect('reports a Windows installer that cannot start', () =>
    Effect.gen(function* () {
      const installer = makeInstaller({
        platform: 'win32',
        appImagePath: () => undefined,
        startDetached: () => Promise.reject(new Error('launch failed')),
      });
      yield* installer.prepare('update.exe');
      const result = yield* Effect.exit(installer.apply);
      expect(result._tag).toBe('Failure');
    }),
  );

  it.effect('refuses Linux self-update when not running from an AppImage', () =>
    Effect.gen(function* () {
      const installer = makeInstaller({
        platform: 'linux',
        appImagePath: () => undefined,
        startDetached: () => Promise.resolve(),
      });
      const result = yield* Effect.exit(installer.prepare('/tmp/Spence.AppImage'));
      expect(result._tag).toBe('Failure');
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: 'UpdatesError',
          reason: 'NotPackaged',
        });
      }
    }),
  );

  it.effect('guides Linux users when the AppImage directory is not writable', () =>
    Effect.gen(function* () {
      const target = '/opt/Spence/Spence.AppImage';
      const installer = makeInstaller({
        platform: 'linux',
        appImagePath: () => target,
        startDetached: () => Promise.resolve(),
        canWriteDirectory: () => Promise.resolve(false),
      });
      const result = yield* Effect.exit(installer.prepare('/tmp/new.AppImage'));
      expect(result._tag).toBe('Failure');
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toEqual(appImageNotWritable(target));
      }
    }),
  );

  it('replaces a writable Linux AppImage and requests relaunch, or cleans up temp files on failure', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spence-installer-'));
    try {
      const target = path.join(dir, 'Spence.AppImage');
      const source = path.join(dir, 'downloaded.AppImage');
      await writeFile(target, 'old-appimage');
      await writeFile(source, 'new-appimage');

      const installer = makeInstaller({
        platform: 'linux',
        appImagePath: () => target,
        startDetached: () => Promise.resolve(),
        canWriteDirectory: () => Promise.resolve(true),
      });

      await Effect.runPromise(installer.prepare(source));
      const relaunch = await Effect.runPromise(installer.apply);
      expect(relaunch).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('new-appimage');
      expect((await readdir(dir)).filter((name) => name.includes('.updating-'))).toEqual([]);

      // Failure case: source missing leaves original target intact and removes any temp file.
      await rm(source);
      await Effect.runPromise(installer.prepare(source));
      const failed = await Effect.runPromise(Effect.exit(installer.apply));
      expect(failed._tag).toBe('Failure');
      expect(await readFile(target, 'utf8')).toBe('new-appimage');
      expect((await readdir(dir)).filter((name) => name.includes('.updating-'))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.effect('rejects unsupported platforms on prepare', () =>
    Effect.gen(function* () {
      const installer = makeInstaller({
        platform: 'darwin',
        appImagePath: () => undefined,
        startDetached: () => Promise.resolve(),
      });
      const result = yield* Effect.exit(installer.prepare('/tmp/Spence.dmg'));
      expect(result._tag).toBe('Failure');
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toMatchObject({
          _tag: 'UpdatesError',
          reason: 'NotPackaged',
        });
      }
    }),
  );
});
