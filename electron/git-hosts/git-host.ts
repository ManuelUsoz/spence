import { Context, Effect, Layer } from 'effect';
import {
  GitHostError,
  type AddCommentTarget,
  type CommentId,
  type GitHostKind,
  type HostCapabilities,
  type PullRequestCommentKind,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestNumber,
  type PullRequestSummary,
  type PullRequestUpdatePatch,
  type RemoteRepoRef,
  type ReviewId,
  type ReviewSubmitEvent,
  type ReviewThreadId,
  type WorktreePullRequestLink,
} from '../../src/shared/pull-requests/pull-requests.rpc';

const GITHUB_DOT_COM_SSH_ALIAS = /^github\.com-[a-z0-9_-]+$/i;
const FETCH_REMOTE_RE = /^(\S+)\s+(\S+)\s+\(fetch\)(?:\s+\[[^\]]+\])?$/;

const stripGitSuffix = (pathname: string): string => pathname.replace(/\.git\/*$/i, '');

const isGitHubHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  return lower === 'github.com' || GITHUB_DOT_COM_SSH_ALIAS.test(lower);
};

/** Parses an HTTPS or SSH Git remote URL into a normalized `RemoteRepoRef`, or `null` if unsupported. */
export const parseRemoteUrl = (url: string): RemoteRepoRef | null => {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  if (/^(?:https?|ssh):\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!isGitHubHost(parsed.hostname)) return null;
      const parts = stripGitSuffix(parsed.pathname).split('/').filter(Boolean);
      if (parts.length !== 2) return null;
      const [owner, repo] = parts;
      if (!owner || !repo) return null;
      return {
        host: 'github',
        canonicalPath: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
      };
    } catch {
      return null;
    }
  }

  // SCP-style SSH URL: git@github.com:owner/repo.git
  const scpMatch = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpMatch !== null) {
    const host = scpMatch[1] ?? '';
    const rawPath = scpMatch[2] ?? '';
    if (!isGitHubHost(host)) return null;
    const parts = stripGitSuffix(rawPath).split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    const [owner, repo] = parts;
    if (!owner || !repo) return null;
    return {
      host: 'github',
      canonicalPath: `${owner.toLowerCase()}/${repo.toLowerCase()}`,
    };
  }

  return null;
};

export interface ParsedFetchRemote {
  readonly name: string;
  readonly url: string;
  readonly repo: RemoteRepoRef;
}

/** Parses `git remote -v` output into supported fetch remotes. */
export const parseFetchRemotes = (remotesOutput: string): ReadonlyArray<ParsedFetchRemote> => {
  const result: ParsedFetchRemote[] = [];
  for (const rawLine of remotesOutput.split('\n')) {
    const match = FETCH_REMOTE_RE.exec(rawLine.trim());
    if (match === null) continue;
    const name = match[1];
    const url = match[2];
    if (!name || !url) continue;
    const repo = parseRemoteUrl(url);
    if (repo === null) continue;
    result.push({ name, url, repo });
  }
  return result;
};

export interface ResolvedProjectRemote {
  readonly repo: RemoteRepoRef;
  readonly targetRemoteName: string;
  readonly headRemoteName: string;
  readonly headRepo: RemoteRepoRef;
  readonly isFork: boolean;
}

/**
 * Resolves the target and head remotes from `git remote -v` output using Spence's fork rule:
 * - If `targetRemoteOverride` is set and matches a supported remote, use it as target (and `origin` as head if same host).
 * - Else if both `upstream` and `origin` parse to different repos on the same host, use `upstream` as target and `origin` as head.
 * - Else prefer `origin`, else first supported remote.
 */
export const resolveProjectRemote = (
  remotesOutput: string,
  targetRemoteOverride?: string,
): ResolvedProjectRemote | null => {
  const remotes = parseFetchRemotes(remotesOutput);
  if (remotes.length === 0) return null;

  const byName = new Map(remotes.map((r) => [r.name, r] as const));
  const origin = byName.get('origin');
  const upstream = byName.get('upstream');

  if (targetRemoteOverride !== undefined && targetRemoteOverride.trim().length > 0) {
    const overridden = byName.get(targetRemoteOverride.trim());
    if (overridden !== undefined) {
      const head =
        origin !== undefined && origin.repo.host === overridden.repo.host ? origin : overridden;
      return {
        repo: overridden.repo,
        targetRemoteName: overridden.name,
        headRemoteName: head.name,
        headRepo: head.repo,
        isFork: head.repo.canonicalPath !== overridden.repo.canonicalPath,
      };
    }
  }

  if (
    upstream !== undefined &&
    origin !== undefined &&
    upstream.repo.host === origin.repo.host &&
    upstream.repo.canonicalPath !== origin.repo.canonicalPath
  ) {
    return {
      repo: upstream.repo,
      targetRemoteName: upstream.name,
      headRemoteName: origin.name,
      headRepo: origin.repo,
      isFork: true,
    };
  }

  const fallback = origin ?? remotes[0];
  if (fallback === undefined) return null;
  return {
    repo: fallback.repo,
    targetRemoteName: fallback.name,
    headRemoteName: fallback.name,
    headRepo: fallback.repo,
    isFork: false,
  };
};

/**
 * Matches a local Worktree to Pull requests strictly by head branch (plus `headRepo` in forks).
 * Prefers open/draft PRs (most recently updated primary) and exposes sibling refs.
 * Falls back to merged/closed PR only while `worktreeHeadSha === pr.headSha`.
 */
export const matchWorktreeToPullRequest = (input: {
  readonly worktreeBranch: string | null;
  readonly worktreeHeadSha: string | null;
  readonly isDetached: boolean;
  readonly headRepo: RemoteRepoRef;
  readonly isFork: boolean;
  readonly summaries: ReadonlyArray<PullRequestSummary>;
}): WorktreePullRequestLink | null => {
  if (input.isDetached || input.worktreeBranch === null || input.worktreeBranch.length === 0) {
    return null;
  }

  const branchMatches = input.summaries.filter((pr) => {
    if (pr.headRef !== input.worktreeBranch) return false;
    if (input.isFork) {
      if (pr.headRepo === null) return false;
      return pr.headRepo.canonicalPath === input.headRepo.canonicalPath;
    }
    return true;
  });

  if (branchMatches.length === 0) return null;

  const openPrs = branchMatches
    .filter((pr) => pr.state === 'open' || pr.state === 'draft')
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const primary = openPrs[0];
  if (primary !== undefined) {
    return {
      primary,
      openCount: openPrs.length,
      siblingRefs: openPrs.slice(1).map((pr) => pr.ref),
    };
  }

  if (input.worktreeHeadSha === null) return null;

  const matchingClosed = branchMatches
    .filter((pr) => pr.headSha === input.worktreeHeadSha)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const primaryClosed = matchingClosed[0];
  if (primaryClosed === undefined) return null;

  return {
    primary: primaryClosed,
    openCount: 0,
    siblingRefs: [],
  };
};

export type ListPullRequestsResult =
  | { readonly notModified: true }
  | { readonly notModified: false; readonly summaries: ReadonlyArray<PullRequestSummary> };

export type GetPullRequestDetailResult =
  | { readonly notModified: true }
  | { readonly notModified: false; readonly detail: PullRequestDetail };

export interface GitHost {
  readonly kind: GitHostKind;
  readonly capabilities: HostCapabilities;
  readonly parseRemoteUrl: (url: string) => RemoteRepoRef | null;
  readonly listForRepo: (input: {
    readonly repo: RemoteRepoRef;
    readonly bypassEtag?: boolean;
  }) => Effect.Effect<ListPullRequestsResult, GitHostError>;
  readonly getSummaryByNumber: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
  }) => Effect.Effect<PullRequestSummary, GitHostError>;
  readonly getDetail: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly bypassEtag?: boolean;
    readonly checkPending?: boolean;
  }) => Effect.Effect<GetPullRequestDetailResult, GitHostError>;
  readonly getDiff: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly headSha: string;
    readonly baseSha: string;
  }) => Effect.Effect<PullRequestDiff, GitHostError>;
  readonly create: (input: {
    readonly repo: RemoteRepoRef;
    readonly title: string;
    readonly body: string;
    readonly head: string;
    readonly base: string;
    readonly draft: boolean;
  }) => Effect.Effect<PullRequestSummary, GitHostError>;
  readonly update: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly patch: PullRequestUpdatePatch;
    readonly currentDetail: PullRequestDetail;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly addComment: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly body: string;
    readonly target: AddCommentTarget;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly editComment: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
    readonly body: string;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly deleteComment: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly commentId: CommentId;
    readonly kind: PullRequestCommentKind;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly submitReview: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly reviewId?: ReviewId;
    readonly event: ReviewSubmitEvent;
    readonly body: string;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly deletePendingReview: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly reviewId: ReviewId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly resolveThread: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly threadId: ReviewThreadId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly unresolveThread: (input: {
    readonly repo: RemoteRepoRef;
    readonly number: PullRequestNumber;
    readonly threadId: ReviewThreadId;
  }) => Effect.Effect<PullRequestDetail, GitHostError>;
  readonly clearEtags: (repo?: RemoteRepoRef) => Effect.Effect<void>;
}

export interface GitHostRegistryShape {
  readonly get: (kind: GitHostKind) => Effect.Effect<GitHost, GitHostError>;
  readonly parseRemoteUrl: (url: string) => RemoteRepoRef | null;
}

/** Registry dispatching `GitHost` adapters by `GitHostKind`. */
export class GitHostRegistry extends Context.Service<GitHostRegistry, GitHostRegistryShape>()(
  'git-hosts/GitHostRegistry',
) {}

export const makeGitHostRegistry = (hosts: ReadonlyArray<GitHost>): GitHostRegistryShape => {
  const byKind = new Map(hosts.map((host) => [host.kind, host] as const));
  return {
    get: (kind) => {
      const found = byKind.get(kind);
      return found !== undefined
        ? Effect.succeed(found)
        : Effect.fail(
            new GitHostError({
              reason: 'UnsupportedCapability',
              detail: `Git host '${kind}' is not registered.`,
            }),
          );
    },
    parseRemoteUrl: (url) => {
      for (const host of hosts) {
        const parsed = host.parseRemoteUrl(url);
        if (parsed !== null) return parsed;
      }
      return null;
    },
  };
};

export const layerGitHostRegistry = (hosts: ReadonlyArray<GitHost>) =>
  Layer.succeed(GitHostRegistry, makeGitHostRegistry(hosts));
