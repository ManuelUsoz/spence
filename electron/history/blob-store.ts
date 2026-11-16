import { Context, Effect, Layer } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeBytesDurable } from '../store/durable';
import type { DurableWriteOptions } from '../store/durable';
import { publishNoReplace, type PublishResult } from '../store/no-replace';
import { Store, StoreError } from '../store/store';

/** A blob is named by the hex SHA-256 of its bytes; this is also the path validation rule. */
const HASH_RE = /^[a-f0-9]{64}$/;

export interface BlobPublication {
  readonly hash: string;
  readonly status: 'Published' | 'Exists';
  /** Whether the directory entries for the blob (and any new ancestors) were confirmed durable. */
  readonly directorySync: 'synced' | 'failed';
}

export interface BlobStoreOptions extends DurableWriteOptions {
  /**
   * Overridable for tests: the atomic no-replace publication step. An injected `'Exists'`
   * simulates another publisher winning the race between the existence check and the link.
   */
  readonly publishLink?: (source: string, target: string) => Effect.Effect<PublishResult>;
}

export class HistoryBlobStore extends Context.Service<
  HistoryBlobStore,
  {
    readonly publish: (bytes: Uint8Array) => Effect.Effect<BlobPublication, StoreError>;
    readonly read: (hash: string) => Effect.Effect<Uint8Array, StoreError>;
  }
>()('history/HistoryBlobStore') {}

const fingerprint = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const isMissing = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  ((cause as { code?: unknown }).code === 'ENOENT' ||
    (cause as { code?: unknown }).code === 'ENOTDIR');

/** Reads a file if present; a missing path is `null`, any other I/O failure is a typed error. */
const readIfPresent = (filePath: string): Effect.Effect<Uint8Array | null, StoreError> =>
  Effect.tryPromise({
    try: () => readFile(filePath),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((buffer): Uint8Array | null => new Uint8Array(buffer)),
    Effect.catch((cause) =>
      isMissing(cause)
        ? Effect.succeed<Uint8Array | null>(null)
        : Effect.fail(new StoreError({ reason: 'Invalid', detail: String(cause) })),
    ),
  );

/** Directory fsync is best effort: some filesystems (notably Windows NTFS) cannot fsync a directory handle. */
const syncDirBestEffort = async (dirPath: string): Promise<'synced' | 'failed'> => {
  try {
    const handle = await open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return 'synced';
  } catch {
    return 'failed';
  }
};

/** A single best-effort directory sync, injectable so tests can force an explicit failure result. */
const syncBlobsDir = (
  blobsDir: string,
  options?: BlobStoreOptions,
): Effect.Effect<'synced' | 'failed'> =>
  Effect.promise(async () => {
    const sync = options?.syncDirectory ?? syncDirBestEffort;
    try {
      return await sync(blobsDir);
    } catch {
      return 'failed' as const;
    }
  });

/**
 * Publishes bytes as an immutable, content-addressed blob under `history/blobs/<sha256>`.
 *
 * Bytes are written durably to a uniquely named staging file, then published with an atomic
 * no-replace hard link, so an existing blob is never overwritten. When the destination already
 * exists its bytes are verified against the hash before reuse; a mismatch is a conflict, never
 * a silent overwrite. The staging name is removed after publication, leaving the blob with no
 * writable alias. Cleanup/eviction and reference publication are deliberately out of scope;
 * a crash between link and removal leaves a `.staging-*` file that the future recovery slice
 * must reconcile against references before sweeping (the existing sweeper only targets `.tmp-*`).
 */
const publishBytes = Effect.fn('HistoryBlobStore.publish')(function* (
  blobsDir: string,
  bytes: Uint8Array,
  options?: BlobStoreOptions,
) {
  const hash = fingerprint(bytes);
  const finalPath = path.join(blobsDir, hash);

  yield* Effect.tryPromise({
    try: () => mkdir(blobsDir, { recursive: true }),
    catch: (cause) => new StoreError({ reason: 'Invalid', detail: String(cause) }),
  });

  const existing = yield* readIfPresent(finalPath);
  if (existing !== null) {
    if (fingerprint(existing) !== hash) {
      return yield* new StoreError({
        reason: 'Invalid',
        detail: `Conflicting blob content for ${hash}`,
      });
    }
    // Re-syncing the directory confirms the existing entry is durable now; it does not
    // retroactively change the outcome of the earlier publication.
    const directorySync = yield* syncBlobsDir(blobsDir, options);
    return { hash, status: 'Exists' as const, directorySync };
  }

  const stagingPath = path.join(blobsDir, `.staging-${process.pid}-${randomUUID()}`);
  return yield* Effect.gen(function* () {
    // writeBytesDurable syncs the file and every ancestor of the staging path (covering any
    // newly created history/blobs directories).
    const { directorySync: beforeLink } = yield* writeBytesDurable(stagingPath, bytes, options);
    const link = options?.publishLink ?? publishNoReplace;
    const status = yield* link(stagingPath, finalPath);

    if (status === 'Exists') {
      // Another publisher won the race. Reuse only if the bytes really are this content.
      const current = yield* readIfPresent(finalPath);
      if (current === null || fingerprint(current) !== hash) {
        return yield* new StoreError({
          reason: 'Invalid',
          detail: `Conflicting blob content for ${hash}`,
        });
      }
    }

    // The no-replace link created a new directory entry after writeBytesDurable synced the
    // directory, so confirm that entry too. Report the conservative combination.
    const afterLink = yield* syncBlobsDir(blobsDir, options);
    const directorySync =
      beforeLink === 'synced' && afterLink === 'synced' ? ('synced' as const) : ('failed' as const);
    return { hash, status, directorySync };
  }).pipe(
    Effect.ensuring(Effect.promise(() => rm(stagingPath, { force: true }).catch(() => undefined))),
  );
});

/** Reads a blob by hash and verifies its bytes, so corrupt or substituted content is never served. */
const readBytes = Effect.fn('HistoryBlobStore.read')(function* (blobsDir: string, hash: string) {
  if (!HASH_RE.test(hash)) {
    return yield* new StoreError({ reason: 'Invalid', detail: `Invalid blob id: ${hash}` });
  }
  const bytes = yield* readIfPresent(path.join(blobsDir, hash));
  if (bytes === null) {
    return yield* new StoreError({ reason: 'NotFound', detail: `Missing blob: ${hash}` });
  }
  if (fingerprint(bytes) !== hash) {
    return yield* new StoreError({ reason: 'Invalid', detail: `Corrupt blob: ${hash}` });
  }
  return bytes;
});

export const makeHistoryBlobStoreLayer = (options?: BlobStoreOptions) =>
  Layer.effect(
    HistoryBlobStore,
    Effect.gen(function* () {
      const store = yield* Store;
      const blobsDir = path.resolve(store.root, 'history', 'blobs');
      return HistoryBlobStore.of({
        publish: (bytes) => publishBytes(blobsDir, bytes, options),
        read: (hash) => readBytes(blobsDir, hash),
      });
    }),
  );

export const layerHistoryBlobStore = makeHistoryBlobStoreLayer();
