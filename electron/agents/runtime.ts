import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema } from 'effect';
import { layerStoreUserData, Store } from '../store/store';
import { type Env, system32 } from './exec';
import { layerPathSources, PathSources } from './merged-path';
import { isLaunchable } from './resolve';
import { killChildProcessTree } from './spawn';

/** Pinned Node LTS release downloaded on demand for packaged (`npm`) ACP Adapters. */
export const MANAGED_NODE_VERSION = 'v22.14.0';

const NODE_DIST_BASE = 'https://nodejs.org/dist';

/** How a managed Node runtime archive is identified and fetched for `(platform, arch)`. */
export interface RuntimeArchiveSpec {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly filename: string;
  readonly url: string;
  readonly shasumsUrl: string;
}

/** Resolved executables inside `<userData>/spence/runtime/node-<version>/`. */
export interface ManagedRuntimePaths {
  readonly version: string;
  readonly dir: string;
  readonly node: string;
  readonly npmCli: string;
}

/** Failure acquiring or verifying Spence's managed Node runtime. */
export class RuntimeArchiveError extends Schema.TaggedError<RuntimeArchiveError>()(
  'RuntimeArchiveError',
  {
    reason: Schema.Literals([
      'UnsupportedPlatform',
      'DownloadFailed',
      'ChecksumMismatch',
      'ExtractionFailed',
    ]),
    detail: Schema.String,
  },
) {}

/** Filesystem error creating or atomically swapping a managed runtime or adapter directory. */
export class AgentInstallIoError extends Schema.TaggedError<AgentInstallIoError>()(
  'AgentInstallIoError',
  {
    reason: Schema.Literals(['Mkdir', 'Rename']),
    detail: Schema.String,
  },
) {}

/**
 * High-level runtime archive fetcher seam. Swapped in tests with local fixture archives + manifests; production
 * streams official archives and `SHASUMS256.txt` from nodejs.org.
 */
export class RuntimeArchiveSource extends Context.Service<
  RuntimeArchiveSource,
  {
    readonly fetch: (
      spec: RuntimeArchiveSpec,
      destPath: string,
    ) => Effect.Effect<{ readonly shasumsText: string }, RuntimeArchiveError>;
  }
>()('agents/RuntimeArchiveSource') {}

/** Manages Spence's isolated portable Node LTS runtime under `<userData>/spence/runtime/`. */
export class AgentRuntime extends Context.Service<
  AgentRuntime,
  {
    /** Checks without downloading whether the pinned runtime is already installed and launchable. */
    readonly inspect: Effect.Effect<Option.Option<ManagedRuntimePaths>>;
    /** Returns the pinned runtime paths, acquiring and SHA-256 verifying it once on demand. */
    readonly ensure: Effect.Effect<ManagedRuntimePaths, RuntimeArchiveError>;
  }
>()('agents/AgentRuntime') {}

const ARCHIVE_TARGETS: Readonly<Record<string, string>> = {
  'darwin:arm64': 'darwin-arm64.tar.gz',
  'darwin:x64': 'darwin-x64.tar.gz',
  'linux:x64': 'linux-x64.tar.gz',
  'linux:arm64': 'linux-arm64.tar.gz',
  'win32:x64': 'win-x64.zip',
  'win32:arm64': 'win-arm64.zip',
};

/** Official Node distribution archive descriptor for `(version, platform, arch)`, or `undefined` if unsupported. */
export const runtimeSpecFor = (
  version: string,
  platform: NodeJS.Platform,
  arch: string,
): RuntimeArchiveSpec | undefined => {
  const suffix = ARCHIVE_TARGETS[`${platform}:${arch}`];
  if (suffix === undefined) return undefined;
  const filename = `node-${version}-${suffix}`;
  return {
    version,
    platform,
    arch,
    filename,
    url: `${NODE_DIST_BASE}/${version}/${filename}`,
    shasumsUrl: `${NODE_DIST_BASE}/${version}/SHASUMS256.txt`,
  };
};

const APPIMAGE_VARS = new Set([
  'APPIMAGE',
  'APPDIR',
  'ARGV0',
  'OWD',
  'APPIMAGE_ORIGINAL_WORKDIR',
  'APPIMAGE_ORIG_LD_LIBRARY_PATH',
  'APPIMAGE_EXTRACT_AND_RUN',
]);

const APPIMAGE_PATH_VARS = new Set([
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'XDG_DATA_DIRS',
  'QT_PLUGIN_PATH',
  'GTK_PATH',
  'GI_TYPELIB_PATH',
  'GSETTINGS_SCHEMA_DIR',
  'PERLLIB',
  'PYTHONPATH',
  'PYTHONHOME',
]);

/**
 * Removes Linux AppImage runtime environment variables and `APPDIR`-mounted library/data path segments so child
 * processes (managed Node, npm, ACP adapters, Session terminals) do not resolve bundled AppImage libraries.
 */
export const stripAppImageEnv = (env: Env): Env => {
  const appDir = env['APPDIR'];
  const origLd = env['APPIMAGE_ORIG_LD_LIBRARY_PATH'];
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (APPIMAGE_VARS.has(key) || value === undefined) continue;
    if (key === 'LD_LIBRARY_PATH' && appDir !== undefined && origLd !== undefined) {
      if (origLd !== '') cleaned[key] = origLd;
      continue;
    }
    if (APPIMAGE_PATH_VARS.has(key) && appDir !== undefined && appDir !== '') {
      const kept = value
        .split(':')
        .filter((segment) => segment !== '' && !segment.startsWith(appDir));
      if (kept.length > 0) cleaned[key] = kept.join(':');
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
};

/**
 * Removes inherited `NPM_CONFIG_PREFIX` and `npm_*` variables so isolated `--prefix` adapter installs are never
 * redirected into a user's global nvm/npm prefix or polluted by parent npm invocation state.
 */
export const stripNpmConfigEnv = (env: Env): Env =>
  Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('NPM_')));

const runtimePathsFor = (dir: string, platform: NodeJS.Platform): ManagedRuntimePaths => ({
  version: MANAGED_NODE_VERSION,
  dir,
  node: platform === 'win32' ? join(dir, 'node.exe') : join(dir, 'bin', 'node'),
  npmCli:
    platform === 'win32'
      ? join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(dir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
});

const isFile = (filePath: string) =>
  Effect.promise(() =>
    stat(filePath).then(
      (stats) => stats.isFile(),
      () => false,
    ),
  );

const isRuntimeReady = Effect.fnUntraced(function* (
  paths: ManagedRuntimePaths,
  platform: NodeJS.Platform,
) {
  return (yield* isLaunchable(paths.node, platform)) && (yield* isFile(paths.npmCli));
});

const parseSha256 = (shasumsText: string, filename: string): string | undefined => {
  for (const line of shasumsText.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match?.[1] !== undefined && match[2]?.trim() === filename) {
      return match[1].toLowerCase();
    }
  }
  return undefined;
};

const sha256File = (filePath: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
      }),
    catch: (error) =>
      new RuntimeArchiveError({
        reason: 'ChecksumMismatch',
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

const extractArchive = Effect.fnUntraced(function* (
  archivePath: string,
  destDir: string,
  platform: NodeJS.Platform,
  env: Env,
) {
  yield* Effect.tryPromise({
    try: () => mkdir(destDir, { recursive: true }),
    catch: (error) =>
      new RuntimeArchiveError({
        reason: 'ExtractionFailed',
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
  const tarCommand = platform === 'win32' ? system32(env, 'tar.exe') : 'tar';
  const tarArgs =
    platform === 'win32'
      ? ['-xf', archivePath, '-C', destDir, '--strip-components=1']
      : ['-xzf', archivePath, '-C', destDir, '--strip-components=1'];
  const child = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof spawn>, RuntimeArchiveError>((resume) => {
      const proc = spawn(tarCommand, tarArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: platform !== 'win32',
        env: stripAppImageEnv(env),
      });
      proc.once('spawn', () => resume(Effect.succeed(proc)));
      proc.once('error', (error) =>
        resume(
          Effect.fail(
            new RuntimeArchiveError({ reason: 'ExtractionFailed', detail: error.message }),
          ),
        ),
      );
    }),
    (proc) => killChildProcessTree(proc, platform, env, 'Runtime tar').pipe(Effect.asVoid),
  );
  const { code, stderr } = yield* Effect.callback<{
    readonly code: number | null;
    readonly stderr: string;
  }>((resume) => {
    let errText = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      errText += chunk.toString('utf8');
    });
    child.once('close', (exitCode) =>
      resume(Effect.succeed({ code: exitCode, stderr: errText.trim() })),
    );
  });
  if (code !== 0) {
    return yield* new RuntimeArchiveError({
      reason: 'ExtractionFailed',
      detail: stderr || `tar exited with code ${String(code)}`,
    });
  }
});

/** Production `RuntimeArchiveSource` streaming from official nodejs.org distribution URLs. */
export const layerRuntimeArchiveSourceLive = Layer.succeed(RuntimeArchiveSource, {
  fetch: (spec, destPath) =>
    Effect.callback<{ readonly shasumsText: string }, RuntimeArchiveError>((resume) => {
      const controller = new AbortController();
      const failDownload = (detail: string): void =>
        resume(Effect.fail(new RuntimeArchiveError({ reason: 'DownloadFailed', detail })));
      void (async () => {
        try {
          const shasumRes = await fetch(spec.shasumsUrl, { signal: controller.signal });
          if (!shasumRes.ok) {
            failDownload(`HTTP ${shasumRes.status} fetching ${spec.shasumsUrl}`);
            return;
          }
          const shasumsText = await shasumRes.text();

          const archiveRes = await fetch(spec.url, { signal: controller.signal });
          if (!archiveRes.ok || archiveRes.body === null) {
            failDownload(`HTTP ${archiveRes.status} fetching ${spec.url}`);
            return;
          }
          const bodyStream = Readable.fromWeb(archiveRes.body as unknown as WebReadableStream);
          await pipeline(bodyStream, createWriteStream(destPath), { signal: controller.signal });
          resume(Effect.succeed({ shasumsText }));
        } catch (error) {
          if (controller.signal.aborted) return;
          failDownload(error instanceof Error ? error.message : String(error));
        }
      })();
      return Effect.sync(() => controller.abort());
    }),
});

const renamePath = (from: string, to: string) =>
  Effect.tryPromise({
    try: () => rename(from, to),
    catch: (error) =>
      new AgentInstallIoError({
        reason: 'Rename',
        detail: error instanceof Error ? error.message : String(error),
      }),
  });

/** Atomically replaces `targetDir` with `stagingDir`, restoring any prior directory on swap failure. */
export const swapDirectory = Effect.fnUntraced(function* (stagingDir: string, targetDir: string) {
  const backup = `${targetDir}.bak-${randomUUID()}`;
  const backedUp = yield* renamePath(targetDir, backup).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );
  yield* renamePath(stagingDir, targetDir).pipe(
    Effect.tapError(() =>
      backedUp ? renamePath(backup, targetDir).pipe(Effect.ignore) : Effect.void,
    ),
  );
  if (backedUp) {
    yield* Effect.promise(() =>
      rm(backup, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(
        () => undefined,
      ),
    );
  }
});

export const layerAgentRuntime = Layer.effect(
  AgentRuntime,
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope;
    const { root } = yield* Store;
    const { platform, env } = yield* PathSources;
    const source = yield* RuntimeArchiveSource;

    const runtimeRoot = join(root, 'runtime');
    const targetDir = join(runtimeRoot, `node-${MANAGED_NODE_VERSION}`);
    const targetPaths = runtimePathsFor(targetDir, platform);

    const inspect = Effect.gen(function* () {
      return (yield* isRuntimeReady(targetPaths, platform))
        ? Option.some(targetPaths)
        : Option.none<ManagedRuntimePaths>();
    });

    const acquireFresh = Effect.scoped(
      Effect.gen(function* () {
        const spec = runtimeSpecFor(MANAGED_NODE_VERSION, platform, process.arch);
        if (spec === undefined) {
          return yield* new RuntimeArchiveError({
            reason: 'UnsupportedPlatform',
            detail: `Unsupported platform/architecture: ${platform}/${process.arch}`,
          });
        }

        const stagingDir = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async () => {
              const dir = join(runtimeRoot, `.staging-${randomUUID()}`);
              await mkdir(dir, { recursive: true });
              return dir;
            },
            catch: (error) =>
              new RuntimeArchiveError({
                reason: 'ExtractionFailed',
                detail: error instanceof Error ? error.message : String(error),
              }),
          }),
          (dir) =>
            Effect.promise(() =>
              rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
            ),
        );

        const archivePath = join(stagingDir, spec.filename);
        const { shasumsText } = yield* source.fetch(spec, archivePath);

        const expectedHash = parseSha256(shasumsText, spec.filename);
        if (expectedHash === undefined) {
          return yield* new RuntimeArchiveError({
            reason: 'ChecksumMismatch',
            detail: `No SHA-256 entry for ${spec.filename} in SHASUMS256.txt`,
          });
        }
        const actualHash = yield* sha256File(archivePath);
        if (actualHash !== expectedHash) {
          return yield* new RuntimeArchiveError({
            reason: 'ChecksumMismatch',
            detail: `SHA-256 mismatch for ${spec.filename}: expected ${expectedHash}, got ${actualHash}`,
          });
        }

        const extractedDir = join(stagingDir, 'extracted');
        yield* extractArchive(archivePath, extractedDir, platform, env);
        const stagedPaths = runtimePathsFor(extractedDir, platform);
        if (!(yield* isRuntimeReady(stagedPaths, platform))) {
          return yield* new RuntimeArchiveError({
            reason: 'ExtractionFailed',
            detail: `Extracted runtime is missing ${stagedPaths.node} or ${stagedPaths.npmCli}`,
          });
        }

        if (!(yield* isRuntimeReady(targetPaths, platform))) {
          yield* swapDirectory(extractedDir, targetDir).pipe(
            Effect.mapError(
              (error) =>
                new RuntimeArchiveError({ reason: 'ExtractionFailed', detail: error.detail }),
            ),
          );
        }
        return targetPaths;
      }),
    );

    interface InFlightState {
      fiber: Fiber.Fiber<void> | undefined;
      waiters: number;
    }

    interface InFlight {
      readonly deferred: Deferred.Deferred<ManagedRuntimePaths, RuntimeArchiveError>;
      readonly state: InFlightState;
    }

    let inFlight: InFlight | null = null;

    const ensure = Effect.fnUntraced(function* () {
      if (yield* isRuntimeReady(targetPaths, platform)) {
        return targetPaths;
      }
      if (inFlight === null) {
        const deferred = Deferred.makeUnsafe<ManagedRuntimePaths, RuntimeArchiveError>();
        const current: InFlight = { deferred, state: { fiber: undefined, waiters: 0 } };
        inFlight = current;
        current.state.fiber = yield* acquireFresh.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.sync(() => {
              if (inFlight === current) inFlight = null;
            }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
          ),
          Effect.asVoid,
          Effect.forkIn(layerScope),
        );
      }
      const active = inFlight;
      active.state.waiters += 1;
      return yield* Deferred.await(active.deferred).pipe(
        Effect.onInterrupt(
          Effect.fnUntraced(function* () {
            active.state.waiters -= 1;
            if (active.state.waiters <= 0 && inFlight === active) {
              inFlight = null;
              if (active.state.fiber !== undefined) {
                yield* Fiber.interrupt(active.state.fiber);
              }
            }
          }),
        ),
      );
    })();

    return { inspect, ensure };
  }),
);

/** Production `AgentRuntime` backed by `<userData>/spence/runtime/` and nodejs.org archives. */
export const layerAgentRuntimeMain = layerAgentRuntime.pipe(
  Layer.provide(layerRuntimeArchiveSourceLive),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerPathSources),
);
