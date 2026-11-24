import { posix, win32 } from 'node:path';
import { Effect, Schema } from 'effect';

/**
 * Why an Agent did not start. Only absolute paths and compile-time constant arguments go on a command line;
 * anything else is refused before a process exists.
 */
export class AgentLaunchError extends Schema.TaggedError<AgentLaunchError>()('AgentLaunchError', {
  reason: Schema.Literals(['NotInstalled', 'UnsafeArgument', 'UnsafePath', 'CannotStart']),
  detail: Schema.String,
}) {}

/** What to hand to `child_process.spawn`. Never `shell: true`. */
export interface Launch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Set for the cmd.exe route: the command line is already quoted and must reach cmd.exe untouched. */
  readonly windowsVerbatimArguments: boolean;
}

/**
 * A constant argument: no spaces, quotes or anything cmd.exe would expand or redirect. `@` and `/` are allowed for
 * scoped npm package names (`@scope/name`); cmd.exe gives neither a meaning inside an argument.
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9._=@/-]+$/;

/** Characters cmd.exe still interprets inside double quotes (expansion, escapes) or that end the quoting. */
const UNSAFE_IN_QUOTES = /["%!^\r\n]/;

const isBatchFile = (path: string): boolean => /\.(cmd|bat)$/i.test(path);

/**
 * Builds the spawn call for a resolved executable. An `.exe` or POSIX binary runs directly; a `.cmd` / `.bat` shim
 * runs as `cmd.exe /d /s /c ""<abs path>" <args>"` with verbatim arguments, which is only safe because every
 * argument is a validated constant and the path holds nothing cmd.exe reinterprets inside quotes.
 */
export const buildLaunch = Effect.fnUntraced(function* (
  executable: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
  comSpec: string,
) {
  const unsafe = args.find((arg) => !SAFE_ARGUMENT.test(arg));
  if (unsafe !== undefined) {
    return yield* new AgentLaunchError({
      reason: 'UnsafeArgument',
      detail: `Not a constant argument: ${JSON.stringify(unsafe)}`,
    });
  }
  if (!(platform === 'win32' ? win32 : posix).isAbsolute(executable)) {
    return yield* new AgentLaunchError({
      reason: 'UnsafePath',
      detail: `Not absolute: ${executable}`,
    });
  }
  if (platform !== 'win32' || !isBatchFile(executable)) {
    return { command: executable, args, windowsVerbatimArguments: false } satisfies Launch;
  }
  if (UNSAFE_IN_QUOTES.test(executable)) {
    return yield* new AgentLaunchError({
      reason: 'UnsafePath',
      detail: `cmd.exe would reinterpret: ${executable}`,
    });
  }
  const line = [`"${executable}"`, ...args].join(' ');
  return {
    command: comSpec,
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  } satisfies Launch;
});

/**
 * Builds the spawn call for running a managed JS entrypoint directly through Spence's managed `node` binary
 * (`shell: false`, never `#!/usr/bin/env node` on `PATH` and never `cmd.exe`).
 */
export const buildNodeLaunch = Effect.fnUntraced(function* (
  nodeExecutable: string,
  scriptPath: string,
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
) {
  const unsafe = args.find((arg) => !SAFE_ARGUMENT.test(arg));
  if (unsafe !== undefined) {
    return yield* new AgentLaunchError({
      reason: 'UnsafeArgument',
      detail: `Not a constant argument: ${JSON.stringify(unsafe)}`,
    });
  }
  const pathImpl = platform === 'win32' ? win32 : posix;
  if (!pathImpl.isAbsolute(nodeExecutable)) {
    return yield* new AgentLaunchError({
      reason: 'UnsafePath',
      detail: `Not absolute: ${nodeExecutable}`,
    });
  }
  if (!pathImpl.isAbsolute(scriptPath)) {
    return yield* new AgentLaunchError({
      reason: 'UnsafePath',
      detail: `Not absolute: ${scriptPath}`,
    });
  }
  return {
    command: nodeExecutable,
    args: [scriptPath, ...args],
    windowsVerbatimArguments: false,
  } satisfies Launch;
});
