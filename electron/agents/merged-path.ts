import { Context, Effect, Layer, Option } from 'effect';
import { type Env, execStdout, system32 } from './exec';
import { splitPath } from './resolve';

/** The two registry keys Explorer builds a Start-menu launch's PATH from. */
export type RegistryHive = 'Machine' | 'User';

const REGISTRY_KEYS: Record<RegistryHive, string> = {
  Machine: 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  User: 'HKCU\\Environment',
};

/** Where the PATH pieces come from. Swapped in tests; the live layer reads the OS. */
export class PathSources extends Context.Service<
  PathSources,
  {
    readonly platform: NodeJS.Platform;
    readonly env: Env;
    /** The raw, unexpanded `Path` value of a registry key (Windows only). */
    readonly readRegistryPath: (hive: RegistryHive) => Effect.Effect<Option.Option<string>>;
    /** PATH as the user's interactive login shell sets it (macOS / Linux only), bounded by a timeout. */
    readonly readLoginShellPath: Effect.Effect<Option.Option<string>>;
  }
>()('agents/PathSources') {}

/** The PATH Agents are resolved on and launched with: computed once per run, on first use. */
export class MergedPath extends Context.Service<
  MergedPath,
  { readonly get: Effect.Effect<string> }
>()('agents/MergedPath') {}

const envValue = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined => {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
};

const expandWindowsVars = (
  value: string,
  env: Readonly<Record<string, string | undefined>>,
): string =>
  value.replace(/%([^%;]+)%/g, (whole, name: string) => envValue(env, name, 'win32') ?? whole);

const dedupeKey = (folder: string, platform: NodeJS.Platform): string =>
  platform === 'win32' ? folder.toLowerCase().replace(/\\+$/, '') : folder;

const mergeFolders = (lists: ReadonlyArray<string>, platform: NodeJS.Platform): string => {
  const seen = new Set<string>();
  const folders: Array<string> = [];
  for (const folder of lists.flatMap((list) => splitPath(list, platform))) {
    const key = dedupeKey(folder, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(folder);
  }
  return folders.join(platform === 'win32' ? ';' : ':');
};

const computeMergedPath = Effect.fnUntraced(function* () {
  const { platform, env, readRegistryPath, readLoginShellPath } = yield* PathSources;
  const processPath = envValue(env, 'PATH', platform) ?? '';
  if (platform === 'win32') {
    const machine = yield* readRegistryPath('Machine');
    const user = yield* readRegistryPath('User');
    const registry = [machine, user].flatMap(Option.toArray).map((v) => expandWindowsVars(v, env));
    return mergeFolders([processPath, ...registry], platform);
  }
  const shellPath = yield* readLoginShellPath;
  return Option.getOrElse(shellPath, () => processPath);
});

export const layerMergedPath = Layer.effect(
  MergedPath,
  Effect.gen(function* () {
    const sources = yield* PathSources;
    const get = yield* Effect.cached(
      computeMergedPath().pipe(Effect.provideService(PathSources, sources)),
    );
    return { get };
  }),
);

const SOURCE_TIMEOUT_MS = 5_000;

/** A source's stdout, or none when it cannot run, fails or times out. */
const run = (file: string, args: ReadonlyArray<string>, env: Env) =>
  execStdout(file, args, env, SOURCE_TIMEOUT_MS).pipe(Effect.option);

const readRegistryPath = (hive: RegistryHive): Effect.Effect<Option.Option<string>> => {
  const reg = system32(process.env, 'reg.exe');
  return run(reg, ['query', REGISTRY_KEYS[hive], '/v', 'Path'], process.env).pipe(
    Effect.map(
      Option.flatMap((stdout) =>
        Option.fromNullishOr(/^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(stdout)?.[1]?.trim()),
      ),
    ),
  );
};

const MARK = '__SPENCE_PATH__';

const readLoginShellPath: Effect.Effect<Option.Option<string>> = run(
  process.env['SHELL'] ?? '/bin/sh',
  ['-ilc', `printf '%s' "${MARK}$PATH${MARK}"`],
  // Keep profiles from attaching tmux or prompting for updates while we only want PATH.
  { ...process.env, ZSH_TMUX_AUTOSTART: 'false', DISABLE_AUTO_UPDATE: 'true' },
).pipe(
  Effect.map(
    Option.flatMap((stdout) =>
      Option.fromNullishOr(new RegExp(`${MARK}(.*)${MARK}`, 's').exec(stdout)?.[1]).pipe(
        Option.filter((path) => path.length > 0),
      ),
    ),
  ),
);

/** Reads the live OS: `process.env`, `reg.exe query` on Windows, `$SHELL -ilc` elsewhere. */
export const layerPathSources = Layer.succeed(PathSources, {
  platform: process.platform,
  env: process.env,
  readRegistryPath,
  readLoginShellPath,
});
