import { Context, Effect, Layer, Option } from 'effect';
import type { Agent } from '../../src/shared/agents/agents.rpc';
import { catalog, type CatalogEntry } from './catalog';
import { MergedPath, PathSources } from './merged-path';
import { resolveExecutable } from './resolve';
import { execStdout, system32 } from './exec';
import { buildLaunch } from './launch';
import {
  inspectNpmPackageVersion,
  makeNativeVersionCache,
  parseSemver,
  qualifyVersion,
  type NativeVersionCache,
} from './version';

/** The Catalog with each Agent's installed state and static/cached version qualification. */
export class Agents extends Context.Service<
  Agents,
  {
    /** Re-resolves every Agent on each call: a few `stat`s, no process is started. */
    readonly list: Effect.Effect<ReadonlyArray<Agent>>;
    /** Checks and caches a native binary's `--version` by `(path, mtimeMs)` on explicit check or launch fallback. */
    readonly checkNativeVersion: (entry: CatalogEntry) => Effect.Effect<string | undefined>;
  }
>()('agents/Agents') {}

const inspectEntry = Effect.fnUntraced(function* (
  entry: CatalogEntry,
  resolved: Option.Option<string>,
  nativeCache: NativeVersionCache,
) {
  const installed = Option.isSome(resolved);
  const installedVersion = Option.isNone(resolved)
    ? undefined
    : entry.installKind === 'npm'
      ? yield* inspectNpmPackageVersion(resolved.value, entry.package)
      : yield* nativeCache.peek(resolved.value);
  const versionQualification =
    installedVersion === undefined
      ? undefined
      : qualifyVersion(installedVersion, entry.qualification);
  const agent: Agent = {
    id: entry.id,
    name: entry.name,
    installKind: entry.installKind,
    package: entry.package,
    installed,
    imageLimits: entry.imageLimits,
    capabilities: entry.capabilities,
    qualifiedVersion: entry.qualification.version,
    ...(installedVersion === undefined ? {} : { installedVersion }),
    ...(versionQualification === undefined ? {} : { versionQualification }),
    ...(entry.upgradeCommand === undefined ? {} : { upgradeCommand: entry.upgradeCommand }),
    ...(entry.installInstructions === undefined
      ? {}
      : { installInstructions: entry.installInstructions }),
  };
  return agent;
});

export const layerAgents = Layer.effect(
  Agents,
  Effect.gen(function* () {
    const mergedPath = yield* MergedPath;
    const { platform, env } = yield* PathSources;
    const comSpec = env['ComSpec'] ?? system32(env, 'cmd.exe');
    const nativeCache = makeNativeVersionCache((binaryPath) =>
      buildLaunch(binaryPath, ['--version'], platform, comSpec).pipe(
        Effect.flatMap((launch) =>
          execStdout(launch.command, launch.args, env, '3 seconds', {
            windowsVerbatimArguments: launch.windowsVerbatimArguments,
          }),
        ),
        Effect.map((stdout) => {
          const parsed = parseSemver(stdout);
          return parsed === undefined ? undefined : `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
        }),
        Effect.catch(() => Effect.succeed(undefined)),
      ),
    );

    const list = Effect.gen(function* () {
      const path = yield* mergedPath.get;
      return yield* Effect.forEach(catalog, (entry) =>
        resolveExecutable(entry.binary, path, platform).pipe(
          Effect.flatMap((found) => inspectEntry(entry, found, nativeCache)),
        ),
      );
    });

    const checkNativeVersion = Effect.fnUntraced(function* (entry: CatalogEntry) {
      const path = yield* mergedPath.get;
      const found = yield* resolveExecutable(entry.binary, path, platform);
      if (Option.isNone(found)) return undefined;
      return yield* nativeCache.inspect(found.value);
    });

    return { list, checkNativeVersion };
  }),
);
