import { describe, expect, it } from 'vitest';
import { ProjectId, Timestamp } from '../../../shared/projects/projects.rpc';
import {
  CheckRunId,
  PullRequestNumber,
  ReviewThreadId,
  type PullRequestSummary,
} from '../../../shared/pull-requests/pull-requests.rpc';
import type { ComposerPullRequestAttachment } from '../../../shared/sessions/sessions.rpc';
import {
  addPrAttachment,
  parseActiveAtMention,
  parsePrNumberQuery,
  prAttachmentLabel,
  prAttachmentTooltip,
  rankAndFilterPrs,
  stripAtMentionToken,
} from './composer-pr-picker';

const projectId = ProjectId.make('proj-1');
const makePr = (num: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  ref: {
    repo: { host: 'github', canonicalPath: 'acme/spence' },
    number: PullRequestNumber.make(num),
  },
  title: `PR title ${num}`,
  state: 'open',
  author: { login: `user${num}`, displayName: null, avatarUrl: null },
  headRef: `feat/branch-${num}`,
  headSha: `sha${num}000000`,
  headRepo: { host: 'github', canonicalPath: 'acme/spence' },
  baseRef: 'main',
  updatedAt: Timestamp.make(1_700_000_000_000),
  url: `https://github.com/acme/spence/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: ['author'],
  isCrossRepo: false,
  ...overrides,
});

describe('composer-pr-picker', () => {
  it('parses @ mention at start or after whitespace and ignores email-like mid-word @', () => {
    expect(parseActiveAtMention('@198', 4)).toEqual({ start: 0, end: 4, query: '198' });
    expect(parseActiveAtMention('check @feat', 11)).toEqual({ start: 6, end: 11, query: 'feat' });
    expect(parseActiveAtMention('foo@bar.com', 11)).toBeNull();
    expect(parseActiveAtMention('@198 done', 9)).toBeNull();
  });

  it('strips @query token cleanly on selection', () => {
    const mention = parseActiveAtMention('Review @#198 please', 12)!;
    expect(stripAtMentionToken('Review @#198 please', mention)).toEqual({
      text: 'Review please',
      caret: 6,
    });
  });

  it('ranks linked Worktree PR first and filters by number, title, branch, or author', () => {
    const prs = [
      makePr(10),
      makePr(20, { author: { login: 'alice', displayName: null, avatarUrl: null } }),
    ];
    const ranked = rankAndFilterPrs({
      summaries: prs,
      linkedPrNumber: PullRequestNumber.make(20),
      query: '',
    });
    expect(ranked.map((p) => p.ref.number)).toEqual([20, 10]);

    expect(
      rankAndFilterPrs({ summaries: prs, linkedPrNumber: null, query: 'alice' }).map(
        (p) => p.ref.number,
      ),
    ).toEqual([20]);
  });

  it('parses @#number queries for on-demand lookup', () => {
    expect(parsePrNumberQuery('#198')).toBe(198);
    expect(parsePrNumberQuery('#0')).toBeNull();
    expect(parsePrNumberQuery('feat')).toBeNull();
  });

  it('deduplicates attachments and enforces the 5-attachment cap', () => {
    let list: ReadonlyArray<ComposerPullRequestAttachment> = [];
    for (let i = 1; i <= 5; i++) {
      const res = addPrAttachment(list, {
        kind: 'pullRequest',
        projectId,
        ref: makePr(i).ref,
        title: `PR ${i}`,
        state: 'open',
        headSha: 'abc1234',
        url: `https://github.com/acme/spence/pull/${i}`,
      });
      expect(res.added).toBe(true);
      list = res.list;
    }

    const dup = addPrAttachment(list, {
      kind: 'pullRequest',
      projectId,
      ref: makePr(1).ref,
      title: 'PR 1',
      state: 'open',
      headSha: 'abc1234',
      url: 'https://github.com/acme/spence/pull/1',
    });
    expect(dup.added).toBe(false);
    expect(dup.reason).toBe('duplicate');

    const over = addPrAttachment(list, {
      kind: 'pullRequest',
      projectId,
      ref: makePr(6).ref,
      title: 'PR 6',
      state: 'open',
      headSha: 'abc1234',
      url: 'https://github.com/acme/spence/pull/6',
    });
    expect(over.added).toBe(false);
    expect(over.reason).toBe('limit');
  });

  it('formats labels and tooltips for PR, Review thread, and Check run pills', () => {
    expect(
      prAttachmentLabel({
        kind: 'pullRequest',
        ref: makePr(198).ref,
        title: 'Add context',
      }),
    ).toBe('PR #198 · Add context');

    expect(
      prAttachmentLabel({
        kind: 'reviewThread',
        ref: makePr(198).ref,
        title: 'Add context',
        path: 'src/app.ts',
        line: 42,
        threadId: ReviewThreadId.make('rt-1'),
      } as ComposerPullRequestAttachment),
    ).toBe('Review thread · src/app.ts:42');

    expect(
      prAttachmentLabel({
        kind: 'checkRun',
        ref: makePr(198).ref,
        title: 'Add context',
        checkId: CheckRunId.make('chk-1'),
        checkName: 'unit-tests',
      } as ComposerPullRequestAttachment),
    ).toBe('Check · unit-tests');

    expect(prAttachmentTooltip({ headSha: 'abc1234567890', state: 'open' })).toBe('abc1234 · open');
  });
});
