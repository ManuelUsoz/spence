import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  gatherDraftCreateInput,
  inspectCreateContext,
  parseDraftAgentReply,
} from './pr-create-git';

const execFileAsync = promisify(execFile);

const git = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, { cwd, windowsHide: true }).then((r) => r.stdout.trimEnd());

const setupRepoWithOrigin = async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'spence-pr-create-'));
  const bare = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  await git(base, 'init', '--bare', bare);
  await git(base, 'clone', bare, work);
  await git(work, 'config', 'user.email', 'test@spence.local');
  await git(work, 'config', 'user.name', 'Spence Test');
  await git(work, 'checkout', '-b', 'main');
  await writeFile(path.join(work, 'README.md'), 'init\n');
  await git(work, 'add', 'README.md');
  await git(work, 'commit', '-m', 'init');
  await git(work, 'push', '-u', 'origin', 'main');
  await git(bare, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(work, 'remote', 'set-head', 'origin', 'main');
  return { base, bare, work };
};

describe('pr-create-git', () => {
  it.effect(
    'inspects createdFromBranch, aheadCount, needsPush, and dirty state in a real repo',
    () =>
      Effect.gen(function* () {
        const { base, work } = yield* Effect.promise(() => setupRepoWithOrigin());
        try {
          yield* Effect.promise(() => git(work, 'checkout', '-b', 'develop'));
          yield* Effect.promise(() => git(work, 'push', '-u', 'origin', 'develop'));
          yield* Effect.promise(() => git(work, 'checkout', '-b', 'feat/login'));
          yield* Effect.promise(() =>
            writeFile(path.join(work, 'auth.ts'), 'export const ok = true;\n'),
          );
          yield* Effect.promise(() => git(work, 'add', 'auth.ts'));
          yield* Effect.promise(() => git(work, 'commit', '-m', 'add auth'));
          yield* Effect.promise(() => writeFile(path.join(work, 'dirty.txt'), 'uncommitted\n'));

          const ctx = yield* inspectCreateContext({
            worktreePath: work,
            targetRemoteName: 'origin',
            headRemoteName: 'origin',
            createdFromBranch: 'develop',
          });

          expect(ctx.headRef).toBe('feat/login');
          expect(ctx.defaultBaseRef).toBe('develop');
          expect(ctx.baseRef).toBe('develop');
          expect(ctx.aheadCount).toBe(1);
          expect(ctx.behindCount).toBe(0);
          expect(ctx.needsPush).toBe(true);
          expect(ctx.isDirty).toBe(true);
        } finally {
          yield* Effect.promise(() => rm(base, { recursive: true, force: true }));
        }
      }),
  );

  it.effect('gathers commit log, diffstat, and unified diff truncated at 24 KB', () =>
    Effect.gen(function* () {
      const { base, work } = yield* Effect.promise(() => setupRepoWithOrigin());
      try {
        yield* Effect.promise(() => git(work, 'checkout', '-b', 'feat/big'));
        yield* Effect.promise(() => writeFile(path.join(work, 'big.txt'), 'line\n'.repeat(10_000)));
        yield* Effect.promise(() => git(work, 'add', 'big.txt'));
        yield* Effect.promise(() => git(work, 'commit', '-m', 'add big file'));

        const draftInput = yield* gatherDraftCreateInput({
          worktreePath: work,
          baseRef: 'main',
          targetRemoteName: 'origin',
          templateBody: '## Summary\n',
        });

        expect(draftInput.commitLog).toContain('add big file');
        expect(draftInput.diffStat).toContain('big.txt');
        expect(Buffer.byteLength(draftInput.unifiedDiff, 'utf8')).toBeLessThanOrEqual(25_000);
        expect(draftInput.unifiedDiff).toContain('[diff truncated at 24 KB]');
        expect(draftInput.templateBody).toBe('## Summary\n');
      } finally {
        yield* Effect.promise(() => rm(base, { recursive: true, force: true }));
      }
    }),
  );

  it('parses JSON or fenced JSON replies from drafting agent', () => {
    const parsed = parseDraftAgentReply(
      '```json\n{"title":"feat: login","body":"Adds login flow"}\n```',
      'fallback',
    );
    expect(parsed).toEqual({ title: 'feat: login', body: 'Adds login flow' });
  });
});
