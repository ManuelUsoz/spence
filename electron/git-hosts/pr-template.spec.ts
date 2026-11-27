import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { detectPrTemplate } from './pr-template';

const execFileAsync = promisify(execFile);

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd, windowsHide: true }).then((r) => r.stdout.trimEnd());

const initRepo = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'spence-pr-tpl-'));
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@spence.local');
  await git(dir, 'config', 'user.name', 'Spence Test');
  await writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-m', 'init');
  return dir;
};

describe('detectPrTemplate', () => {
  it.effect('returns null when no template exists', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => initRepo());
      try {
        expect(yield* detectPrTemplate(dir)).toBeNull();
      } finally {
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
      }
    }),
  );

  it.effect(
    'loads .github/PULL_REQUEST_TEMPLATE.md case-insensitively and prefers .github over root and docs',
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => initRepo());
        try {
          yield* Effect.promise(() => mkdir(path.join(dir, 'docs'), { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(path.join(dir, 'docs', 'pull_request_template.md'), 'docs template\n'),
          );
          yield* Effect.promise(() => git(dir, 'add', '.'));
          yield* Effect.promise(() => git(dir, 'commit', '-m', 'add docs template'));
          expect(yield* detectPrTemplate(dir)).toBe('docs template');

          yield* Effect.promise(() =>
            writeFile(path.join(dir, 'PULL_REQUEST_TEMPLATE.md'), 'root template\n'),
          );
          yield* Effect.promise(() => git(dir, 'add', '.'));
          yield* Effect.promise(() => git(dir, 'commit', '-m', 'add root template'));
          expect(yield* detectPrTemplate(dir)).toBe('root template');

          yield* Effect.promise(() => mkdir(path.join(dir, '.github'), { recursive: true }));
          yield* Effect.promise(() =>
            writeFile(path.join(dir, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'github template\n'),
          );
          yield* Effect.promise(() => git(dir, 'add', '.'));
          yield* Effect.promise(() => git(dir, 'commit', '-m', 'add github template'));
          expect(yield* detectPrTemplate(dir)).toBe('github template');
        } finally {
          yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
        }
      }),
  );

  it.effect('caps templates at 8 KB and appends [truncated]', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => initRepo());
      try {
        yield* Effect.promise(() => mkdir(path.join(dir, '.github'), { recursive: true }));
        yield* Effect.promise(() =>
          writeFile(path.join(dir, '.github', 'pull_request_template.md'), 'a'.repeat(12_000)),
        );
        yield* Effect.promise(() => git(dir, 'add', '.'));
        yield* Effect.promise(() => git(dir, 'commit', '-m', 'add large template'));

        const tpl = yield* detectPrTemplate(dir);
        expect(tpl).not.toBeNull();
        expect(tpl?.endsWith('[truncated]')).toBe(true);
        expect((tpl ?? '').length).toBeLessThan(8_500);
      } finally {
        yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
      }
    }),
  );
});
