import { Context, Effect, Layer, Option } from 'effect';
import type { Agent } from '../../src/shared/agents/agents.rpc';
import { agentCopy } from '../i18n/agent-copy';
import { resolveLocale, type Locale } from '../i18n/locale';
import { Settings } from '../settings/settings';
import { Store } from '../store/store';
import { catalog, type CatalogEntry } from './catalog';
import { e2eAgentBin, e2eFakeAgent, e2eInstalledBin } from './e2e-agent';
import { execStdout, system32 } from './exec';
import { buildLaunch } from './launch';
import { inspectManagedAgent } from './managed';
import { MergedPath, PathSources } from './merged-path';
import { resolveExecutable } from './resolve';
import { AgentRuntime } from './runtime';
import {
  inspectNpmPackageVersion,
  makeNativeVersionCache,
  parseSemver,
  qualifyVersion,
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

interface InspectionOutcome {
  readonly installed: boolean;
  readonly installedVersion: string | undefined;
}

const inspectEntry = (entry: CatalogEntry, outcome: InspectionOutcome, locale: Locale): Agent => {
  const versionQualification =
    outcome.installedVersion === undefined
      ? undefined
      : qualifyVersion(outcome.installedVersion, entry.qualification);
  const copy = agentCopy(locale, entry.id);
  const upgradeCommand = copy?.upgradeCommand ?? entry.upgradeCommand;
  const installInstructions = copy?.installInstructions ?? entry.installInstructions;
  return {
    id: entry.id,
    name: entry.name,
    installKind: entry.installKind,
    package: entry.package,
    installed: outcome.installed,
    imageLimits: entry.imageLimits,
    capabilities: entry.capabilities,
    qualifiedVersion: entry.qualification.version,
    ...(outcome.installedVersion === undefined
      ? {}
      : { installedVersion: outcome.installedVersion }),
    ...(versionQualification === undefined ? {} : { versionQualification }),
    ...(upgradeCommand === undefined ? {} : { upgradeCommand }),
    ...(installInstructions === undefined ? {} : { installInstructions }),
  };
};

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

    const settingsOption = yield* Effect.serviceOption(Settings);
    const storeOption = yield* Effect.serviceOption(Store);
    const runtimeOption = yield* Effect.serviceOption(AgentRuntime);
    const isE2e = e2eAgentBin(env) !== undefined;

    const inspectNpm = Effect.fnUntraced(function* (entry: CatalogEntry, path: string) {
      if (Option.isSome(storeOption) && Option.isSome(runtimeOption)) {
        const runtime = yield* runtimeOption.value.inspect;
        if (Option.isSome(runtime)) {
          const managed = yield* inspectManagedAgent(storeOption.value.root, entry);
          if (Option.isSome(managed)) {
            return { installed: true, installedVersion: managed.value.version };
          }
        }
        if (!isE2e) return { installed: false, installedVersion: undefined };
      } else if (!isE2e) {
        const found = yield* resolveExecutable(entry.binary, path, platform);
        if (Option.isNone(found)) return { installed: false, installedVersion: undefined };
        const installedVersion = yield* inspectNpmPackageVersion(found.value, entry.package);
        return { installed: true, installedVersion };
      }

      // E2E mode (`SPENCE_E2E=1`): honour e2e bin (`MergedPath`) and `spenceInstalledAgents` (`SPENCE_E2E_INSTALLED_BIN`).
      let found = yield* resolveExecutable(entry.binary, path, platform);
      const extraBin = e2eInstalledBin(env);
      if (Option.isNone(found) && entry.id !== e2eFakeAgent.id && extraBin !== undefined) {
        found = yield* resolveExecutable(entry.binary, extraBin, platform);
      }
      if (Option.isNone(found)) return { installed: false, installedVersion: undefined };
      const installedVersion = yield* inspectNpmPackageVersion(found.value, entry.package);
      return { installed: true, installedVersion };
    });

    const inspectNative = Effect.fnUntraced(function* (entry: CatalogEntry, path: string) {
      const found = yield* resolveExecutable(entry.binary, path, platform);
      if (Option.isNone(found)) return { installed: false, installedVersion: undefined };
      const installedVersion = yield* nativeCache.peek(found.value);
      return { installed: true, installedVersion };
    });

    const list = Effect.gen(function* () {
      const language = Option.isSome(settingsOption)
        ? (yield* settingsOption.value.get).language
        : 'system';
      const locale = resolveLocale(language, env);
      const path = yield* mergedPath.get;
      return yield* Effect.forEach(catalog, (entry) =>
        (entry.installKind === 'npm' ? inspectNpm(entry, path) : inspectNative(entry, path)).pipe(
          Effect.map((outcome) => inspectEntry(entry, outcome, locale)),
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
