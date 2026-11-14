import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { Duration, Effect, Option } from 'effect';
import type { CatalogEntry } from './catalog';
import { type Env, execStdout, system32 } from './exec';
import { AgentLaunchError, buildLaunch } from './launch';
import { MergedPath, PathSources } from './merged-path';
import { resolveExecutable } from './resolve';

/** How long a POSIX Agent gets to stop after SIGTERM before its group gets SIGKILL. */
const KILL_GRACE = Duration.seconds(2);
/** How long to wait for the Agent to exit once it was told to; past that Spence moves on and logs it. */
export const EXIT_TIMEOUT = Duration.seconds(5);

/** The environment an Agent runs with: ours, with exactly one PATH key holding the merged PATH. */
const agentEnv = (env: Env, path: string): Env => {
  const rest = Object.fromEntries(
    Object.entries(env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  return { ...rest, PATH: path };
};

const hasExited = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode !== null || child.signalCode !== null;

/** Waits up to `within` for the process to exit; `true` when it did. */
const awaitExit = (child: ChildProcessWithoutNullStreams, within: Duration.Input) =>
  Effect.callback<boolean>((resume) => {
    if (hasExited(child)) return resume(Effect.succeed(true));
    const onExit = (): void => resume(Effect.succeed(true));
    child.once('exit', onExit);
    return Effect.sync(() => child.off('exit', onExit));
  }).pipe(Effect.timeoutOrElse({ duration: within, orElse: () => Effect.succeed(false) }));

/** Signals a whole process group; a group that is already gone is fine. */
const signalGroup = (pid: number, signal: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      process.kill(-pid, signal);
    } catch {
      // The group is already gone.
    }
  });

/**
 * Kills a process and everything it started, and never hangs. On Windows the Agent is a grandchild
 * (cmd.exe -> node -> ...), so `child.kill()` would only stop the top; `taskkill /T /F` takes the tree. Elsewhere the
 * Agent leads its own process group: the group gets SIGTERM, then SIGKILL if it is still there after a short grace.
 * Returns `true` when process exit is observed within `EXIT_TIMEOUT`, `false` otherwise.
 */
export const killTree = Effect.fnUntraced(function* (child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return true;
  const { platform, env } = yield* PathSources;
  if (platform === 'win32') {
    yield* execStdout(
      system32(env, 'taskkill.exe'),
      ['/T', '/F', '/PID', String(pid)],
      env,
      EXIT_TIMEOUT,
    ).pipe(
      Effect.catch((error) =>
        Effect.logWarning(`taskkill failed for Agent process ${pid}: ${error.message}`),
      ),
    );
  } else {
    yield* signalGroup(pid, 'SIGTERM');
    if (yield* awaitExit(child, KILL_GRACE)) return true;
    yield* signalGroup(pid, 'SIGKILL');
  }
  const confirmed = yield* awaitExit(child, EXIT_TIMEOUT);
  if (!confirmed) {
    yield* Effect.logWarning(`Agent process ${pid} did not exit after being killed`);
  }
  return confirmed;
});

export interface SpawnAgentOptions {
  readonly env?: Env;
}

/**
 * Starts a Catalog Agent's adapter in the user's home folder, re-resolving it on the merged PATH first. The process
 * lives as long as the surrounding scope; closing the scope kills its whole tree.
 */
export const spawnAgent = Effect.fn('Agents.spawn')(function* (
  entry: Pick<CatalogEntry, 'binary' | 'args'>,
  options?: SpawnAgentOptions,
) {
  const { platform, env } = yield* PathSources;
  const path = yield* MergedPath.use((merged) => merged.get);
  const executable = yield* resolveExecutable(entry.binary, path, platform);
  if (Option.isNone(executable)) {
    return yield* new AgentLaunchError({
      reason: 'NotInstalled',
      detail: `${entry.binary} is not on PATH`,
    });
  }
  const launch = yield* buildLaunch(
    executable.value,
    entry.args,
    platform,
    env['ComSpec'] ?? system32(env, 'cmd.exe'),
  );
  const mergedEnv = agentEnv(options?.env === undefined ? env : { ...env, ...options.env }, path);
  return yield* Effect.acquireRelease(
    Effect.callback<ChildProcessWithoutNullStreams, AgentLaunchError>((resume) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: homedir(),
        env: mergedEnv,
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        // POSIX: lead a process group so the whole tree can be signalled.
        detached: platform !== 'win32',
      });
      child.once('spawn', () => resume(Effect.succeed(child)));
      child.once('error', (error) =>
        resume(Effect.fail(new AgentLaunchError({ reason: 'CannotStart', detail: error.message }))),
      );
    }),
    (child) => killTree(child).pipe(Effect.asVoid),
  );
});

const needsTty = (output: string): boolean => /tty|raw mode|isatty|not a terminal/i.test(output);

const waitChildExit = (child: ChildProcessWithoutNullStreams) =>
  Effect.callback<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resume) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return resume(Effect.succeed({ code: child.exitCode, signal: child.signalCode }));
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        resume(Effect.succeed({ code, signal }));
      child.once('exit', onExit);
      return Effect.sync(() => child.off('exit', onExit));
    },
  );

const spawnConsoleWait = Effect.fn('Agents.spawnConsoleWait')(function* (
  entry: Pick<CatalogEntry, 'binary' | 'args'>,
  extraEnv?: Env,
) {
  const { platform, env } = yield* PathSources;
  const path = yield* MergedPath.use((merged) => merged.get);
  const executable = yield* resolveExecutable(entry.binary, path, platform);
  if (Option.isNone(executable)) {
    return yield* new AgentLaunchError({
      reason: 'NotInstalled',
      detail: `${entry.binary} is not on PATH`,
    });
  }
  const comspec = env['ComSpec'] ?? system32(env, 'cmd.exe');
  const quote = (value: string): string =>
    value.includes(' ') || value.includes('"') ? `"${value.replace(/"/g, '\\"')}"` : value;
  const commandLine = [executable.value, ...entry.args].map(quote).join(' ');
  const mergedEnv = agentEnv(extraEnv === undefined ? env : { ...env, ...extraEnv }, path);
  const child = yield* Effect.acquireRelease(
    Effect.callback<ChildProcessWithoutNullStreams, AgentLaunchError>((resume) => {
      const spawned = spawn(comspec, ['/d', '/s', '/c', `start "" /wait ${commandLine}`], {
        cwd: homedir(),
        env: mergedEnv,
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      spawned.once('spawn', () => resume(Effect.succeed(spawned)));
      spawned.once('error', (error) =>
        resume(Effect.fail(new AgentLaunchError({ reason: 'CannotStart', detail: error.message }))),
      );
    }),
    (child) => killTree(child).pipe(Effect.asVoid),
  );
  return yield* waitChildExit(child);
});

/** Runs an interactive/CLI command for an Agent (such as terminal login) headless, falling back to a console window on Windows if a TTY is required. */
export const runAgentCommand = Effect.fn('Agents.runCommand')(function* (
  entry: Pick<CatalogEntry, 'binary' | 'args'>,
  options?: { readonly env?: Env; readonly onLine?: (line: string) => void },
) {
  const { platform } = yield* PathSources;
  const output: Array<string> = [];
  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      output.push(line);
      if (output.length > 30) output.shift();
      options?.onLine?.(line);
    }
  };
  const exit = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnAgent(
        entry,
        options?.env === undefined ? undefined : { env: options.env },
      );
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      return yield* waitChildExit(child);
    }),
  );
  if (exit.code === 0) return;
  const tail = output.join('\n');
  if (platform === 'win32' && needsTty(tail)) {
    const consoleExit = yield* Effect.scoped(spawnConsoleWait(entry, options?.env));
    if (consoleExit.code === 0) return;
    return yield* new AgentLaunchError({
      reason: 'CannotStart',
      detail: `${entry.binary} exited with code ${consoleExit.code ?? consoleExit.signal ?? '?'}`,
    });
  }
  return yield* new AgentLaunchError({
    reason: 'CannotStart',
    detail: tail || `${entry.binary} exited with ${exit.signal ?? `code ${exit.code ?? '?'}`}`,
  });
});
