export interface ComputePrWorktreeBranchInput {
  readonly number: number;
  readonly headRef: string;
  readonly author: string;
  readonly isCrossRepo: boolean;
  readonly pattern: string;
  readonly existingBranches: ReadonlySet<string>;
}

const sanitizeBranchToken = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\]\\]+/g, '-')
    .replace(/^-+|-+$/g, '');

const expandBranchPattern = (
  pattern: string,
  input: Pick<ComputePrWorktreeBranchInput, 'number' | 'headRef' | 'author'>,
): string => {
  const safeAuthor = sanitizeBranchToken(input.author) || 'author';
  const safeHead = sanitizeBranchToken(input.headRef) || `pr-${input.number}`;
  const raw = (pattern.trim() || 'pr/{number}')
    .replaceAll('{number}', String(input.number))
    .replaceAll('{headRef}', safeHead)
    .replaceAll('{author}', safeAuthor);
  return raw.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
};

/**
 * Computes the local branch name for a lazy PR Worktree:
 * - Same-repo PRs (`!isCrossRepo`) use `{headRef}` when it does not collide with an existing branch.
 * - Fork PRs or colliding branches apply `Settings.pullRequests.worktreeBranchPattern` (default `pr/{number}`),
 *   disambiguating collisions with `pr/{number}-{headRef}` and numeric suffixes if needed.
 */
export const computePrWorktreeBranch = (input: ComputePrWorktreeBranchInput): string => {
  const { number, headRef, author, isCrossRepo, pattern, existingBranches } = input;
  if (!isCrossRepo && !existingBranches.has(headRef)) {
    return headRef;
  }

  const candidate = expandBranchPattern(pattern, { number, headRef, author });
  if (!existingBranches.has(candidate)) {
    return candidate;
  }

  const disambiguated = `pr/${number}-${sanitizeBranchToken(headRef) || 'head'}`;
  if (!existingBranches.has(disambiguated)) {
    return disambiguated;
  }

  let suffix = 2;
  while (existingBranches.has(`${disambiguated}-${suffix}`)) {
    suffix += 1;
  }
  return `${disambiguated}-${suffix}`;
};
