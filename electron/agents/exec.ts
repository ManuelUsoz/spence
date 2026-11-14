import { execFile, type ExecFileException } from 'node:child_process';
import { join } from 'node:path';
import { Duration, Effect } from 'effect';

/** An environment as `PathSources` hands it out. */
export type Env = Readonly<Record<string, string | undefined>>;

/** A program in Windows' `System32`, found through `SystemRoot` (`C:\Windows` when unset). */
export const system32 = (env: Env, program: string): string =>
  join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', program);

/**
 * Runs a program to completion and gives its stdout. Fails with the `execFile` error when it cannot start, exits
 * non-zero or runs past `timeout`; interrupting the effect kills the program.
 */
export const execStdout = (
  file: string,
  args: ReadonlyArray<string>,
  env: Env,
  timeout: Duration.Input,
  options?: { readonly windowsVerbatimArguments?: boolean },
): Effect.Effect<string, ExecFileException> =>
  Effect.callback<string, ExecFileException>((resume, signal) => {
    execFile(
      file,
      [...args],
      {
        env,
        signal,
        timeout: Duration.toMillis(timeout),
        windowsHide: true,
        ...(options?.windowsVerbatimArguments === undefined
          ? {}
          : { windowsVerbatimArguments: options.windowsVerbatimArguments }),
        encoding: 'utf8',
      },
      (error, stdout) => resume(error ? Effect.fail(error) : Effect.succeed(stdout)),
    );
  });
