import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Option } from 'effect';
import { MergedPath, PathSources, layerMergedPath, type RegistryHive } from './merged-path';

interface Stub {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string>>;
  readonly registry?: Partial<Record<RegistryHive, string>>;
  readonly loginShell?: string;
}

const layerStub = (stub: Stub, reads: Array<string> = []) =>
  layerMergedPath.pipe(
    Layer.provide(
      Layer.succeed(PathSources, {
        platform: stub.platform,
        env: stub.env,
        readRegistryPath: (hive) =>
          Effect.sync(() => {
            reads.push(hive);
            return Option.fromNullishOr(stub.registry?.[hive]);
          }),
        readLoginShellPath: Effect.sync(() => {
          reads.push('shell');
          return Option.fromNullishOr(stub.loginShell);
        }),
      }),
    ),
  );

const merged = MergedPath.use((path) => path.get);
const refreshMerged = MergedPath.use((path) => path.refresh);

describe('MergedPath on Windows', () => {
  it.effect(
    'appends the machine then the user registry PATH to the process PATH, deduplicated',
    () =>
      merged.pipe(
        Effect.map((path) =>
          expect(path).toBe(
            'C:\\Windows;C:\\term-only;C:\\Program Files\\nodejs;C:\\Users\\me\\npm',
          ),
        ),
        Effect.provide(
          layerStub({
            platform: 'win32',
            env: { Path: 'C:\\Windows;C:\\term-only' },
            registry: {
              Machine: 'c:\\windows\\;C:\\Program Files\\nodejs',
              User: 'C:\\Users\\me\\npm;C:\\term-only',
            },
          }),
        ),
      ),
  );

  it.effect(
    'expands %VARS% from the environment, case-insensitively, and leaves unknown ones alone',
    () =>
      merged.pipe(
        Effect.map((path) =>
          expect(path).toBe('C:\\Windows;C:\\Users\\me\\AppData\\Roaming\\npm;%NOPE%\\bin'),
        ),
        Effect.provide(
          layerStub({
            platform: 'win32',
            env: { PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
            registry: { User: '%AppData%\\npm;%NOPE%\\bin' },
          }),
        ),
      ),
  );

  it.effect('keeps the process PATH when the registry has nothing', () =>
    merged.pipe(
      Effect.map((path) => expect(path).toBe('C:\\Windows')),
      Effect.provide(layerStub({ platform: 'win32', env: { PATH: 'C:\\Windows' } })),
    ),
  );

  it.effect('reads the registry once per run, never the login shell', () => {
    const reads: Array<string> = [];
    return Effect.gen(function* () {
      yield* merged;
      yield* merged;
      expect(reads.sort()).toEqual(['Machine', 'User']);
    }).pipe(Effect.provide(layerStub({ platform: 'win32', env: { PATH: 'C:\\Windows' } }, reads)));
  });

  it.effect('invalidates the cache on refresh and updates subsequent get calls', () => {
    let userPath = 'C:\\old-bin';
    const reads: Array<string> = [];
    const dynamicLayer = layerMergedPath.pipe(
      Layer.provide(
        Layer.succeed(PathSources, {
          platform: 'win32',
          env: { PATH: 'C:\\Windows' },
          readRegistryPath: (hive) =>
            Effect.sync(() => {
              reads.push(hive);
              return hive === 'User' ? Option.some(userPath) : Option.none();
            }),
          readLoginShellPath: Effect.succeed(Option.none()),
        }),
      ),
    );
    return Effect.gen(function* () {
      expect(yield* merged).toBe('C:\\Windows;C:\\old-bin');
      userPath = 'C:\\new-bin';
      // Cached get still returns the old PATH until refresh.
      expect(yield* merged).toBe('C:\\Windows;C:\\old-bin');
      expect(yield* refreshMerged).toBe('C:\\Windows;C:\\new-bin');
      expect(yield* merged).toBe('C:\\Windows;C:\\new-bin');
      expect(reads).toEqual(['Machine', 'User', 'Machine', 'User']);
    }).pipe(Effect.provide(dynamicLayer));
  });
});

describe('MergedPath on macOS and Linux', () => {
  it.effect('uses the login shell PATH', () =>
    merged.pipe(
      Effect.map((path) => expect(path).toBe('/opt/homebrew/bin:/usr/bin')),
      Effect.provide(
        layerStub({
          platform: 'darwin',
          env: { PATH: '/usr/bin' },
          loginShell: '/opt/homebrew/bin:/usr/bin',
        }),
      ),
    ),
  );

  it.effect('falls back to the process PATH when the shell gives nothing', () =>
    merged.pipe(
      Effect.map((path) => expect(path).toBe('/usr/bin:/bin')),
      Effect.provide(layerStub({ platform: 'linux', env: { PATH: '/usr/bin:/bin' } })),
    ),
  );

  it.effect('recomputes the login shell PATH on refresh', () => {
    let shellPath = '/usr/bin';
    const dynamicLayer = layerMergedPath.pipe(
      Layer.provide(
        Layer.succeed(PathSources, {
          platform: 'darwin',
          env: { PATH: '/bin' },
          readRegistryPath: () => Effect.succeed(Option.none()),
          readLoginShellPath: Effect.sync(() => Option.some(shellPath)),
        }),
      ),
    );
    return Effect.gen(function* () {
      expect(yield* merged).toBe('/usr/bin');
      shellPath = '/opt/antigravity/bin:/usr/bin';
      expect(yield* merged).toBe('/usr/bin');
      expect(yield* refreshMerged).toBe('/opt/antigravity/bin:/usr/bin');
      expect(yield* merged).toBe('/opt/antigravity/bin:/usr/bin');
    }).pipe(Effect.provide(dynamicLayer));
  });
});
