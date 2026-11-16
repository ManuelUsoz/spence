import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer } from 'effect';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StoreError, layerStore } from '../store/store';
import type { BlobStoreOptions } from './blob-store';
import { HistoryBlobStore, layerHistoryBlobStore, makeHistoryBlobStoreLayer } from './blob-store';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-blobs-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

// Deterministic directory-sync result so durability assertions do not depend on the host filesystem.
const synced = { syncDirectory: () => Promise.resolve('synced' as const) };
const layer = (dir: string, options?: BlobStoreOptions) =>
  makeHistoryBlobStoreLayer({ ...synced, ...options }).pipe(Layer.provide(layerStore(dir)));

describe('HistoryBlobStore', () => {
  it.effect('round-trips binary bytes and names the blob by its content hash', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([0, 255, 128, 10, 0, 42]);
        const publication = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        expect(publication.hash).toBe(sha256(bytes));
        expect(publication.status).toBe('Published');
        expect(publication.directorySync).toBe('synced');
        const read = yield* HistoryBlobStore.use((store) => store.read(publication.hash));
        expect(Array.from(read)).toEqual(Array.from(bytes));
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('deduplicates identical content without overwriting or leaving staging files', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
        const first = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        const second = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        expect(first.hash).toBe(second.hash);
        expect(first.status).toBe('Published');
        expect(second.status).toBe('Exists');
        // No filter: a leaked staging file would fail this assertion.
        const entries = yield* Effect.promise(() => readdir(path.join(dir, 'history', 'blobs')));
        expect(entries).toEqual([first.hash]);
        const read = yield* HistoryBlobStore.use((store) => store.read(first.hash));
        expect(Array.from(read)).toEqual(Array.from(bytes));
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('syncs the blob directory again after the no-replace link', () =>
    withTempDir((dir) => {
      const counts = new Map<string, number>();
      const syncDirectory = (dirPath: string) => {
        counts.set(dirPath, (counts.get(dirPath) ?? 0) + 1);
        return Promise.resolve('synced' as const);
      };
      return Effect.gen(function* () {
        const publication = yield* HistoryBlobStore.use((store) =>
          store.publish(Uint8Array.from([11, 22])),
        );
        expect(publication.status).toBe('Published');
        const blobsDir = path.join(dir, 'history', 'blobs');
        // Once in writeBytesDurable's ancestor loop, once after the link created the final entry.
        expect(counts.get(blobsDir) ?? 0).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.provide(layer(dir, { syncDirectory })));
    }),
  );

  it.effect('refuses to reuse a blob whose bytes conflict with its name', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([9, 9, 9]);
        const hash = sha256(bytes);
        const blobsDir = path.join(dir, 'history', 'blobs');
        yield* Effect.promise(() => mkdir(blobsDir, { recursive: true }));
        yield* Effect.promise(() => writeFile(path.join(blobsDir, hash), 'not-the-bytes'));
        const exit = yield* Effect.exit(HistoryBlobStore.use((store) => store.publish(bytes)));
        expect(Exit.isFailure(exit)).toBe(true);
        // The conflicting bytes are never overwritten.
        const still = yield* Effect.promise(() => readFile(path.join(blobsDir, hash), 'utf8'));
        expect(still).toBe('not-the-bytes');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('verifies a matching concurrent winner that reports Exists', () =>
    withTempDir((dir) => {
      const bytes = Uint8Array.from([4, 5, 6]);
      const hash = sha256(bytes);
      // Simulate another publisher creating the final blob between the existence check and the link.
      const publishLink = (_source: string, target: string) =>
        Effect.promise(() => writeFile(target, bytes)).pipe(Effect.as('Exists' as const));
      return Effect.gen(function* () {
        const publication = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        expect(publication.status).toBe('Exists');
        expect(publication.directorySync).toBe('synced');
        const read = yield* HistoryBlobStore.use((store) => store.read(hash));
        expect(Array.from(read)).toEqual(Array.from(bytes));
      }).pipe(Effect.provide(layer(dir, { publishLink })));
    }),
  );

  it.effect('rejects a conflicting concurrent winner that reports Exists', () =>
    withTempDir((dir) => {
      const bytes = Uint8Array.from([4, 5, 6]);
      const hash = sha256(bytes);
      const wrong = Uint8Array.from([9, 9, 9]);
      const blobsDir = path.join(dir, 'history', 'blobs');
      const publishLink = (_source: string, target: string) =>
        Effect.promise(() => writeFile(target, wrong)).pipe(Effect.as('Exists' as const));
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(HistoryBlobStore.use((store) => store.publish(bytes)));
        expect(Exit.isFailure(exit)).toBe(true);
        const still = yield* Effect.promise(() => readFile(path.join(blobsDir, hash)));
        expect(Array.from(still)).toEqual(Array.from(wrong));
      }).pipe(Effect.provide(layer(dir, { publishLink })));
    }),
  );

  it.effect('reconstructs published bytes through a fresh store instance (restart)', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([200, 100, 0, 55, 17]);
        const writer = layer(dir);
        const reader = layerHistoryBlobStore.pipe(Layer.provide(layerStore(dir)));
        const publication = yield* HistoryBlobStore.use((store) => store.publish(bytes)).pipe(
          Effect.provide(writer),
        );
        const read = yield* HistoryBlobStore.use((store) => store.read(publication.hash)).pipe(
          Effect.provide(reader),
        );
        expect(Array.from(read)).toEqual(Array.from(bytes));
      }),
    ),
  );

  it.effect('reports failed durability when directory sync fails but keeps bytes readable', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([7, 7, 7]);
        const publication = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        expect(publication.directorySync).toBe('failed');
        const read = yield* HistoryBlobStore.use((store) => store.read(publication.hash));
        expect(Array.from(read)).toEqual(Array.from(bytes));
      }).pipe(Effect.provide(layer(dir, { syncDirectory: () => Promise.resolve('failed') }))),
    ),
  );

  it.effect('leaves no published or staged blob when the durable write fails', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([3, 1, 4, 1, 5]);
        const failing = layer(dir, {
          onStage: (stage) =>
            stage === 'BeforeRename'
              ? Effect.fail(new StoreError({ reason: 'Invalid', detail: 'injected write failure' }))
              : Effect.void,
        });
        const exit = yield* Effect.exit(
          HistoryBlobStore.use((store) => store.publish(bytes)).pipe(Effect.provide(failing)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const entries = yield* Effect.promise(() =>
          readdir(path.join(dir, 'history', 'blobs')).catch(() => [] as ReadonlyArray<string>),
        );
        expect(entries).toEqual([]);
      }),
    ),
  );

  it.effect('rejects a malformed blob id on read', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          HistoryBlobStore.use((store) => store.read('../etc/passwd')),
        );
        expect(error.reason).toBe('Invalid');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('reports NotFound for an unpublished blob', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          HistoryBlobStore.use((store) => store.read(sha256(Uint8Array.from([1])))),
        );
        expect(error.reason).toBe('NotFound');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('rejects a blob whose bytes no longer match its name', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([8, 8, 8]);
        const publication = yield* HistoryBlobStore.use((store) => store.publish(bytes));
        yield* Effect.promise(() =>
          writeFile(path.join(dir, 'history', 'blobs', publication.hash), 'tampered'),
        );
        const error = yield* Effect.flip(
          HistoryBlobStore.use((store) => store.read(publication.hash)),
        );
        expect(error.reason).toBe('Invalid');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );
});
