import { describe, expect, it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { publishNoReplace } from './no-replace';

const withTempDir = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-link-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

describe('publishNoReplace', () => {
  it.effect('exposes subsequent source writes through the target', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const source = path.join(dir, 'source');
        const target = path.join(dir, 'target');
        yield* Effect.promise(() => writeFile(source, 'before'));
        expect(yield* publishNoReplace(source, target)).toBe('Published');
        yield* Effect.promise(() => writeFile(source, 'after'));
        expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe('after');
      }),
    ),
  );

  it.effect('preserves existing target and source bytes', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const source = path.join(dir, 'source');
        const target = path.join(dir, 'target');
        yield* Effect.promise(() => writeFile(source, 'new'));
        yield* Effect.promise(() => writeFile(target, 'original'));
        expect(yield* publishNoReplace(source, target)).toBe('Exists');
        expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe('original');
        expect(yield* Effect.promise(() => readFile(source, 'utf8'))).toBe('new');
      }),
    ),
  );

  it.effect('publishes exactly once under concurrent attempts', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const source = path.join(dir, 'source');
        const target = path.join(dir, 'target');
        yield* Effect.promise(() => writeFile(source, 'bytes'));
        const results = yield* Effect.all(
          [publishNoReplace(source, target), publishNoReplace(source, target)],
          { concurrency: 'unbounded' },
        );
        expect([...results].sort()).toEqual(['Exists', 'Published']);
        expect(yield* Effect.promise(() => readFile(target, 'utf8'))).toBe('bytes');
        expect(yield* Effect.promise(() => readFile(source, 'utf8'))).toBe('bytes');
      }),
    ),
  );

  it.effect('propagates non-EEXIST failures instead of reporting Exists', () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const source = path.join(dir, 'missing');
        const target = path.join(dir, 'target');
        const exit = yield* Effect.exit(publishNoReplace(source, target));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect((Cause.squash(exit.cause) as { code?: unknown }).code).toBe('ENOENT');
        }
      }),
    ),
  );
});
