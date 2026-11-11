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
const EXIT_TIMEOUT = Duration.seconds(5);

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
 */
export const killTree = Effect.fnUntraced(function* (child: ChildProcessWithoutNullStreams) {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return;
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
    if (yield* awaitExit(child, KILL_GRACE)) return;
    yield* signalGroup(pid, 'SIGKILL');
  }
  if (!(yield* awaitExit(child, EXIT_TIMEOUT))) {
    yield* Effect.logWarning(`Agent process ${pid} did not exit after being killed`);
  }
});

/**
 * Starts a Catalog Agent's adapter in the user's home folder, re-resolving it on the merged PATH first. The process
 * lives as long as the surrounding scope; closing the scope kills its whole tree.
 */
export const spawnAgent = Effect.fn('Agents.spawn')(function* (
  entry: Pick<CatalogEntry, 'binary' | 'args'>,
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
  return yield* Effect.acquireRelease(
    Effect.callback<ChildProcessWithoutNullStreams, AgentLaunchError>((resume) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: homedir(),
        env: agentEnv(env, path),
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
    killTree,
  );
});
