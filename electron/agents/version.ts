import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
import type { VersionQualification } from '../../src/shared/agents/agents.rpc';

/** How an Agent's installed version is qualified against Spence's baseline. */
export type VersionSpec =
  | { readonly kind: 'exact'; readonly version: string }
  | { readonly kind: 'min'; readonly version: string };

const SEMVER_RE = /(\d+)\.(\d+)(?:\.(\d+))?/;

/** Parses the first `major.minor[.patch]` triple from a version string or CLI output. */
export const parseSemver = (raw: string): readonly [number, number, number] | undefined => {
  const match = SEMVER_RE.exec(raw.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
};

const compareSemver = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
};

/** Normalizes a version string to `major.minor.patch` when parseable. */
export const normalizeVersion = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined;
  const parsed = parseSemver(raw);
  return parsed === undefined ? undefined : `${parsed[0]}.${parsed[1]}.${parsed[2]}`;
};

/** Evaluates whether `installed` satisfies `spec`. Unknown or mismatched versions are `'unverified'`. */
export const qualifyVersion = (
  installed: string | undefined,
  spec: VersionSpec,
): VersionQualification => {
  if (installed === undefined) return 'unverified';
  const actual = parseSemver(installed);
  const target = parseSemver(spec.version);
  if (actual === undefined || target === undefined) return 'unverified';
  const cmp = compareSemver(actual, target);
  return spec.kind === 'exact'
    ? cmp === 0
      ? 'qualified'
      : 'unverified'
    : cmp >= 0
      ? 'qualified'
      : 'unverified';
};

const readPackageVersion = async (
  filePath: string,
  expectedPackage: string,
): Promise<string | undefined> => {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'name' in parsed &&
      'version' in parsed &&
      parsed.name === expectedPackage &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Statically reads an installed npm adapter's `package.json` version without spawning any process.
 * Checks standard Windows npm global shims (`<bin>/node_modules/<pkg>/package.json`), POSIX `../lib/node_modules`,
 * and parent directories of the realpath-resolved executable.
 */
export const inspectNpmPackageVersion = (
  resolvedPath: string,
  packageName: string,
): Effect.Effect<string | undefined> =>
  Effect.promise(async () => {
    const pkgSegments = packageName.split('/');
    const binDir = dirname(resolvedPath);
    const candidates: Array<string> = [
      join(binDir, 'node_modules', ...pkgSegments, 'package.json'),
      join(binDir, '..', 'lib', 'node_modules', ...pkgSegments, 'package.json'),
    ];
    try {
      let current = dirname(await realpath(resolvedPath));
      for (let depth = 0; depth < 6; depth += 1) {
        candidates.push(join(current, 'package.json'));
        const parent = resolve(current, '..');
        if (parent === current) break;
        current = parent;
      }
    } catch {
      // Ignore realpath failure (e.g. broken symlink) and fall back to shim candidates.
    }
    for (const candidate of candidates) {
      const version = await readPackageVersion(candidate, packageName);
      if (version !== undefined) return version;
    }
    return undefined;
  });

export interface NativeVersionCache {
  /** Returns the cached version if `(binaryPath, mtimeMs)` matches; never spawns. */
  readonly peek: (binaryPath: string) => Effect.Effect<string | undefined>;
  /** Returns the cached version or runs `probe` once and caches by `(binaryPath, mtimeMs)`. */
  readonly inspect: (binaryPath: string) => Effect.Effect<string | undefined>;
}

/**
 * Caches native binary `--version` inspections by `(binaryPath, mtimeMs)` so `Agents.list` stays stat-only and
 * repeated launch/explicit checks avoid redundant spawns.
 */
export const makeNativeVersionCache = (
  probe: (binaryPath: string) => Effect.Effect<string | undefined>,
): NativeVersionCache => {
  const entries = new Map<
    string,
    { readonly mtimeMs: number; readonly version: string | undefined }
  >();

  const readMtime = (binaryPath: string) =>
    Effect.tryPromise(() => stat(binaryPath).then((info) => info.mtimeMs)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );

  const peek = Effect.fnUntraced(function* (binaryPath: string) {
    const mtimeMs = yield* readMtime(binaryPath);
    if (mtimeMs === undefined) return undefined;
    const cached = entries.get(binaryPath);
    return cached !== undefined && cached.mtimeMs === mtimeMs ? cached.version : undefined;
  });

  const inspect = Effect.fnUntraced(function* (binaryPath: string) {
    const mtimeMs = yield* readMtime(binaryPath);
    if (mtimeMs === undefined) return undefined;
    const cached = entries.get(binaryPath);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.version;
    const version = yield* probe(binaryPath);
    entries.set(binaryPath, { mtimeMs, version });
    return version;
  });

  return { peek, inspect };
};
