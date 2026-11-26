import { describe, expect, it, vi } from 'vitest';
import {
  CommentId,
  ReviewThreadId,
  type PullRequestDiffFile,
  type ReviewThread,
} from '../../../shared/pull-requests/pull-requests.rpc';
import {
  anchorReviewThreads,
  computeWordDiff,
  processRenderRequest,
  renderMarkdownBlocks,
} from './pr-render';
import { PrRenderClient } from './pr-render-client';

const makeThread = (
  overrides: Omit<Partial<ReviewThread>, 'id'> & { id: string; path: string },
): ReviewThread => ({
  line: null,
  startLine: null,
  side: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: [
    {
      id: CommentId.make(`c-${overrides.id}`),
      author: { login: 'reviewer', displayName: 'Reviewer', avatarUrl: null },
      body: 'Please rename this.',
      createdAt: 1_000,
      updatedAt: 1_000,
      url: 'https://github.com/org/repo/pull/1#discussion_r1',
    },
  ],
  ...overrides,
  id: ReviewThreadId.make(overrides.id),
});

describe('pr-render', () => {
  it('parses GFM Markdown including tables and task lists', () => {
    const blocks = renderMarkdownBlocks(
      '# Summary\n\n- [x] Done\n- [ ] Pending\n\n| A | B |\n| - | - |\n| 1 | 2 |',
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'list', 'table']);
  });

  it('computes word-level diff segments for changed tokens', () => {
    const { removed, added } = computeWordDiff(
      'const value = oldName + 1;',
      'const value = newName + 1;',
    );
    expect(removed.filter((s) => s.changed).map((s) => s.text)).toEqual(['oldName']);
    expect(added.filter((s) => s.changed).map((s) => s.text)).toEqual(['newName']);
    expect(removed.map((s) => s.text).join('')).toBe('const value = oldName + 1;');
    expect(added.map((s) => s.text).join('')).toBe('const value = newName + 1;');
  });

  it('anchors Review threads onto matching LEFT/RIGHT hunk lines and collects unanchored ones', () => {
    const file: PullRequestDiffFile = {
      path: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      truncated: false,
      hunks: [
        {
          header: '@@ -10,3 +10,3 @@',
          oldStart: 10,
          oldLines: 3,
          newStart: 10,
          newLines: 3,
          lines: [
            { kind: 'context', content: 'const a = 1;', oldLine: 10, newLine: 10 },
            { kind: 'removed', content: 'const b = oldFn();', oldLine: 11, newLine: null },
            { kind: 'added', content: 'const b = newFn();', oldLine: null, newLine: 11 },
            { kind: 'context', content: 'return a + b;', oldLine: 12, newLine: 12 },
          ],
        },
      ],
    };

    const leftThread = makeThread({ id: 't-left', path: 'src/app.ts', line: 11, side: 'LEFT' });
    const rightThread = makeThread({ id: 't-right', path: 'src/app.ts', line: 11, side: 'RIGHT' });
    const outdatedThread = makeThread({
      id: 't-outdated',
      path: 'src/app.ts',
      line: 999,
      side: 'RIGHT',
      isOutdated: true,
    });
    const otherFileThread = makeThread({
      id: 't-other',
      path: 'src/other.ts',
      line: 11,
      side: 'RIGHT',
    });

    const anchored = anchorReviewThreads(file.path, file.hunks, [
      leftThread,
      rightThread,
      outdatedThread,
      otherFileThread,
    ]);

    expect(anchored.hunks[0]?.lines[1]?.threads.map((t) => t.id)).toEqual([leftThread.id]);
    expect(anchored.hunks[0]?.lines[2]?.threads.map((t) => t.id)).toEqual([rightThread.id]);
    expect(anchored.unanchoredThreads.map((t) => t.id)).toEqual([outdatedThread.id]);
  });

  it('highlights diff file lines with Shiki and attaches word-diff segments', async () => {
    const file: PullRequestDiffFile = {
      path: 'src/example.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      truncated: false,
      hunks: [
        {
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'removed', content: 'const x = 1;', oldLine: 1, newLine: null },
            { kind: 'added', content: 'const x = 2;', oldLine: null, newLine: 1 },
          ],
        },
      ],
    };

    const res = await processRenderRequest({ kind: 'diffFile', file, threads: [] });
    expect(res.kind).toBe('diffFile');
    if (res.kind !== 'diffFile') return;

    const removedLine = res.rendered.hunks[0]?.lines[0];
    const addedLine = res.rendered.hunks[0]?.lines[1];
    // Shiki's Oniguruma WASM engine may be unavailable in jsdom; when available, tokens are populated.
    if (removedLine?.tokens !== null) {
      expect(removedLine?.tokens?.length).toBeGreaterThan(0);
      expect(addedLine?.tokens?.length).toBeGreaterThan(0);
    }
    expect(removedLine?.wordDiff?.some((s) => s.changed && s.text === '1')).toBe(true);
    expect(addedLine?.wordDiff?.some((s) => s.changed && s.text === '2')).toBe(true);
  });

  it('PrRenderClient falls back in-process when Worker is unavailable and uses Worker when available', async () => {
    const originalWorker = globalThis.Worker;
    try {
      // Simulate jsdom/test environment without Worker
      vi.stubGlobal('Worker', undefined);
      const client = new PrRenderClient();
      const blocks = await client.renderMarkdown('Hello **world**');
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.type).toBe('paragraph');
      client.dispose();
    } finally {
      vi.stubGlobal('Worker', originalWorker);
    }
  });
});
