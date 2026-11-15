import { Effect, Schema } from 'effect';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { StoreError } from './store';

const SAFE_STORE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type DurableWriteStage = 'BeforeSync' | 'BeforeRename' | 'AfterRename';

export interface DurableWriteOptions {
  readonly onStage?: (stage: DurableWriteStage) => Effect.Effect<void, StoreError>;
}

/** Validates an opaque identifier used as a single Store folder/file segment (no traversal or separators). */
export const isSafeStoreId = (id: string): boolean => {
  if (!SAFE_STORE_ID_RE.test(id)) return false;
  if (id === '.' || id === '..' || id.includes('..')) return false;
  return true;
};

const isMissingErrno = (error: unknown): boolean => {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const syncDirBestEffort = async (dirPath: string): Promise<void> => {
  try {
    const dirHandle = await open(dirPath, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Directory handles are not fsyncable on some filesystems (notably Windows NTFS); ignore cleanly.
  }
};

/**
 * Encodes `value` with `schema` and writes it durably using explicit file flush (`sync`) before atomic rename.
 * Removes temp artifacts cleanly on failure or defect so partial state never lingers.
 */
export const writeJsonDurable = Effect.fn('DurableStore.writeJson')(function* <A, E, R>(
  targetPath: string,
  value: A,
  schema: Schema.Codec<A, E, R>,
  options?: DurableWriteOptions,
) {
  const encoded = yield* Schema.encodeEffect(schema)(value).pipe(
    Effect.mapError((err) => new StoreError({ reason: 'Invalid', detail: String(err) })),
  );
  const content = `${JSON.stringify(encoded, null, 2)}\n`;
  const dirPath = path.dirname(targetPath);
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;

  let renamed = false;

  yield* Effect.tryPromise({
    try: () => mkdir(dirPath, { recursive: true }),
    catch: (err) => new StoreError({ reason: 'Invalid', detail: String(err) }),
  });

  yield* Effect.gen(function* () {
    yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(tmpPath, 'w'),
        catch: (err) => new StoreError({ reason: 'Invalid', detail: String(err) }),
      }),
      Effect.fnUntraced(function* (handle) {
        yield* Effect.tryPromise({
          try: () => handle.writeFile(content, 'utf8'),
          catch: (err) => new StoreError({ reason: 'Invalid', detail: String(err) }),
        });
        if (options?.onStage !== undefined) {
          yield* options.onStage('BeforeSync');
        }
        yield* Effect.tryPromise({
          try: () => handle.sync(),
          catch: (err) => new StoreError({ reason: 'Invalid', detail: String(err) }),
        });
      }),
      (handle) => Effect.promise(() => handle.close().catch(() => undefined)),
    );

    if (options?.onStage !== undefined) {
      yield* options.onStage('BeforeRename');
    }
    yield* Effect.tryPromise({
      try: () => rename(tmpPath, targetPath),
      catch: (err) => new StoreError({ reason: 'Invalid', detail: String(err) }),
    });
    renamed = true;
    yield* Effect.promise(() => syncDirBestEffort(dirPath));
    if (options?.onStage !== undefined) {
      yield* options.onStage('AfterRename');
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() =>
        renamed
          ? Effect.void
          : Effect.promise(() => rm(tmpPath, { force: true }).catch(() => undefined)),
      ),
    ),
  );
});

/** Reads and validates durable JSON from `targetPath`, returning `null` if the file does not exist yet. */
export const readJsonDurable = Effect.fn('DurableStore.readJson')(function* <A, E, R>(
  targetPath: string,
  schema: Schema.Codec<A, E, R>,
) {
  const raw = yield* Effect.tryPromise({
    try: () => readFile(targetPath, 'utf8'),
    catch: (error): StoreError =>
      isMissingErrno(error)
        ? new StoreError({ reason: 'NotFound', detail: `Missing file: ${targetPath}` })
        : new StoreError({ reason: 'Invalid', detail: String(error) }),
  }).pipe(
    Effect.map((text) => text as string | null),
    Effect.catchTag('StoreError', (err) =>
      err.reason === 'NotFound' ? Effect.succeed(null) : Effect.fail(err),
    ),
  );

  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return yield* new StoreError({
      reason: 'Invalid',
      detail: `Corrupt JSON in ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((err) => new StoreError({ reason: 'Invalid', detail: String(err) })),
  );
});

/** Sweeps leftover `*.tmp-*` files in a Store directory after an unclean crash. */
export const removeOrphanTempFiles = Effect.fn('DurableStore.removeOrphanTempFiles')(function* (
  dirPath: string,
) {
  const entries = yield* Effect.tryPromise(() => readdir(dirPath)).pipe(
    Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
  );

  for (const entry of entries) {
    if (!entry.includes('.tmp-')) continue;
    yield* Effect.promise(() =>
      rm(path.join(dirPath, entry), { force: true }).catch(() => undefined),
    );
  }
});
