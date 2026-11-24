import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';
import { Effect, Option } from 'effect';
import type { BinaryPathError } from '../../src/shared/agents/agents.rpc';

/**
 * What Spence may launch on Windows, in lookup order. `.ps1`, `.js`, `.vbs` and the extensionless sh shim npm writes
 * are skipped even when PATHEXT lists them: `CreateProcess` cannot start them.
 */
export const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const;

/** Splits a PATH value into its folders, dropping empty entries and the quotes Windows allows around one. */
export const splitPath = (pathValue: string, platform: NodeJS.Platform): ReadonlyArray<string> =>
  pathValue
    .split(platform === 'win32' ? ';' : ':')
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0);

const candidates = (name: string, platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === 'win32' ? WINDOWS_EXTENSIONS.map((ext) => name + ext) : [name];

// Missing, unreadable or not executable: a PATH folder Spence cannot launch from is simply skipped.
export const isLaunchable = Effect.fnUntraced(function* (path: string, platform: NodeJS.Platform) {
  const isFile = yield* Effect.promise(() =>
    stat(path).then(
      (stats) => stats.isFile(),
      () => false,
    ),
  );
  if (!isFile || platform === 'win32') return isFile;
  return yield* Effect.promise(() =>
    access(path, constants.X_OK).then(
      () => true,
      () => false,
    ),
  );
});

/**
 * Resolves a binary name to an absolute path by walking PATH like cmd.exe does: folder by folder, and within a
 * folder `.exe`, then `.cmd`, then `.bat` on Windows; the bare executable name elsewhere. Only cheap `stat`s.
 */
export const resolveExecutable = Effect.fnUntraced(function* (
  name: string,
  pathValue: string,
  platform: NodeJS.Platform,
) {
  for (const folder of splitPath(pathValue, platform)) {
    for (const file of candidates(name, platform)) {
      const path = join(folder, file);
      if (yield* isLaunchable(path, platform)) return Option.some(path);
    }
  }
  return Option.none<string>();
});

export type NativeOverrideResolution =
  | { readonly _tag: 'Valid'; readonly path: string }
  | { readonly _tag: 'Invalid'; readonly issue: BinaryPathError; readonly path: string };

/**
 * Validates a user-configured explicit binary path override for a native Agent: must be absolute and launchable.
 */
export const resolveNativeOverride = Effect.fnUntraced(function* (
  binaryPath: string,
  platform: NodeJS.Platform,
): Effect.fn.Return<NativeOverrideResolution> {
  const pathImpl = platform === 'win32' ? win32 : posix;
  if (!pathImpl.isAbsolute(binaryPath)) {
    return { _tag: 'Invalid', issue: 'notAbsolute', path: binaryPath };
  }
  if (!(yield* isLaunchable(binaryPath, platform))) {
    return { _tag: 'Invalid', issue: 'notLaunchable', path: binaryPath };
  }
  return { _tag: 'Valid', path: binaryPath };
});
