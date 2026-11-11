import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Effect, Option } from 'effect';
import type { CatalogEntry } from './catalog';
import { AgentLaunchError, buildLaunch } from './launch';
import { MergedPath } from './merged-path';
import { resolveExecutable } from './resolve';

const systemRoot = (): string => process.env['SystemRoot'] ?? 'C:\\Windows';

/** The environment an Agent runs with: ours, with exactly one PATH key holding the merged PATH. */
const agentEnv = (path: string): NodeJS.ProcessEnv => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'),
  );
  return { ...env, PATH: path };
};

const hasExited = (child: ChildProcessWithoutNullStreams): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const awaitExit = (child: ChildProcessWithoutNullStreams): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (hasExited(child)) return resume(Effect.void);
    child.once('exit', () => resume(Effect.void));
  });

/**
 * Kills a process and everything it started. On Windows the Agent is a grandchild (cmd.exe -> node -> ...), so
 * `child.kill()` would only stop the top; `taskkill /T /F` takes the tree. Elsewhere the Agent leads its own process
 * group and the whole group gets the signal.
 */
export const killTree = (child: ChildProcessWithoutNullStreams): Effect.Effect<void> => {
  const pid = child.pid;
  if (pid === undefined || hasExited(child)) return Effect.void;
  const kill =
    process.platform === 'win32'
      ? Effect.callback<void>((resume) => {
          const taskkill = join(systemRoot(), 'System32', 'taskkill.exe');
          execFile(taskkill, ['/T', '/F', '/PID', String(pid)], { windowsHide: true }, () =>
            resume(Effect.void),
          );
        })
      : Effect.sync(() => {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            // The group is already gone.
          }
        });
  return kill.pipe(Effect.andThen(awaitExit(child)));
};

/**
 * Starts a Catalog Agent's adapter in the user's home folder, re-resolving it on the merged PATH first. The process
 * lives as long as the surrounding scope; closing the scope kills its whole tree.
 */
export const spawnAgent = Effect.fn('Agents.spawn')(function* (
  entry: Pick<CatalogEntry, 'binary' | 'args'>,
) {
  const path = yield* MergedPath.use((merged) => merged.get);
  const executable = yield* resolveExecutable(entry.binary, path, process.platform);
  if (Option.isNone(executable)) {
    return yield* new AgentLaunchError({
      reason: 'NotInstalled',
      detail: `${entry.binary} is not on PATH`,
    });
  }
  const launch = yield* buildLaunch(
    executable.value,
    entry.args,
    process.platform,
    process.env['ComSpec'] ?? join(systemRoot(), 'System32', 'cmd.exe'),
  );
  return yield* Effect.acquireRelease(
    Effect.callback<ChildProcessWithoutNullStreams, AgentLaunchError>((resume) => {
      const child = spawn(launch.command, [...launch.args], {
        cwd: homedir(),
        env: agentEnv(path),
        stdio: 'pipe',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: launch.windowsVerbatimArguments,
        // POSIX: lead a process group so the whole tree can be signalled.
        detached: process.platform !== 'win32',
      });
      child.once('spawn', () => resume(Effect.succeed(child)));
      child.once('error', (error) =>
        resume(Effect.fail(new AgentLaunchError({ reason: 'CannotStart', detail: error.message }))),
      );
    }),
    killTree,
  );
});
