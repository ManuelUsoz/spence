import { Context, Effect, Layer, Schema } from 'effect';
import path from 'node:path';
import type { ObservationId } from '../../src/shared/history/history.rpc';
import { isSafeStoreId, readJsonDurable, writeBytesDurable } from '../store/durable';
import type { DurableWriteOptions } from '../store/durable';
import { Store, StoreError } from '../store/store';
import { HistoryBlobStore, makeHistoryBlobStoreLayer } from './blob-store';
import type { BlobStoreOptions } from './blob-store';

const Entry = Schema.Struct({
  path: Schema.String,
  /** Hex SHA-256 of the blob holding this entry's exact bytes (or its link target). */
  hash: Schema.String,
  executable: Schema.Boolean,
  kind: Schema.Literals(['File', 'Link']),
});
type ManifestEntry = typeof Entry.Type;

const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Array(Entry),
});

/** Windows treats these base names (with any extension) as devices, not files. */
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const isValidId = (id: string): boolean => isSafeStoreId(id) && !WINDOWS_DEVICE_NAME.test(id);

/** Only relative, non-traversing, non-empty paths may be recorded for later restoration. */
const isValidPath = (p: string): boolean => {
  if (p.length === 0 || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p)) return false;
  return p
    .split(/[\\/]/)
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
};

export interface ObservationFile {
  /** Relative path within the Worktree, recorded for later restoration. */
  readonly path: string;
  /** Exact bytes for a regular file; for a link, the UTF-8 encoded link target. */
  readonly bytes: Uint8Array;
  readonly executable: boolean;
  readonly kind: 'File' | 'Link';
}

export interface ObservationInput {
  readonly id: ObservationId;
  readonly files: ReadonlyArray<ObservationFile>;
}

export interface ObservationPublication {
  readonly id: ObservationId;
  /** Conservative combination of every blob publication and the manifest write. */
  readonly directorySync: 'synced' | 'failed';
}

export interface ObservationStoreOptions {
  readonly blobs?: BlobStoreOptions;
  readonly manifest?: DurableWriteOptions;
}

export class HistoryObservationStore extends Context.Service<
  HistoryObservationStore,
  {
    readonly publish: (
      input: ObservationInput,
    ) => Effect.Effect<ObservationPublication, StoreError>;
    readonly read: (id: ObservationId) => Effect.Effect<ReadonlyArray<ObservationFile>, StoreError>;
  }
>()('history/HistoryObservationStore') {}

/**
 * Publishes a retained workspace observation under `history/observations/<id>.json`.
 *
 * Every file's bytes are published as immutable content-addressed blobs BEFORE the manifest
 * that references them is written, so a manifest can never point at unpublished content.
 * Availability is claimed only after all references are read back and verified. Cleanup and
 * eviction of unreferenced blobs are deliberately out of scope for this slice: a failed
 * manifest write may leave orphaned blobs, which the future recovery slice must reconcile.
 */
export const makeHistoryObservationStoreLayer = (options?: ObservationStoreOptions) =>
  Layer.effect(
    HistoryObservationStore,
    Effect.gen(function* () {
      const store = yield* Store;
      const blobs = yield* HistoryBlobStore;
      const observationsDir = path.resolve(store.root, 'history', 'observations');

      /** Resolves every referenced blob and re-verifies its content, or fails honestly. */
      const resolve = Effect.fn('HistoryObservationStore.resolve')(function* (
        entries: ReadonlyArray<ManifestEntry>,
      ) {
        const files: Array<ObservationFile> = [];
        for (const entry of entries) {
          const bytes = yield* blobs.read(entry.hash);
          files.push({
            path: entry.path,
            bytes,
            executable: entry.executable,
            kind: entry.kind,
          });
        }
        return files;
      });

      const publish = Effect.fn('HistoryObservationStore.publish')(function* (
        input: ObservationInput,
      ) {
        if (!isValidId(input.id)) {
          return yield* new StoreError({
            reason: 'Invalid',
            detail: `Invalid observation id: ${input.id}`,
          });
        }
        const seenPaths = new Set<string>();
        for (const f of input.files) {
          if (!isValidPath(f.path) || seenPaths.has(f.path)) {
            return yield* new StoreError({
              reason: 'Invalid',
              detail: `Invalid or duplicate observation path: ${f.path}`,
            });
          }
          seenPaths.add(f.path);
        }
        const manifestPath = path.join(observationsDir, `${input.id}.json`);
        const entries: Array<ManifestEntry> = [];
        let directorySync: 'synced' | 'failed' = 'synced';

        // 1. Immutable content first; identical content is deduplicated by the blob store.
        for (const file of input.files) {
          const blob = yield* blobs.publish(file.bytes);
          if (blob.directorySync === 'failed') directorySync = 'failed';
          entries.push({
            path: file.path,
            hash: blob.hash,
            executable: file.executable,
            kind: file.kind,
          });
        }

        // 2. Only now write the manifest that references those hashes, durably.
        const encoded = yield* Schema.encodeEffect(Manifest)({ version: 1, entries }).pipe(
          Effect.mapError((err) => new StoreError({ reason: 'Invalid', detail: String(err) })),
        );
        const content = Buffer.from(`${JSON.stringify(encoded, null, 2)}\n`, 'utf8');
        const { directorySync: manifestSync } = yield* writeBytesDurable(
          manifestPath,
          content,
          options?.manifest,
        );
        if (manifestSync === 'failed') directorySync = 'failed';

        // 3. Claim availability only after the persisted manifest's references all verify.
        const persisted = yield* readJsonDurable(manifestPath, Manifest);
        if (persisted === null) {
          return yield* new StoreError({
            reason: 'Invalid',
            detail: `Manifest missing after publication: ${input.id}`,
          });
        }
        yield* resolve(persisted.entries);
        return { id: input.id, directorySync };
      });

      const read = Effect.fn('HistoryObservationStore.read')(function* (id: ObservationId) {
        if (!isValidId(id)) {
          return yield* new StoreError({
            reason: 'Invalid',
            detail: `Invalid observation id: ${id}`,
          });
        }
        const manifest = yield* readJsonDurable(path.join(observationsDir, `${id}.json`), Manifest);
        if (manifest === null) {
          return yield* new StoreError({
            reason: 'NotFound',
            detail: `Missing observation: ${id}`,
          });
        }
        return yield* resolve(manifest.entries);
      });

      return HistoryObservationStore.of({ publish, read });
    }),
  ).pipe(Layer.provide(makeHistoryBlobStoreLayer(options?.blobs)));

export const layerHistoryObservationStore = makeHistoryObservationStoreLayer();
