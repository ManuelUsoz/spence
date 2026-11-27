import { describe, expect, it } from 'vitest';
import { Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  CheckRunId,
  CommentId,
  PullRequestNumber,
  ReviewThreadId,
  type PullRequestDetail,
  type PullRequestDiff,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import {
  formatPrSnapshot,
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

  describe('formatPrSnapshot', () => {
    const now = Timestamp.make(1_700_000_000_000);
    const makeDetail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
      ref: {
        repo: { host: 'github', canonicalPath: 'acme/spence' },
        number: PullRequestNumber.make(198),
      },
      title: 'Add Composer PR context',
      state: 'open',
      author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
      headRef: 'feat/pr-context',
      headSha: 'abc1234567890',
      headRepo: { host: 'github', canonicalPath: 'acme/spence' },
      baseRef: 'main',
      updatedAt: now,
      url: 'https://github.com/acme/spence/pull/198',
      checkRollup: 'failing',
      reviewDecision: 'changesRequested',
      commentCount: 20,
      unresolvedThreadCount: 30,
      viewerRoles: ['author'],
      isCrossRepo: false,
      body: 'B'.repeat(10_000),
      mergeState: 'blocked',
      autoMergeEnabled: false,
      labels: [{ name: 'enhancement', color: '0e8a16', description: null }],
      reviewers: [],
      assignees: [],
      milestone: null,
      repoLabels: [],
      repoMilestones: [],
      collaborators: [],
      checks: [
        {
          id: CheckRunId.make('chk-pass'),
          name: 'passing-check',
          status: 'completed',
          conclusion: 'success',
          url: 'https://github.com/acme/spence/runs/0',
          summary: 'All good',
          isRequired: true,
        },
        ...Array.from({ length: 22 }, (_, i) => ({
          id: CheckRunId.make(`chk-fail-${i}`),
          name: `failing-check-${i}`,
          status: 'completed' as const,
          conclusion: 'failure' as const,
          url: `https://github.com/acme/spence/runs/${i + 1}`,
          summary: 'S'.repeat(20_000),
          isRequired: true,
        })),
      ],
      reviews: [],
      reviewThreads: [
        {
          id: ReviewThreadId.make('rt-resolved'),
          path: 'src/done.ts',
          line: 5,
          startLine: null,
          side: 'RIGHT',
          isResolved: true,
          isOutdated: false,
          comments: [
            {
              id: CommentId.make('rc-res'),
              author: { login: 'bob', displayName: 'Bob', avatarUrl: null },
              body: 'Resolved comment',
              createdAt: now,
              updatedAt: now,
              url: 'https://github.com/acme/spence/pull/198#r0',
            },
          ],
        },
        ...Array.from({ length: 28 }, (_, i) => ({
          id: ReviewThreadId.make(`rt-${i}`),
          path: `src/file-${i}.ts`,
          line: 10 + i,
          startLine: null,
          side: 'RIGHT' as const,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: CommentId.make(`rc-${i}`),
              author: { login: 'bob', displayName: 'Bob', avatarUrl: null },
              body: `Unresolved note ${i}`,
              createdAt: now,
              updatedAt: now,
              url: `https://github.com/acme/spence/pull/198#r${i + 1}`,
            },
          ],
        })),
      ],
      comments: Array.from({ length: 20 }, (_, i) => ({
        id: CommentId.make(`gc-${i}`),
        author: { login: 'carol', displayName: 'Carol', avatarUrl: null },
        body: `General comment ${i}`,
        createdAt: Timestamp.make(1_700_000_000_000 + i * 1000),
        updatedAt: Timestamp.make(1_700_000_000_000 + i * 1000),
        url: `https://github.com/acme/spence/pull/198#issuecomment-${i}`,
      })),
      actions: {
        canUpdate: true,
        canMerge: false,
        canReview: true,
        canApproveOrRequestChanges: true,
        canResolveThreads: true,
        allowedMergeMethods: ['squash'],
      },
      revision: { headSha: 'abc1234567890', updatedAt: now },
      ...overrides,
    });

    const makeDiff = (fileCount = 3): PullRequestDiff => ({
      ref: {
        repo: { host: 'github', canonicalPath: 'acme/spence' },
        number: PullRequestNumber.make(198),
      },
      headSha: 'abc1234567890',
      baseSha: 'base000000000',
      files: Array.from({ length: fileCount }, (_, i) => ({
        path: `src/file-${i}.ts`,
        status: 'modified' as const,
        additions: 2,
        deletions: 1,
        truncated: i === fileCount - 1 && fileCount > 3,
        hunks: [
          {
            header: '@@ -8,3 +8,4 @@',
            oldStart: 8,
            oldLines: 3,
            newStart: 8,
            newLines: 4,
            lines: [
              { kind: 'context', content: 'const a = 1;', oldLine: 8, newLine: 8 },
              { kind: 'removed', content: 'const b = 2;', oldLine: 9, newLine: null },
              {
                kind: 'added',
                content: `const b = ${i}; ${'X'.repeat(500)}`,
                oldLine: null,
                newLine: 9,
              },
            ],
          },
        ],
      })),
    });

    it('bounds Whole PR snapshot (8 KB body, 20 checks, 25 unresolved threads, 15 comments, 100 files) and omits patches when Worktree HEAD === headSha cleanly', () => {
      const detail = makeDetail();
      const diff = makeDiff(105);

      const snapshot = formatPrSnapshot({
        kind: 'pullRequest',
        detail,
        diff,
        isWorktreeAtHeadCleanly: true,
      });

      expect(snapshot).toContain('PR #198: Add Composer PR context');
      expect(snapshot).toContain('HEAD === headSha cleanly: yes');
      expect(snapshot).toContain('[truncated]');
      expect(snapshot).not.toContain('passing-check');
      expect(snapshot).toContain('failing-check-19');
      expect(snapshot).not.toContain('failing-check-20');
      expect(snapshot).toContain('Resolved threads: 1');
      expect(snapshot).toContain('Unresolved note 24');
      expect(snapshot).not.toContain('Unresolved note 25');
      expect(snapshot).not.toContain('General comment 4');
      expect(snapshot).toContain('General comment 19');
      expect(snapshot).toContain('src/file-99.ts');
      expect(snapshot).not.toContain('src/file-100.ts');
      // Patches must be omitted when Worktree is cleanly at headSha
      expect(snapshot).not.toContain('@@ -8,3 +8,4 @@');
    });

    it('includes bounded 24 KB patches when Worktree is NOT cleanly at headSha', () => {
      const detail = makeDetail({
        body: 'Short body',
        checks: [],
        reviewThreads: [],
        comments: [],
      });
      const diff = makeDiff(80);

      const snapshot = formatPrSnapshot({
        kind: 'pullRequest',
        detail,
        diff,
        isWorktreeAtHeadCleanly: false,
      });

      expect(snapshot).toContain('HEAD === headSha cleanly: no');
      expect(snapshot).toContain('@@ -8,3 +8,4 @@');
      expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(30_000);
    });

    it('formats targeted Review thread with hunk context and resolution state', () => {
      const detail = makeDetail();
      const diff = makeDiff(3);
      const snapshot = formatPrSnapshot({
        kind: 'reviewThread',
        detail,
        diff,
        threadId: ReviewThreadId.make('rt-0'),
      });

      expect(snapshot).toContain('PR #198: Add Composer PR context');
      expect(snapshot).toContain('src/file-0.ts:10');
      expect(snapshot).toContain('Unresolved note 0');
      expect(snapshot).toContain('unresolved');
      expect(snapshot).toContain('@@ -8,3 +8,4 @@');
    });

    it('formats targeted failing Check run with 16 KB summary cap and cached fallback header', () => {
      const detail = makeDetail();
      const snapshot = formatPrSnapshot({
        kind: 'checkRun',
        detail,
        checkId: CheckRunId.make('chk-fail-0'),
        cachedFallbackFetchedAt: now,
      });

      expect(
        snapshot.startsWith(
          '[cached snapshot · fetched at 2023-11-14T22:13:20.000Z; offline/unreachable]',
        ),
      ).toBe(true);
      expect(snapshot).toContain('failing-check-0');
      expect(snapshot).toContain('[truncated]');
      expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(18_000);
    });
  });
});
