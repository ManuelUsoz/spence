import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSafeStoreId, readJsonDurable, removeOrphanTempFiles, writeJsonDurable } from './durable';

const SampleSchema = Schema.Struct({
  version: Schema.Literal(1),
  label: Schema.String,
  count: Schema.Number,
});

const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-durable-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

describe('Durable store writes', () => {
  it('validates safe single-segment IDs against path traversal and control characters', () => {
    expect(isSafeStoreId('op-123_abc.1')).toBe(true);
    expect(isSafeStoreId('')).toBe(false);
    expect(isSafeStoreId('.')).toBe(false);
    expect(isSafeStoreId('..')).toBe(false);
    expect(isSafeStoreId('../escape')).toBe(false);
    expect(isSafeStoreId('a/b')).toBe(false);
    expect(isSafeStoreId('a\\b')).toBe(false);
    expect(isSafeStoreId('op:1')).toBe(false);
    expect(isSafeStoreId('.hidden')).toBe(false);
  });

  it.effect('writes and reads schema-validated JSON durably and strips temp files on failure', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const target = path.join(dir, 'operations', 'op-1', 'journal.json');
        yield* writeJsonDurable(target, { version: 1, label: 'prepared', count: 1 }, SampleSchema);

        const loaded = yield* readJsonDurable(target, SampleSchema);
        expect(loaded).toEqual({ version: 1, label: 'prepared', count: 1 });

        // Simulate crash before rename during a subsequent write: previous target stays intact.
        const injected = yield* writeJsonDurable(
          target,
          { version: 1, label: 'applying', count: 2 },
          SampleSchema,
          {
            onStage: (stage) =>
              stage === 'BeforeRename' ? Effect.die('simulated crash before rename') : Effect.void,
          },
        ).pipe(Effect.exit);
        expect(injected._tag).toBe('Failure');

        // Prior durable contents were never torn.
        const preserved = yield* readJsonDurable(target, SampleSchema);
        expect(preserved).toEqual({ version: 1, label: 'prepared', count: 1 });

        // Orphan temp files can be swept cleanly.
        const orphan = `${target}.tmp-99999-deadbeef`;
        yield* Effect.tryPromise(() => writeFile(orphan, 'partial', 'utf8'));
        yield* removeOrphanTempFiles(path.dirname(target));
        const rawAfter = yield* Effect.tryPromise(() => readFile(target, 'utf8'));
        expect(JSON.parse(rawAfter)).toEqual({ version: 1, label: 'prepared', count: 1 });
      }),
    ),
  );

  it.effect('returns null for missing file and Invalid StoreError for corrupt JSON', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const missing = path.join(dir, 'missing.json');
        expect(yield* readJsonDurable(missing, SampleSchema)).toBeNull();

        const corrupt = path.join(dir, 'corrupt.json');
        yield* Effect.tryPromise(() => writeFile(corrupt, '{not json', 'utf8'));
        const res = yield* readJsonDurable(corrupt, SampleSchema).pipe(Effect.result);
        expect(res._tag).toBe('Failure');
        if (res._tag === 'Failure') {
          expect(res.failure.reason).toBe('Invalid');
        }
      }),
    ),
  );
});
