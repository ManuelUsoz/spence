import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Effect } from 'effect';

const execFileAsync = promisify(execFile);

export interface RunGitOptions {
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

/** Runs a Git CLI command and returns trimmed stdout, or `null` if the command fails. */
export const runGit = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: RunGitOptions = {},
): Effect.Effect<string | null> =>
  Effect.tryPromise(() =>
    execFileAsync('git', [...args], {
      cwd,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      timeout: options.timeout ?? 10_000,
      windowsHide: true,
    }).then((r) => r.stdout.trimEnd()),
  ).pipe(Effect.catch(() => Effect.succeed(null)));

/** Runs a Git CLI command and returns raw stdout `Buffer`, or `null` if the command fails. */
export const runGitBuffer = (
  cwd: string,
  args: ReadonlyArray<string>,
  options: RunGitOptions = {},
): Effect.Effect<Buffer | null> =>
  Effect.tryPromise(() =>
    execFileAsync('git', [...args], {
      cwd,
      encoding: 'buffer',
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      timeout: options.timeout ?? 5_000,
      windowsHide: true,
    }).then((r) => r.stdout),
  ).pipe(Effect.catch(() => Effect.succeed(null)));
