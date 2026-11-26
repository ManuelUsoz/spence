import { describe, expect, it } from 'vitest';
import {
  PullRequestNumber,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { matchWorktreeToPullRequest, parseRemoteUrl, resolveProjectRemote } from './git-host';

const upstreamRepo: RemoteRepoRef = { host: 'github', canonicalPath: 'upstream-org/spence' };
const originRepo: RemoteRepoRef = { host: 'github', canonicalPath: 'fork-user/spence' };

const makePr = (num: number, overrides?: Partial<PullRequestSummary>): PullRequestSummary => ({
  ref: { repo: upstreamRepo, number: PullRequestNumber.make(num) },
  title: `PR #${num}`,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: 'feat/x',
  headSha: 'abc123',
  headRepo: upstreamRepo,
  baseRef: 'main',
  updatedAt: 1_000 + num,
  url: `https://github.com/upstream-org/spence/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: [],
  isCrossRepo: false,
  ...overrides,
});

describe('git-host remote resolution & worktree matching', () => {
  describe('parseRemoteUrl', () => {
    it('parses HTTPS, SSH, SSH alias, and partial-clone URLs into canonical lowercase RemoteRepoRef', () => {
      expect(parseRemoteUrl('https://github.com/ManuelUsoz/Spence.git')).toEqual({
        host: 'github',
        canonicalPath: 'manuelusoz/spence',
      });
      expect(parseRemoteUrl('git@github.com:ManuelUsoz/Spence.git')).toEqual({
        host: 'github',
        canonicalPath: 'manuelusoz/spence',
      });
      expect(parseRemoteUrl('git@github.com-work:ManuelUsoz/Spence')).toEqual({
        host: 'github',
        canonicalPath: 'manuelusoz/spence',
      });
      expect(parseRemoteUrl('ssh://git@github.com/ManuelUsoz/Spence.git')).toEqual({
        host: 'github',
        canonicalPath: 'manuelusoz/spence',
      });
      expect(parseRemoteUrl('https://gitlab.com/org/repo.git')).toBeNull();
    });
  });

  describe('resolveProjectRemote', () => {
    it('selects upstream as target and origin as head in a fork workflow', () => {
      const remotes = [
        'origin\tgit@github.com:fork-user/spence.git (fetch) [blob:none]',
        'origin\tgit@github.com:fork-user/spence.git (push)',
        'upstream\thttps://github.com/upstream-org/spence.git (fetch)',
        'upstream\thttps://github.com/upstream-org/spence.git (push)',
      ].join('\n');

      expect(resolveProjectRemote(remotes)).toEqual({
        repo: upstreamRepo,
        targetRemoteName: 'upstream',
        headRemoteName: 'origin',
        headRepo: originRepo,
        isFork: true,
      });
    });

    it('falls back to origin or first supported remote, and honors targetRemote override', () => {
      const remotes = [
        'origin\tgit@github.com:fork-user/spence.git (fetch)',
        'mirror\thttps://github.com/mirror-org/spence.git (fetch)',
      ].join('\n');

      expect(resolveProjectRemote(remotes)).toEqual({
        repo: originRepo,
        targetRemoteName: 'origin',
        headRemoteName: 'origin',
        headRepo: originRepo,
        isFork: false,
      });

      expect(resolveProjectRemote(remotes, 'mirror')).toEqual({
        repo: { host: 'github', canonicalPath: 'mirror-org/spence' },
        targetRemoteName: 'mirror',
        headRemoteName: 'origin',
        headRepo: originRepo,
        isFork: true,
      });
    });
  });

  describe('matchWorktreeToPullRequest', () => {
    it('returns null for detached HEAD or unpushed branches', () => {
      expect(
        matchWorktreeToPullRequest({
          worktreeBranch: null,
          worktreeHeadSha: 'abc123',
          isDetached: true,
          headRepo: upstreamRepo,
          isFork: false,
          summaries: [makePr(1)],
        }),
      ).toBeNull();

      expect(
        matchWorktreeToPullRequest({
          worktreeBranch: 'feat/unpushed',
          worktreeHeadSha: 'abc123',
          isDetached: false,
          headRepo: upstreamRepo,
          isFork: false,
          summaries: [makePr(1)],
        }),
      ).toBeNull();
    });

    it('prefers open PRs and exposes siblingRefs when multiple open PRs share a branch', () => {
      const link = matchWorktreeToPullRequest({
        worktreeBranch: 'feat/x',
        worktreeHeadSha: 'abc123',
        isDetached: false,
        headRepo: upstreamRepo,
        isFork: false,
        summaries: [
          makePr(10, { updatedAt: 2_000 }),
          makePr(12, { updatedAt: 5_000, state: 'draft' }),
          makePr(8, { state: 'merged', updatedAt: 9_000 }),
        ],
      });

      expect(link?.primary.ref.number).toBe(12);
      expect(link?.openCount).toBe(2);
      expect(link?.siblingRefs.map((r) => r.number)).toEqual([10]);
    });

    it('matches fork PRs only when headRepo matches origin and retains merged PR only while HEAD === headSha', () => {
      const forkPr = makePr(20, {
        headRepo: originRepo,
        isCrossRepo: true,
        state: 'merged',
        headSha: 'sha-merged',
      });
      const otherForkPr = makePr(21, {
        headRepo: { host: 'github', canonicalPath: 'other-user/spence' },
        isCrossRepo: true,
        state: 'open',
      });

      const matched = matchWorktreeToPullRequest({
        worktreeBranch: 'feat/x',
        worktreeHeadSha: 'sha-merged',
        isDetached: false,
        headRepo: originRepo,
        isFork: true,
        summaries: [forkPr, otherForkPr],
      });
      expect(matched?.primary.ref.number).toBe(20);
      expect(matched?.openCount).toBe(0);

      // Once a new commit advances HEAD beyond headSha, link clears
      const afterCommit = matchWorktreeToPullRequest({
        worktreeBranch: 'feat/x',
        worktreeHeadSha: 'sha-new-local-commit',
        isDetached: false,
        headRepo: originRepo,
        isFork: true,
        summaries: [forkPr, otherForkPr],
      });
      expect(afterCommit).toBeNull();
    });
  });
});
