import type {
  CheckRollupStatus,
  CheckRun,
  MergeStateStatus,
  PullRequestState,
  ReviewDecision,
  ReviewState,
} from '../../../shared/pull-requests/pull-requests.rpc';

/** Formats a relative age for cached PR timestamps (e.g. "2m ago"). */
export const formatCachedAge = (lastSyncedAt: number | null, now = Date.now()): string => {
  if (lastSyncedAt === null) return $localize`cached`;
  const seconds = Math.max(0, Math.floor((now - lastSyncedAt) / 1000));
  if (seconds < 60) return $localize`just now`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return $localize`${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return $localize`${hours}h ago`;
  const days = Math.floor(hours / 24);
  return $localize`${days}d ago`;
};

/** Formats a rate-limit reset timestamp into local HH:MM. */
export const formatResetTime = (resetAt: number | undefined): string => {
  if (resetAt === undefined) return $localize`soon`;
  return new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

/** Human-readable label for a PR lifecycle state. */
export const prStateLabel = (state: PullRequestState): string => {
  switch (state) {
    case 'open':
      return $localize`Open`;
    case 'draft':
      return $localize`Draft`;
    case 'merged':
      return $localize`Merged`;
    case 'closed':
      return $localize`Closed`;
  }
};

/** Human-readable label for a PR check rollup status. */
export const checkRollupLabel = (rollup: CheckRollupStatus): string => {
  switch (rollup) {
    case 'passing':
      return $localize`Checks passing`;
    case 'failing':
      return $localize`Checks failing`;
    case 'pending':
      return $localize`Checks pending`;
    case 'none':
      return $localize`No checks`;
  }
};

/** Human-readable label for a PR mergeability state. */
export const mergeStateLabel = (status: MergeStateStatus): string => {
  switch (status) {
    case 'clean':
      return $localize`Ready to merge`;
    case 'blocked':
      return $localize`Merge blocked`;
    case 'behind':
      return $localize`Behind base branch`;
    case 'dirty':
      return $localize`Merge conflicts`;
    case 'unstable':
      return $localize`Checks failing`;
    case 'draft':
      return $localize`Draft PR`;
    case 'unknown':
      return $localize`Merge status unknown`;
  }
};

/** Human-readable label for a PR review decision. */
export const reviewDecisionLabel = (decision: ReviewDecision): string => {
  switch (decision) {
    case 'approved':
      return $localize`Approved`;
    case 'changesRequested':
      return $localize`Changes requested`;
    case 'reviewRequired':
      return $localize`Review required`;
    case 'none':
      return $localize`No reviews`;
  }
};

/** Human-readable label for an individual Review state. */
export const reviewStateLabel = (state: ReviewState): string => {
  switch (state) {
    case 'approved':
      return $localize`Approved`;
    case 'changesRequested':
      return $localize`Changes requested`;
    case 'commented':
      return $localize`Commented`;
    case 'pending':
      return $localize`Pending`;
    case 'dismissed':
      return $localize`Dismissed`;
  }
};

/** Returns true when a Check run conclusion is non-blocking (`neutral` or `skipped`). */
export const isNonBlockingCheck = (check: CheckRun): boolean =>
  check.conclusion === 'neutral' || check.conclusion === 'skipped';
