import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Option } from 'effect';
import { layerStore } from '../store/store';
import { layerPathSources } from './merged-path';
import {
  AgentRuntime,
  layerAgentRuntime,
  MANAGED_NODE_VERSION,
  type RuntimeArchiveError,
  RuntimeArchiveSource,
  runtimeSpecFor,
  stripAppImageEnv,
  stripNpmConfigEnv,
} from './runtime';

let root = '';
let fixtures = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'spence-runtime-root-'));
  fixtures = await mkdtemp(join(tmpdir(), 'spence-runtime-fix-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(fixtures, { recursive: true, force: true });
});

const isWindows = process.platform === 'win32';

/** Builds a realistic portable Node fixture archive + SHA-256 manifest matching the host OS/arch. */
const createFixtureArchive = async (
  overrideHash?: string,
): Promise<{
  readonly archivePath: string;
  readonly shasumsText: string;
  readonly spec: NonNullable<ReturnType<typeof runtimeSpecFor>>;
}> => {
  const spec = runtimeSpecFor(MANAGED_NODE_VERSION, process.platform, process.arch);
  if (spec === undefined)
    throw new Error(`Unsupported test host: ${process.platform}/${process.arch}`);
  const folderName = spec.filename.replace(/\.(tar\.gz|zip)$/, '');
  const stage = join(fixtures, 'src');
  const top = join(stage, folderName);
  const nodeRel = isWindows ? 'node.exe' : join('bin', 'node');
  const npmRel = isWindows
    ? join('node_modules', 'npm', 'bin', 'npm-cli.js')
    : join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(join(top, isWindows ? '' : 'bin'), { recursive: true });
  await mkdir(
    join(
      top,
      isWindows ? join('node_modules', 'npm', 'bin') : join('lib', 'node_modules', 'npm', 'bin'),
    ),
    {
      recursive: true,
    },
  );
  await writeFile(join(top, nodeRel), '#!/bin/sh\necho node\n', { mode: 0o755 });
  await writeFile(join(top, npmRel), '// stub npm-cli\n', { mode: 0o644 });

  const archivePath = join(fixtures, spec.filename);
  const tarCmd = isWindows ? 'tar.exe' : 'tar';
  const args = isWindows
    ? ['-a', '-cf', archivePath, '-C', stage, folderName]
    : ['-czf', archivePath, '-C', stage, folderName];
  const res = spawnSync(tarCmd, args, { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`tar failed (${res.status}): ${res.stderr}`);
  }
  const bytes = await readFile(archivePath);
  const sha256 = overrideHash ?? createHash('sha256').update(bytes).digest('hex');
  const shasumsText = `${sha256}  ${spec.filename}\n`;
  return { archivePath, shasumsText, spec };
};

const listRuntimeEntries = async (): Promise<ReadonlyArray<string>> => {
  try {
    return await readdir(join(root, 'runtime'));
  } catch {
    return [];
  }
};

describe('AgentRuntime', () => {
  it.effect(
    'downloads once, verifies SHA-256, extracts atomically via staging, and caches on inspect',
    () =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => createFixtureArchive());
        let fetches = 0;
        const source = Layer.succeed(RuntimeArchiveSource, {
          fetch: (_spec, destPath) =>
            Effect.promise(async () => {
              fetches += 1;
              await writeFile(destPath, await readFile(fixture.archivePath));
              return { shasumsText: fixture.shasumsText };
            }),
        });
        const layer = layerAgentRuntime.pipe(
          Layer.provide(source),
          Layer.provide(layerStore(root)),
          Layer.provide(layerPathSources),
        );

        yield* Effect.gen(function* () {
          const runtime = yield* AgentRuntime;
          expect(Option.isNone(yield* runtime.inspect)).toBe(true);

          const paths = yield* runtime.ensure;
          expect(paths.version).toBe(MANAGED_NODE_VERSION);
          expect(fetches).toBe(1);

          const nodeStats = yield* Effect.promise(() => stat(paths.node));
          const npmStats = yield* Effect.promise(() => stat(paths.npmCli));
          expect(nodeStats.isFile()).toBe(true);
          expect(npmStats.isFile()).toBe(true);

          // Staging directory was cleaned up after atomic swap.
          const entries = yield* Effect.promise(listRuntimeEntries);
          expect(entries).toEqual([`node-${MANAGED_NODE_VERSION}`]);

          // Second ensure and inspect reuse the installed runtime without re-fetching.
          const inspected = yield* runtime.inspect;
          expect(Option.getOrUndefined(inspected)).toEqual(paths);
          expect(yield* runtime.ensure).toEqual(paths);
          expect(fetches).toBe(1);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect('fails with ChecksumMismatch and cleans staging without creating runtime dir', () =>
    Effect.gen(function* () {
      const badHash = '0'.repeat(64);
      const fixture = yield* Effect.promise(() => createFixtureArchive(badHash));
      const source = Layer.succeed(RuntimeArchiveSource, {
        fetch: (_spec, destPath) =>
          Effect.promise(async () => {
            await writeFile(destPath, await readFile(fixture.archivePath));
            return { shasumsText: fixture.shasumsText };
          }),
      });
      const layer = layerAgentRuntime.pipe(
        Layer.provide(source),
        Layer.provide(layerStore(root)),
        Layer.provide(layerPathSources),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const err = yield* runtime.ensure.pipe(Effect.flip);
        expect(err._tag).toBe('RuntimeArchiveError');
        expect(err.reason).toBe('ChecksumMismatch');
        expect(Option.isNone(yield* runtime.inspect)).toBe(true);
        expect(yield* Effect.promise(listRuntimeEntries)).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect('deduplicates concurrent runtime acquisitions into a single download', () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() => createFixtureArchive());
      const gate = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      let fetches = 0;

      const source = Layer.succeed(RuntimeArchiveSource, {
        fetch: (_spec, destPath) =>
          Effect.gen(function* () {
            fetches += 1;
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(gate);
            yield* Effect.promise(async () => {
              await writeFile(destPath, await readFile(fixture.archivePath));
            });
            return { shasumsText: fixture.shasumsText };
          }),
      });
      const layer = layerAgentRuntime.pipe(
        Layer.provide(source),
        Layer.provide(layerStore(root)),
        Layer.provide(layerPathSources),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const first = yield* Effect.forkChild(runtime.ensure);
        const second = yield* Effect.forkChild(runtime.ensure);
        yield* Deferred.await(started);
        yield* Deferred.succeed(gate, undefined);
        const [a, b] = yield* Effect.all([Fiber.join(first), Fiber.join(second)]);
        expect(a).toEqual(b);
        expect(fetches).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect('aborts in-flight download and cleans temp staging on interruption', () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let aborted = false;

      const source = Layer.succeed(RuntimeArchiveSource, {
        fetch: (_spec, destPath) =>
          Effect.promise(() => writeFile(destPath, 'partial')).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                aborted = true;
              }),
            ),
          ) as Effect.Effect<{ readonly shasumsText: string }, RuntimeArchiveError>,
      });
      const layer = layerAgentRuntime.pipe(
        Layer.provide(source),
        Layer.provide(layerStore(root)),
        Layer.provide(layerPathSources),
      );

      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        const fiber = yield* Effect.forkChild(runtime.ensure);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(fiber);
        expect(aborted).toBe(true);
        expect(Option.isNone(yield* runtime.inspect)).toBe(true);
        expect(yield* Effect.promise(listRuntimeEntries)).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );
});

describe('Environment hygiene helpers', () => {
  it('strips Linux AppImage runtime variables and APPDIR segments while preserving PATH and user libs', () => {
    const cleaned = stripAppImageEnv({
      PATH: '/usr/local/bin:/usr/bin',
      APPIMAGE: '/tmp/Spence.AppImage',
      APPDIR: '/tmp/.mount_Spence123',
      ARGV0: './Spence.AppImage',
      OWD: '/home/user',
      LD_LIBRARY_PATH: '/tmp/.mount_Spence123/usr/lib:/opt/custom/lib',
      XDG_DATA_DIRS: '/tmp/.mount_Spence123/usr/share:/usr/share',
    });
    expect(cleaned).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      LD_LIBRARY_PATH: '/opt/custom/lib',
      XDG_DATA_DIRS: '/usr/share',
    });
  });

  it('strips inherited NPM_CONFIG_PREFIX and conflicting npm_* variables', () => {
    const cleaned = stripNpmConfigEnv({
      PATH: '/usr/bin',
      HOME: '/home/user',
      NPM_CONFIG_PREFIX: '/usr/local',
      npm_config_prefix: '/home/user/.nvm/v20',
      npm_config_global: 'true',
      npm_execpath: '/usr/lib/npm.js',
    });
    expect(cleaned).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
    });
  });
});
