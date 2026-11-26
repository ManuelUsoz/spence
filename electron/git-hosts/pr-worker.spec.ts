import { describe, expect, it } from 'vitest';
import {
  normalizeReviewThreads,
  normalizeStatusCheckRollup,
  parseMultiFileUnifiedDiff,
} from './pr-worker';

describe('pr-worker', () => {
  describe('parseMultiFileUnifiedDiff', () => {
    it('parses added, modified, renamed, and binary files with accurate line numbers', () => {
      const rawDiff = [
        'diff --git a/src/added.ts b/src/added.ts',
        'new file mode 100644',
        'index 0000000..1111111',
        '--- /dev/null',
        '+++ b/src/added.ts',
        '@@ -0,0 +1,2 @@',
        '+export const a = 1;',
        '+export const b = 2;',
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 80%',
        'rename from src/old.ts',
        'rename to src/new.ts',
        'index 2222222..3333333 100644',
        '--- a/src/old.ts',
        '+++ b/src/new.ts',
        '@@ -1,3 +1,3 @@ export function f() {',
        ' const x = 1;',
        '-const y = 2;',
        '+const y = 3;',
        ' return x + y;',
        'diff --git a/assets/logo.png b/assets/logo.png',
        'index 4444444..5555555 100644',
        'Binary files a/assets/logo.png and b/assets/logo.png differ',
      ].join('\n');

      const files = parseMultiFileUnifiedDiff(rawDiff);
      expect(files).toHaveLength(3);

      expect(files[0]).toMatchObject({
        path: 'src/added.ts',
        status: 'added',
        additions: 2,
        deletions: 0,
        truncated: false,
      });
      expect(files[0]?.hunks[0]?.lines).toEqual([
        { kind: 'added', content: 'export const a = 1;', oldLine: null, newLine: 1 },
        { kind: 'added', content: 'export const b = 2;', oldLine: null, newLine: 2 },
      ]);

      expect(files[1]).toMatchObject({
        path: 'src/new.ts',
        previousPath: 'src/old.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        truncated: false,
      });
      expect(files[1]?.hunks[0]?.lines).toEqual([
        { kind: 'context', content: 'const x = 1;', oldLine: 1, newLine: 1 },
        { kind: 'removed', content: 'const y = 2;', oldLine: 2, newLine: null },
        { kind: 'added', content: 'const y = 3;', oldLine: null, newLine: 2 },
        { kind: 'context', content: 'return x + y;', oldLine: 3, newLine: 3 },
      ]);

      expect(files[2]).toMatchObject({
        path: 'assets/logo.png',
        status: 'modified',
        hunks: [],
        truncated: false,
        noPreviewReason: 'Binary file',
      });
    });

    it('truncates oversized files at per-file byte/line caps', () => {
      const manyLines = Array.from({ length: 50 }, (_, i) => `+line ${i}`).join('\n');
      const rawDiff = [
        'diff --git a/src/big.ts b/src/big.ts',
        'index 1111111..2222222 100644',
        '--- a/src/big.ts',
        '+++ b/src/big.ts',
        '@@ -1,0 +1,50 @@',
        manyLines,
      ].join('\n');

      const files = parseMultiFileUnifiedDiff(rawDiff, {
        maxFileLines: 10,
        maxFileBytes: 10_000,
        maxTotalBytes: 100_000,
      });
      expect(files).toHaveLength(1);
      expect(files[0]?.truncated).toBe(true);
      expect(files[0]?.hunks[0]?.lines).toHaveLength(10);
      expect(files[0]?.noPreviewReason).toContain('truncated');
    });
  });

  describe('normalizeStatusCheckRollup', () => {
    it('treats neutral and skipped conclusions as non-blocking passing', () => {
      const result = normalizeStatusCheckRollup([
        {
          __typename: 'CheckRun',
          id: 'cr-1',
          name: 'build',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
          detailsUrl: 'https://github.com/org/repo/runs/1',
          isRequired: true,
        },
        {
          __typename: 'CheckRun',
          id: 'cr-2',
          name: 'optional-lint',
          status: 'COMPLETED',
          conclusion: 'NEUTRAL',
          detailsUrl: null,
          isRequired: false,
        },
        {
          __typename: 'CheckRun',
          id: 'cr-3',
          name: 'docs',
          status: 'COMPLETED',
          conclusion: 'SKIPPED',
          detailsUrl: null,
          isRequired: false,
        },
      ]);

      expect(result.checkRollup).toBe('passing');
      expect(result.checks.map((c) => c.conclusion)).toEqual(['success', 'neutral', 'skipped']);
    });

    it('normalizes legacy StatusContext alongside CheckRun and marks failing over pending', () => {
      const result = normalizeStatusCheckRollup([
        {
          __typename: 'CheckRun',
          id: 'cr-1',
          name: 'ci/test',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
          isRequired: false,
        },
        {
          __typename: 'StatusContext',
          id: 'sc-1',
          context: 'legacy/deploy',
          state: 'FAILURE',
          targetUrl: 'https://ci.example.com/1',
          description: 'Deploy failed',
          isRequired: true,
        },
      ]);

      expect(result.checkRollup).toBe('failing');
      expect(result.checks).toHaveLength(2);
      expect(result.checks[0]).toMatchObject({
        name: 'ci/test',
        status: 'inProgress',
        conclusion: null,
      });
      expect(result.checks[1]).toMatchObject({
        name: 'legacy/deploy',
        status: 'completed',
        conclusion: 'failure',
        summary: 'Deploy failed',
        isRequired: true,
      });
    });
  });

  describe('normalizeReviewThreads', () => {
    it('normalizes GraphQL reviewThread nodes into ReviewThread domain objects', () => {
      const threads = normalizeReviewThreads([
        {
          id: 'RT_1',
          path: 'src/app.ts',
          line: 42,
          startLine: 40,
          diffSide: 'RIGHT',
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                id: 'RC_1',
                body: 'Please rename this.',
                createdAt: '2026-11-20T10:00:00Z',
                updatedAt: '2026-11-20T10:05:00Z',
                url: 'https://github.com/org/repo/pull/1#discussion_r1',
                author: { login: 'alice', name: 'Alice', avatarUrl: 'https://avatars/alice' },
              },
            ],
          },
        },
      ]);

      expect(threads).toHaveLength(1);
      expect(threads[0]).toMatchObject({
        id: 'RT_1',
        path: 'src/app.ts',
        line: 42,
        startLine: 40,
        side: 'RIGHT',
        isResolved: false,
        isOutdated: false,
      });
      expect(threads[0]?.comments[0]).toMatchObject({
        id: 'RC_1',
        body: 'Please rename this.',
        author: { login: 'alice', displayName: 'Alice', avatarUrl: 'https://avatars/alice' },
      });
    });
  });
});
