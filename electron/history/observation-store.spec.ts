import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Layer } from 'effect';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ObservationId } from '../../src/shared/history/history.rpc';
import { StoreError, layerStore } from '../store/store';
import type { ObservationFile, ObservationStoreOptions } from './observation-store';
import {
  HistoryObservationStore,
  layerHistoryObservationStore,
  makeHistoryObservationStoreLayer,
} from './observation-store';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const file = (bytes: Uint8Array, p = 'a'): ObservationFile => ({
  path: p,
  bytes,
  executable: false,
  kind: 'File' as const,
});

const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-obs-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

const synced = { syncDirectory: () => Promise.resolve('synced' as const) };
const layer = (dir: string, options?: ObservationStoreOptions) =>
  makeHistoryObservationStoreLayer({
    blobs: { ...synced, ...options?.blobs },
    manifest: { ...synced, ...options?.manifest },
  }).pipe(Layer.provide(layerStore(dir)));

const shape = (files: ReadonlyArray<ObservationFile>) =>
  files.map((f) => ({
    path: f.path,
    bytes: Array.from(f.bytes),
    executable: f.executable,
    kind: f.kind,
  }));

describe('HistoryObservationStore', () => {
  it.effect('round-trips exact bytes and type metadata', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const id = ObservationId.make('obs-roundtrip');
        const files: ReadonlyArray<ObservationFile> = [
          file(Uint8Array.from([0, 255, 128, 10, 0, 42]), 'src/a.ts'),
          { ...file(Uint8Array.from([1, 2]), 'bin/run.sh'), executable: true },
          {
            path: 'link',
            bytes: new TextEncoder().encode('../target'),
            executable: false,
            kind: 'Link' as const,
          },
        ];
        const result = yield* HistoryObservationStore.use((s) => s.publish({ id, files }));
        expect(result.id).toBe(id);
        expect(result.directorySync).toBe('synced');
        const read = yield* HistoryObservationStore.use((s) => s.read(id));
        expect(shape(read)).toEqual(shape(files));
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('deduplicates identical content across observations', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bytes = Uint8Array.from([1, 2, 3]);
        yield* HistoryObservationStore.use((s) =>
          s.publish({ id: ObservationId.make('obs-one'), files: [file(bytes)] }),
        );
        yield* HistoryObservationStore.use((s) =>
          s.publish({ id: ObservationId.make('obs-two'), files: [file(bytes, 'b')] }),
        );
        const blobs = yield* Effect.promise(() => readdir(path.join(dir, 'history', 'blobs')));
        expect(blobs).toHaveLength(1);
        const manifests = yield* Effect.promise(() =>
          readdir(path.join(dir, 'history', 'observations')),
        );
        expect([...manifests].sort()).toEqual(['obs-one.json', 'obs-two.json']);
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('never publishes a manifest when its durable write fails', () =>
    withTempDir((dir) => {
      const failing = layer(dir, {
        manifest: {
          onStage: (stage) =>
            stage === 'BeforeRename'
              ? Effect.fail(new StoreError({ reason: 'Invalid', detail: 'injected failure' }))
              : Effect.void,
        },
      });
      return Effect.gen(function* () {
        const id = ObservationId.make('obs-fail');
        const exit = yield* Effect.exit(
          HistoryObservationStore.use((s) =>
            s.publish({ id, files: [file(Uint8Array.from([9]))] }),
          ).pipe(Effect.provide(failing)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const manifests = yield* Effect.promise(() =>
          readdir(path.join(dir, 'history', 'observations')).catch(
            () => [] as ReadonlyArray<string>,
          ),
        );
        expect(manifests).toEqual([]);
        // Nothing claims availability for an unpublished observation.
        const readError = yield* Effect.flip(
          HistoryObservationStore.use((s) => s.read(id)).pipe(Effect.provide(layer(dir))),
        );
        expect(readError.reason).toBe('NotFound');
      });
    }),
  );

  it.effect('refuses to serve an observation whose blob is missing', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const id = ObservationId.make('obs-missing-blob');
        const bytes = Uint8Array.from([7, 7, 7]);
        yield* HistoryObservationStore.use((s) => s.publish({ id, files: [file(bytes)] }));
        yield* Effect.promise(() => rm(path.join(dir, 'history', 'blobs', sha256(bytes))));
        const error = yield* Effect.flip(HistoryObservationStore.use((s) => s.read(id)));
        expect(error.reason).toBe('NotFound');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('refuses to serve an observation whose blob no longer matches its hash', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const id = ObservationId.make('obs-corrupt-blob');
        const bytes = Uint8Array.from([8, 8, 8]);
        yield* HistoryObservationStore.use((s) => s.publish({ id, files: [file(bytes)] }));
        yield* Effect.promise(() =>
          writeFile(path.join(dir, 'history', 'blobs', sha256(bytes)), 'tampered'),
        );
        const error = yield* Effect.flip(HistoryObservationStore.use((s) => s.read(id)));
        expect(error.reason).toBe('Invalid');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('reconstructs published observations through a fresh store (restart)', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const id = ObservationId.make('obs-restart');
        const files: ReadonlyArray<ObservationFile> = [
          { ...file(Uint8Array.from([200, 100, 0, 55]), 'nested/b.bin'), executable: true },
        ];
        yield* HistoryObservationStore.use((s) => s.publish({ id, files })).pipe(
          Effect.provide(layer(dir)),
        );
        const reader = layerHistoryObservationStore.pipe(Layer.provide(layerStore(dir)));
        const read = yield* HistoryObservationStore.use((s) => s.read(id)).pipe(
          Effect.provide(reader),
        );
        expect(shape(read)).toEqual(shape(files));
      }),
    ),
  );

  it.effect('reports failed durability when directory sync fails', () =>
    withTempDir((dir) => {
      const failed = { syncDirectory: () => Promise.resolve('failed' as const) };
      return Effect.gen(function* () {
        const result = yield* HistoryObservationStore.use((s) =>
          s.publish({
            id: ObservationId.make('obs-unsynced'),
            files: [file(Uint8Array.from([3]))],
          }),
        );
        expect(result.directorySync).toBe('failed');
      }).pipe(Effect.provide(layer(dir, { blobs: failed, manifest: failed })));
    }),
  );

  it.effect('reports failed durability when only the manifest sync fails', () =>
    withTempDir((dir) => {
      const failed = { syncDirectory: () => Promise.resolve('failed' as const) };
      return Effect.gen(function* () {
        const result = yield* HistoryObservationStore.use((s) =>
          s.publish({
            id: ObservationId.make('obs-manifest-unsynced'),
            files: [file(Uint8Array.from([4]))],
          }),
        );
        expect(result.directorySync).toBe('failed');
      }).pipe(Effect.provide(layer(dir, { manifest: failed })));
    }),
  );

  it.effect('rejects invalid or duplicate paths before publishing any blob', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const badPaths = ['../escape', '/absolute', 'a/../b', '', 'C:\\drive'];
        for (const bad of badPaths) {
          const error = yield* Effect.flip(
            HistoryObservationStore.use((s) =>
              s.publish({
                id: ObservationId.make('obs-bad-path'),
                files: [file(Uint8Array.from([1]), bad)],
              }),
            ),
          );
          expect(error.reason).toBe('Invalid');
        }
        const duplicate = yield* Effect.flip(
          HistoryObservationStore.use((s) =>
            s.publish({
              id: ObservationId.make('obs-duplicate-path'),
              files: [file(Uint8Array.from([1]), 'same'), file(Uint8Array.from([2]), 'same')],
            }),
          ),
        );
        expect(duplicate.reason).toBe('Invalid');
        const blobs = yield* Effect.promise(() =>
          readdir(path.join(dir, 'history', 'blobs')).catch(() => [] as ReadonlyArray<string>),
        );
        expect(blobs).toEqual([]);
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('rejects a Windows reserved device name as an observation id', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          HistoryObservationStore.use((s) =>
            s.publish({ id: ObservationId.make('NUL'), files: [file(Uint8Array.from([1]))] }),
          ),
        );
        expect(error.reason).toBe('Invalid');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );

  it.effect('rejects invalid ids and reports missing observations', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const bad = ObservationId.make('../escape');
        const publishError = yield* Effect.flip(
          HistoryObservationStore.use((s) => s.publish({ id: bad, files: [] })),
        );
        expect(publishError.reason).toBe('Invalid');
        const readError = yield* Effect.flip(HistoryObservationStore.use((s) => s.read(bad)));
        expect(readError.reason).toBe('Invalid');
        const missing = yield* Effect.flip(
          HistoryObservationStore.use((s) => s.read(ObservationId.make('never-published'))),
        );
        expect(missing.reason).toBe('NotFound');
      }).pipe(Effect.provide(layer(dir))),
    ),
  );
});
