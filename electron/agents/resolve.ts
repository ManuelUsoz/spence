import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Effect, Option } from 'effect';

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

const isLaunchable = (path: string, platform: NodeJS.Platform): Effect.Effect<boolean> =>
  Effect.tryPromise({
    try: async () => {
      if (!(await stat(path)).isFile()) return false;
      if (platform !== 'win32') await access(path, constants.X_OK);
      return true;
    },
    catch: (error) => error,
  }).pipe(
    // Missing, unreadable or not executable: a PATH folder Spence cannot launch from is simply skipped.
    Effect.catch(() => Effect.succeed(false)),
  );

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
