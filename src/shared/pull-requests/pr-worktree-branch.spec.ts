import { describe, expect, it } from 'vitest';
import { computePrWorktreeBranch } from './pr-worktree-branch';

describe('computePrWorktreeBranch', () => {
  it('uses headRef directly for same-repo PRs when it does not collide with an existing branch', () => {
    expect(
      computePrWorktreeBranch({
        number: 42,
        headRef: 'feat/login',
        author: 'alice',
        isCrossRepo: false,
        pattern: 'pr/{number}',
        existingBranches: new Set(['main', 'develop']),
      }),
    ).toBe('feat/login');
  });

  it('uses pattern for same-repo PRs when headRef collides with an existing local branch', () => {
    expect(
      computePrWorktreeBranch({
        number: 42,
        headRef: 'feat/login',
        author: 'alice',
        isCrossRepo: false,
        pattern: 'pr/{number}',
        existingBranches: new Set(['main', 'feat/login']),
      }),
    ).toBe('pr/42');
  });

  it('uses pattern for fork (isCrossRepo) PRs and supports {number}, {headRef}, {author} tokens', () => {
    expect(
      computePrWorktreeBranch({
        number: 42,
        headRef: 'feat/login',
        author: 'alice',
        isCrossRepo: true,
        pattern: 'pr/{number}-{author}',
        existingBranches: new Set(['main']),
      }),
    ).toBe('pr/42-alice');
  });

  it('disambiguates collisions with pr/{number}-{headRef} and numeric suffix if needed', () => {
    expect(
      computePrWorktreeBranch({
        number: 42,
        headRef: 'feat/login',
        author: 'alice',
        isCrossRepo: true,
        pattern: 'pr/{number}',
        existingBranches: new Set(['main', 'pr/42']),
      }),
    ).toBe('pr/42-feat/login');

    expect(
      computePrWorktreeBranch({
        number: 42,
        headRef: 'feat/login',
        author: 'alice',
        isCrossRepo: true,
        pattern: 'pr/{number}',
        existingBranches: new Set(['main', 'pr/42', 'pr/42-feat/login']),
      }),
    ).toBe('pr/42-feat/login-2');
  });
});
