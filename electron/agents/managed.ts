import { open, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Effect, Option } from 'effect';
import type { AgentId } from '../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from './catalog';

/** Isolated per-Agent prefix under `<userData>/spence/agents/<agentId>/`. */
export const managedAgentDir = (root: string, agentId: AgentId): string =>
  join(root, 'agents', agentId);

export interface ManagedAdapter {
  readonly kind: 'node' | 'binary';
  readonly entrypoint: string;
  readonly version: string;
}

const isWithin = (parent: string, child: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !resolve(rel).startsWith(resolve(parent));
};

const readFirstLine = (filePath: string) =>
  Effect.tryPromise(async () => {
    const handle = await open(filePath, 'r');
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)[0] ?? '';
    } finally {
      await handle.close();
    }
  }).pipe(Effect.catch(() => Effect.succeed('')));

const isNodeEntrypoint = Effect.fnUntraced(function* (entrypoint: string) {
  if (/\.(?:mjs|cjs|js)$/i.test(entrypoint)) return true;
  const shebang = yield* readFirstLine(entrypoint);
  return /^#!.*\bnode\b/i.test(shebang);
});

const resolveBinField = (bin: unknown, binaryName: string): string | undefined => {
  if (typeof bin === 'string' && bin.trim() !== '') return bin;
  if (typeof bin === 'object' && bin !== null && binaryName in bin) {
    const candidate = (bin as Readonly<Record<string, unknown>>)[binaryName];
    return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : undefined;
  }
  return undefined;
};

/**
 * Inspects an isolated adapter prefix (`<userData>/spence/agents/<agentId>/` or a staging dir) without spawning
 * any process, returning the entrypoint and static `package.json` version when valid.
 */
export const inspectManagedPrefix = Effect.fnUntraced(function* (
  prefixDir: string,
  entry: Pick<CatalogEntry, 'package' | 'binary'>,
) {
  if (entry.package === '') return Option.none<ManagedAdapter>();
  const pkgDir = join(prefixDir, 'node_modules', ...entry.package.split('/'));
  const pkgJsonPath = join(pkgDir, 'package.json');
  const raw = yield* Effect.tryPromise(() => readFile(pkgJsonPath, 'utf8')).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (raw === undefined) return Option.none<ManagedAdapter>();
  const parsed = yield* Effect.try((): unknown => JSON.parse(raw)).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('name' in parsed) ||
    !('version' in parsed) ||
    parsed.name !== entry.package ||
    typeof parsed.version !== 'string'
  ) {
    return Option.none<ManagedAdapter>();
  }
  const binRel = resolveBinField('bin' in parsed ? parsed.bin : undefined, entry.binary);
  if (binRel === undefined) return Option.none<ManagedAdapter>();
  const entrypoint = resolve(pkgDir, binRel);
  if (!isWithin(prefixDir, entrypoint)) return Option.none<ManagedAdapter>();
  const exists = yield* Effect.promise(() =>
    stat(entrypoint).then(
      (stats) => stats.isFile(),
      () => false,
    ),
  );
  if (!exists) return Option.none<ManagedAdapter>();
  const kind = (yield* isNodeEntrypoint(entrypoint)) ? 'node' : 'binary';
  return Option.some<ManagedAdapter>({ kind, entrypoint, version: parsed.version });
});

/** Inspects `<root>/agents/<agentId>/` for an installed packaged adapter. */
export const inspectManagedAgent = (
  root: string,
  entry: Pick<CatalogEntry, 'id' | 'package' | 'binary'>,
) => inspectManagedPrefix(managedAgentDir(root, entry.id), entry);
