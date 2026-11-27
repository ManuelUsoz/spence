import { Effect } from 'effect';
import {
  CommentId,
  GitHostError,
  PullRequestNumber,
  ReviewId,
  type CheckRollupStatus,
  type CheckRun,
  type HostActor,
  type HostCapabilities,
  type MergeMethod,
  type MergeStateStatus,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestDiffFile,
  type PullRequestLabel,
  type PullRequestMilestone,
  type PullRequestState,
  type PullRequestSummary,
  type RemoteRepoRef,
  type Review,
  type ReviewDecision,
  type ReviewState,
  type ReviewThread,
  type ViewerRole,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { parseRemoteUrl, type GitHost } from './git-host';
import { GitHubHttp } from './github-http';
import { HostAuth } from './host-auth';
import {
  runPrWorkerTask,
  type RawActorNode,
  type RawReviewThreadNode,
  type RawStatusCheckNode,
} from './pr-worker';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;

export const GITHUB_CAPABILITIES: HostCapabilities = {
  supportsDraft: true,
  supportsThreadResolution: true,
  supportsAutoMerge: true,
  supportsPendingReviews: true,
  supportsMilestones: true,
  supportedMergeMethods: ['merge', 'squash', 'rebase'],
};

const LIST_PULL_REQUESTS_QUERY = `
query PullRequestList($owner: String!, $name: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        state
        isDraft
        headRefName
        headRefOid
        baseRefName
        updatedAt
        isCrossRepository
        headRepository {
          nameWithOwner
        }
        reviewDecision
        author {
          login
          avatarUrl
          ... on User {
            name
          }
        }
        comments {
          totalCount
        }
        reviewThreads(first: 100) {
          totalCount
          nodes {
            isResolved
          }
        }
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User {
                login
              }
            }
          }
        }
        assignees(first: 20) {
          nodes {
            login
          }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    }
  }
}
`;

const SUMMARY_BY_NUMBER_QUERY = `
query PullRequestSummaryByNumber($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      title
      url
      state
      isDraft
      headRefName
      headRefOid
      baseRefName
      updatedAt
      isCrossRepository
      headRepository {
        nameWithOwner
      }
      reviewDecision
      author {
        login
        avatarUrl
        ... on User {
          name
        }
      }
      comments {
        totalCount
      }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          isResolved
        }
      }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User {
              login
            }
          }
        }
      }
      assignees(first: 20) {
        nodes {
          login
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
            }
          }
        }
      }
    }
  }
}
`;

const PULL_REQUEST_DETAIL_QUERY = `
query PullRequestDetail($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    viewerPermission
    labels(first: 50) {
      nodes {
        name
        color
        description
      }
    }
    milestones(first: 30, states: [OPEN]) {
      nodes {
        id
        title
        dueOn
      }
    }
    assignableUsers(first: 50) {
      nodes {
        login
        avatarUrl
        name
      }
    }
    pullRequest(number: $number) {
      number
      title
      url
      body
      state
      isDraft
      headRefName
      headRefOid
      baseRefName
      updatedAt
      isCrossRepository
      headRepository {
        nameWithOwner
      }
      mergeStateStatus
      autoMergeRequest {
        mergeMethod
      }
      reviewDecision
      viewerCanUpdate
      viewerDidAuthor
      author {
        login
        avatarUrl
        ... on User {
          name
        }
      }
      labels(first: 20) {
        nodes {
          name
          color
          description
        }
      }
      reviewRequests(first: 20) {
        nodes {
          requestedReviewer {
            ... on User {
              login
              ... on User {
                name
                avatarUrl
              }
            }
          }
        }
      }
      assignees(first: 20) {
        nodes {
          login
          name
          avatarUrl
        }
      }
      milestone {
        id
        title
        dueOn
      }
      comments(first: 50) {
        totalCount
        nodes {
          id
          body
          createdAt
          updatedAt
          url
          author {
            login
            avatarUrl
            ... on User {
              name
            }
          }
        }
      }
      reviews(first: 50) {
        nodes {
          id
          state
          body
          submittedAt
          author {
            login
            avatarUrl
            ... on User {
              name
            }
          }
        }
      }
      reviewThreads(first: 100) {
        totalCount
        nodes {
          id
          path
          line
          startLine
          diffSide
          isResolved
          isOutdated
          comments(first: 10) {
            nodes {
              id
              body
              createdAt
              updatedAt
              url
              author {
                login
                avatarUrl
                ... on User {
                  name
                }
              }
            }
          }
        }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    id
                    name
                    status
                    conclusion
                    detailsUrl
                    isRequired(pullRequestNumber: $number)
                  }
                  ... on StatusContext {
                    id
                    context
                    state
                    targetUrl
                    description
                    isRequired(pullRequestNumber: $number)
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const PULL_REQUEST_NODE_ID_QUERY = `
query PullRequestNodeId($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      headRefOid
    }
  }
}
`;

const MERGE_PULL_REQUEST_MUTATION = `
mutation MergePullRequest($input: MergePullRequestInput!) {
  mergePullRequest(input: $input) {
    pullRequest {
      number
    }
  }
}
`;

const ENABLE_AUTO_MERGE_MUTATION = `
mutation EnablePullRequestAutoMerge($input: EnablePullRequestAutoMergeInput!) {
  enablePullRequestAutoMerge(input: $input) {
    pullRequest {
      number
    }
  }
}
`;

const DISABLE_AUTO_MERGE_MUTATION = `
mutation DisablePullRequestAutoMerge($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
    pullRequest {
      number
    }
  }
}
`;

interface GraphQlResponse<A> {
  readonly data?: A;
  readonly errors?: ReadonlyArray<{ readonly message?: string; readonly type?: string }>;
}

interface RawSummaryNode {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly updatedAt: string;
  readonly isCrossRepository: boolean;
  readonly headRepository?: { readonly nameWithOwner?: string | null } | null;
  readonly reviewDecision?: string | null;
  readonly author?: RawActorNode | null;
  readonly comments?: { readonly totalCount?: number } | null;
  readonly reviewThreads?: {
    readonly totalCount?: number;
    readonly nodes?: ReadonlyArray<{ readonly isResolved?: boolean | null } | null> | null;
  } | null;
  readonly reviewRequests?: {
    readonly nodes?: ReadonlyArray<{
      readonly requestedReviewer?: (RawActorNode & { readonly login?: string | null }) | null;
    } | null> | null;
  } | null;
  readonly assignees?: {
    readonly nodes?: ReadonlyArray<RawActorNode | null> | null;
  } | null;
  readonly commits?: {
    readonly nodes?: ReadonlyArray<{
      readonly commit?: {
        readonly statusCheckRollup?: {
          readonly state?: string | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
}

const toTimestamp = (iso: string | null | undefined): number => {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toHostActor = (actor: RawActorNode | null | undefined): HostActor => ({
  login: actor?.login ?? 'ghost',
  displayName: actor?.name ?? null,
  avatarUrl: actor?.avatarUrl ?? null,
});

const mapPrState = (state: string, isDraft: boolean): PullRequestState => {
  switch (state.toUpperCase()) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    default:
      return isDraft ? 'draft' : 'open';
  }
};

const mapReviewDecision = (raw: string | null | undefined): ReviewDecision => {
  switch ((raw ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changesRequested';
    case 'REVIEW_REQUIRED':
      return 'reviewRequired';
    default:
      return 'none';
  }
};

const mapRollupState = (raw: string | null | undefined): CheckRollupStatus => {
  switch ((raw ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
};

const mapMergeState = (raw: string | null | undefined, isDraft: boolean): MergeStateStatus => {
  if (isDraft) return 'draft';
  switch ((raw ?? '').toUpperCase()) {
    case 'CLEAN':
      return 'clean';
    case 'BLOCKED':
      return 'blocked';
    case 'BEHIND':
      return 'behind';
    case 'DIRTY':
      return 'dirty';
    case 'UNSTABLE':
      return 'unstable';
    default:
      return 'unknown';
  }
};

const mergeStateReasonFor = (state: MergeStateStatus): string | undefined => {
  switch (state) {
    case 'clean':
      return undefined;
    case 'draft':
      return 'Pull request is still a draft.';
    case 'dirty':
      return 'Merge conflicts must be resolved before merging.';
    case 'behind':
      return 'Head branch is behind the base branch.';
    case 'blocked':
      return 'Merging is blocked by branch protection rules (required checks or reviews).';
    case 'unstable':
      return 'Status checks are failing or unstable.';
    case 'unknown':
      return 'Mergeability status is currently unknown.';
  }
};

const mapReviewState = (raw: string | null | undefined): ReviewState => {
  switch ((raw ?? '').toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changesRequested';
    case 'DISMISSED':
      return 'dismissed';
    default:
      return 'commented';
  }
};

const toHeadRepo = (raw: string | null | undefined): RemoteRepoRef | null => {
  if (!raw) return null;
  return { host: 'github', canonicalPath: raw.toLowerCase() };
};

const toViewerRoles = (
  node: RawSummaryNode,
  viewerLogin: string | null,
): ReadonlyArray<ViewerRole> => {
  if (!viewerLogin) return [];
  const lower = viewerLogin.toLowerCase();
  const roles: ViewerRole[] = [];
  if (node.author?.login?.toLowerCase() === lower) roles.push('author');
  if (
    node.reviewRequests?.nodes?.some((r) => r?.requestedReviewer?.login?.toLowerCase() === lower)
  ) {
    roles.push('reviewer');
  }
  if (node.assignees?.nodes?.some((a) => a?.login?.toLowerCase() === lower)) {
    roles.push('assignee');
  }
  return roles;
};

const toSummary = (
  repo: RemoteRepoRef,
  node: RawSummaryNode,
  viewerLogin: string | null,
): PullRequestSummary => {
  const threadNodes = node.reviewThreads?.nodes;
  const unresolvedThreadCount = Array.isArray(threadNodes)
    ? threadNodes.filter((t) => t !== null && t.isResolved === false).length
    : (node.reviewThreads?.totalCount ?? null);
  const rollupState = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;

  return {
    ref: { repo, number: PullRequestNumber.make(node.number) },
    title: node.title,
    state: mapPrState(node.state, node.isDraft),
    author: toHostActor(node.author),
    headRef: node.headRefName,
    headSha: node.headRefOid,
    headRepo: toHeadRepo(node.headRepository?.nameWithOwner),
    baseRef: node.baseRefName,
    updatedAt: toTimestamp(node.updatedAt),
    url: node.url,
    checkRollup: mapRollupState(rollupState),
    reviewDecision: mapReviewDecision(node.reviewDecision),
    commentCount: node.comments?.totalCount ?? 0,
    unresolvedThreadCount,
    viewerRoles: toViewerRoles(node, viewerLogin),
    isCrossRepo: node.isCrossRepository,
  };
};

const splitRepo = (repo: RemoteRepoRef): { readonly owner: string; readonly name: string } => {
  const [owner = '', name = ''] = repo.canonicalPath.split('/');
  return { owner, name };
};

export const makeGitHubAdapter = Effect.gen(function* () {
  const http = yield* GitHubHttp;
  const auth = yield* HostAuth;

  const listEtags = new Map<string, string>();
  const detailEtags = new Map<
    string,
    { readonly prEtag?: string; readonly checksEtag?: string; readonly headSha?: string }
  >();

  const getViewerLogin = () =>
    auth.getAccounts.pipe(
      Effect.map((state) => state.accounts.find((a) => a.host === 'github')?.handle ?? null),
    );

  const mapGraphQlError = (
    errors: ReadonlyArray<{ readonly message?: string; readonly type?: string }>,
  ): GitHostError => {
    const first = errors[0];
    const msg = first?.message ?? 'GitHub GraphQL query failed.';
    if (first?.type === 'NOT_FOUND') {
      return new GitHostError({ reason: 'NotFound', detail: msg });
    }
    if (first?.type === 'FORBIDDEN') {
      return new GitHostError({ reason: 'Forbidden', detail: msg });
    }
    if (
      /head.*sha|expectedHeadOid|does not match|already.*merged|base.*modified|not.*mergeable|conflict/i.test(
        msg,
      )
    ) {
      return new GitHostError({ reason: 'Conflict', detail: msg });
    }
    if (first?.type === 'UNPROCESSABLE') {
      return new GitHostError({ reason: 'ValidationFailed', detail: msg });
    }
    return new GitHostError({ reason: 'HostError', detail: msg });
  };

  const runGraphQl = <A>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Effect.Effect<A, GitHostError> =>
    auth.withToken('github', (token) =>
      http
        .postJson<GraphQlResponse<A>>(
          GITHUB_GRAPHQL_URL,
          { query, variables },
          { headers: { authorization: `Bearer ${token}` } },
        )
        .pipe(
          Effect.flatMap((res) => {
            if (res.data.errors && res.data.errors.length > 0) {
              return Effect.fail(mapGraphQlError(res.data.errors));
            }
            if (!res.data.data) {
              return Effect.fail(
                new GitHostError({
                  reason: 'HostError',
                  detail: 'GitHub GraphQL response contained no data.',
                }),
              );
            }
            return Effect.succeed(res.data.data);
          }),
        ),
    );

  const listForRepo: GitHost['listForRepo'] = Effect.fn('GitHubAdapter.listForRepo')(function* ({
    repo,
    bypassEtag,
  }) {
    const { owner, name } = splitRepo(repo);
    const repoKey = repo.canonicalPath;

    if (bypassEtag !== true) {
      const prevEtag = listEtags.get(repoKey);
      const restRes = yield* auth.withToken('github', (token) =>
        http.getJson<unknown>(
          `${GITHUB_API_BASE}/repos/${owner}/${name}/pulls?state=all&sort=updated&direction=desc&per_page=30`,
          {
            allowNotModified: true,
            headers: {
              authorization: `Bearer ${token}`,
              ...(prevEtag !== undefined ? { 'if-none-match': prevEtag } : {}),
            },
          },
        ),
      );
      if (restRes.status === 304) {
        return { notModified: true } as const;
      }
      const nextEtag = restRes.headers['etag'];
      if (nextEtag !== undefined) {
        listEtags.set(repoKey, nextEtag);
      }
    }

    const viewerLogin = yield* getViewerLogin();
    const data = yield* runGraphQl<{
      readonly repository?: {
        readonly pullRequests?: {
          readonly nodes?: ReadonlyArray<RawSummaryNode | null> | null;
        } | null;
      } | null;
    }>(LIST_PULL_REQUESTS_QUERY, { owner, name, first: 30 });

    const nodes = data.repository?.pullRequests?.nodes ?? [];
    const summaries = nodes
      .filter((n): n is RawSummaryNode => n !== null)
      .map((n) => toSummary(repo, n, viewerLogin));

    return { notModified: false, summaries } as const;
  });

  const getSummaryByNumber: GitHost['getSummaryByNumber'] = Effect.fn(
    'GitHubAdapter.getSummaryByNumber',
  )(function* ({ repo, number }) {
    const { owner, name } = splitRepo(repo);
    const viewerLogin = yield* getViewerLogin();
    const data = yield* runGraphQl<{
      readonly repository?: { readonly pullRequest?: RawSummaryNode | null } | null;
    }>(SUMMARY_BY_NUMBER_QUERY, { owner, name, number: Number(number) });

    const pr = data.repository?.pullRequest;
    if (!pr) {
      return yield* new GitHostError({
        reason: 'NotFound',
        detail: `Pull request #${number} was not found in ${repo.canonicalPath}.`,
      });
    }
    return toSummary(repo, pr, viewerLogin);
  });

  const getDetail: GitHost['getDetail'] = Effect.fn('GitHubAdapter.getDetail')(function* ({
    repo,
    number,
    bypassEtag,
    checkPending,
  }) {
    const { owner, name } = splitRepo(repo);
    const key = `${repo.canonicalPath}#${number}`;

    if (bypassEtag !== true) {
      const prev = detailEtags.get(key);
      const prRest = yield* auth.withToken('github', (token) =>
        http.getJson<{ readonly head?: { readonly sha?: string } }>(
          `${GITHUB_API_BASE}/repos/${owner}/${name}/pulls/${number}`,
          {
            allowNotModified: true,
            headers: {
              authorization: `Bearer ${token}`,
              ...(prev?.prEtag !== undefined ? { 'if-none-match': prev.prEtag } : {}),
            },
          },
        ),
      );

      let checksNotModified = true;
      let nextChecksEtag = prev?.checksEtag;
      const headSha = prRest.status === 200 ? prRest.data.head?.sha : prev?.headSha;

      if (checkPending === true && headSha !== undefined) {
        const checksRest = yield* auth.withToken('github', (token) =>
          http.getJson<unknown>(
            `${GITHUB_API_BASE}/repos/${owner}/${name}/commits/${headSha}/check-runs?filter=all`,
            {
              allowNotModified: true,
              headers: {
                authorization: `Bearer ${token}`,
                ...(prev?.checksEtag !== undefined && prev.headSha === headSha
                  ? { 'if-none-match': prev.checksEtag }
                  : {}),
              },
            },
          ),
        );
        checksNotModified = checksRest.status === 304;
        if (checksRest.headers['etag'] !== undefined) {
          nextChecksEtag = checksRest.headers['etag'];
        }
      }

      if (prRest.status === 304 && checksNotModified) {
        return { notModified: true } as const;
      }

      detailEtags.set(key, {
        ...(prRest.headers['etag'] !== undefined
          ? { prEtag: prRest.headers['etag'] }
          : prev?.prEtag !== undefined
            ? { prEtag: prev.prEtag }
            : {}),
        ...(nextChecksEtag !== undefined ? { checksEtag: nextChecksEtag } : {}),
        ...(headSha !== undefined ? { headSha } : {}),
      });
    }

    const viewerLogin = yield* getViewerLogin();
    const data = yield* runGraphQl<{
      readonly repository?: {
        readonly mergeCommitAllowed?: boolean;
        readonly squashMergeAllowed?: boolean;
        readonly rebaseMergeAllowed?: boolean;
        readonly viewerPermission?: string | null;
        readonly labels?: {
          readonly nodes?: ReadonlyArray<{
            readonly name: string;
            readonly color: string;
            readonly description?: string | null;
          } | null> | null;
        } | null;
        readonly milestones?: {
          readonly nodes?: ReadonlyArray<{
            readonly id: string;
            readonly title: string;
            readonly dueOn?: string | null;
          } | null> | null;
        } | null;
        readonly assignableUsers?: {
          readonly nodes?: ReadonlyArray<RawActorNode | null> | null;
        } | null;
        readonly pullRequest?:
          | (RawSummaryNode & {
              readonly body?: string | null;
              readonly mergeStateStatus?: string | null;
              readonly autoMergeRequest?: { readonly mergeMethod?: string | null } | null;
              readonly viewerCanUpdate?: boolean;
              readonly viewerDidAuthor?: boolean;
              readonly labels?: {
                readonly nodes?: ReadonlyArray<{
                  readonly name: string;
                  readonly color: string;
                  readonly description?: string | null;
                } | null> | null;
              } | null;
              readonly milestone?: {
                readonly id: string;
                readonly title: string;
                readonly dueOn?: string | null;
              } | null;
              readonly comments?: {
                readonly totalCount?: number;
                readonly nodes?: ReadonlyArray<{
                  readonly id: string;
                  readonly body?: string | null;
                  readonly createdAt?: string | null;
                  readonly updatedAt?: string | null;
                  readonly url?: string | null;
                  readonly author?: RawActorNode | null;
                } | null> | null;
              } | null;
              readonly reviews?: {
                readonly nodes?: ReadonlyArray<{
                  readonly id: string;
                  readonly state?: string | null;
                  readonly body?: string | null;
                  readonly submittedAt?: string | null;
                  readonly author?: RawActorNode | null;
                } | null> | null;
              } | null;
              readonly reviewThreads?: {
                readonly totalCount?: number;
                readonly nodes?: ReadonlyArray<RawReviewThreadNode | null> | null;
              } | null;
              readonly commits?: {
                readonly nodes?: ReadonlyArray<{
                  readonly commit?: {
                    readonly statusCheckRollup?: {
                      readonly contexts?: {
                        readonly nodes?: ReadonlyArray<RawStatusCheckNode | null> | null;
                      } | null;
                    } | null;
                  } | null;
                } | null> | null;
              } | null;
            })
          | null;
      } | null;
    }>(PULL_REQUEST_DETAIL_QUERY, { owner, name, number: Number(number) });

    const repository = data.repository;
    const pr = repository?.pullRequest;
    if (!repository || !pr) {
      return yield* new GitHostError({
        reason: 'NotFound',
        detail: `Pull request #${number} was not found in ${repo.canonicalPath}.`,
      });
    }

    const summary = toSummary(repo, pr, viewerLogin);
    const rawCheckNodes = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
    const rawThreadNodes = pr.reviewThreads?.nodes ?? [];

    const [{ checkRollup, checks }, reviewThreads] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          runPrWorkerTask<{
            readonly checkRollup: CheckRollupStatus;
            readonly checks: ReadonlyArray<CheckRun>;
          }>({
            kind: 'normalizeChecks',
            nodes: rawCheckNodes,
          }),
          runPrWorkerTask<ReadonlyArray<ReviewThread>>({
            kind: 'normalizeReviewThreads',
            nodes: rawThreadNodes,
          }),
        ]),
      catch: (err) =>
        new GitHostError({
          reason: 'HostError',
          detail: err instanceof Error ? err.message : 'PR worker failed to normalize detail.',
        }),
    });

    const allowedMergeMethods: MergeMethod[] = [];
    if (repository.mergeCommitAllowed) allowedMergeMethods.push('merge');
    if (repository.squashMergeAllowed) allowedMergeMethods.push('squash');
    if (repository.rebaseMergeAllowed) allowedMergeMethods.push('rebase');

    const permission = repository.viewerPermission?.toUpperCase() ?? 'READ';
    const hasWrite = permission === 'ADMIN' || permission === 'MAINTAIN' || permission === 'WRITE';
    const mergeState = mapMergeState(pr.mergeStateStatus, pr.isDraft);

    const toLabel = (l: {
      readonly name: string;
      readonly color: string;
      readonly description?: string | null;
    }): PullRequestLabel => ({
      name: l.name,
      color: l.color,
      description: l.description ?? null,
    });

    const toMilestone = (m: {
      readonly id: string;
      readonly title: string;
      readonly dueOn?: string | null;
    }): PullRequestMilestone => ({
      id: m.id,
      title: m.title,
      dueOn: m.dueOn ? toTimestamp(m.dueOn) : null,
    });

    const comments: ReadonlyArray<PullRequestComment> = (pr.comments?.nodes ?? [])
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({
        id: CommentId.make(c.id),
        author: toHostActor(c.author),
        body: c.body ?? '',
        createdAt: toTimestamp(c.createdAt),
        updatedAt: toTimestamp(c.updatedAt),
        url: c.url ?? '',
      }));

    const reviews: ReadonlyArray<Review> = (pr.reviews?.nodes ?? [])
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map((r) => ({
        id: ReviewId.make(r.id),
        author: toHostActor(r.author),
        state: mapReviewState(r.state),
        body: r.body ?? '',
        submittedAt: r.submittedAt ? toTimestamp(r.submittedAt) : null,
      }));

    const mergeStateReason = mergeStateReasonFor(mergeState);
    const detail: PullRequestDetail = {
      ...summary,
      checkRollup,
      unresolvedThreadCount: reviewThreads.filter((t) => !t.isResolved).length,
      body: pr.body ?? '',
      mergeState,
      ...(mergeStateReason !== undefined ? { mergeStateReason } : {}),
      autoMergeEnabled: pr.autoMergeRequest !== null && pr.autoMergeRequest !== undefined,
      labels: (pr.labels?.nodes ?? [])
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .map(toLabel),
      reviewers: (pr.reviewRequests?.nodes ?? [])
        .map((r) => r?.requestedReviewer)
        .filter((r): r is NonNullable<typeof r> => r !== null && r !== undefined)
        .map(toHostActor),
      assignees: (pr.assignees?.nodes ?? [])
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map(toHostActor),
      milestone: pr.milestone ? toMilestone(pr.milestone) : null,
      repoLabels: (repository.labels?.nodes ?? [])
        .filter((l): l is NonNullable<typeof l> => l !== null)
        .map(toLabel),
      repoMilestones: (repository.milestones?.nodes ?? [])
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .map(toMilestone),
      collaborators: (repository.assignableUsers?.nodes ?? [])
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map(toHostActor),
      checks,
      reviews,
      reviewThreads,
      comments,
      actions: {
        canUpdate: Boolean(pr.viewerCanUpdate),
        canMerge: hasWrite && allowedMergeMethods.length > 0 && summary.state === 'open',
        canReview: viewerLogin !== null,
        canApproveOrRequestChanges: viewerLogin !== null && !pr.viewerDidAuthor,
        canResolveThreads: hasWrite || Boolean(pr.viewerDidAuthor),
        allowedMergeMethods,
      },
      revision: {
        headSha: summary.headSha,
        updatedAt: summary.updatedAt,
      },
    };

    return { notModified: false, detail } as const;
  });

  const getDiff: GitHost['getDiff'] = Effect.fn('GitHubAdapter.getDiff')(function* ({
    repo,
    number,
    headSha,
    baseSha,
  }) {
    const { owner, name } = splitRepo(repo);
    const res = yield* auth.withToken('github', (token) =>
      http.getText(`${GITHUB_API_BASE}/repos/${owner}/${name}/pulls/${number}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    const files = yield* Effect.tryPromise({
      try: () =>
        runPrWorkerTask<ReadonlyArray<PullRequestDiffFile>>({
          kind: 'parseDiff',
          rawDiff: res.data,
        }),
      catch: (err) =>
        new GitHostError({
          reason: 'HostError',
          detail: err instanceof Error ? err.message : 'PR worker failed to parse diff.',
        }),
    });

    return {
      ref: { repo, number },
      headSha,
      baseSha,
      files,
    };
  });

  const clearEtags: GitHost['clearEtags'] = (repo) =>
    Effect.sync(() => {
      if (repo === undefined) {
        listEtags.clear();
        detailEtags.clear();
        return;
      }
      listEtags.delete(repo.canonicalPath);
      const prefix = `${repo.canonicalPath}#`;
      for (const k of detailEtags.keys()) {
        if (k.startsWith(prefix)) detailEtags.delete(k);
      }
    });

  const getPullRequestNodeId = Effect.fn('GitHubAdapter.getPullRequestNodeId')(function* (
    repo: RemoteRepoRef,
    number: PullRequestNumber,
  ) {
    const { owner, name } = splitRepo(repo);
    const data = yield* runGraphQl<{
      readonly repository?: {
        readonly pullRequest?: { readonly id: string; readonly headRefOid: string } | null;
      } | null;
    }>(PULL_REQUEST_NODE_ID_QUERY, { owner, name, number: Number(number) });
    const pr = data.repository?.pullRequest;
    if (!pr) {
      return yield* new GitHostError({
        reason: 'NotFound',
        detail: `Pull request #${number} was not found in ${repo.canonicalPath}.`,
      });
    }
    return pr;
  });

  const toGitHubMergeMethod = (method: MergeMethod): 'MERGE' | 'SQUASH' | 'REBASE' => {
    switch (method) {
      case 'merge':
        return 'MERGE';
      case 'squash':
        return 'SQUASH';
      case 'rebase':
        return 'REBASE';
    }
  };

  const merge: GitHost['merge'] = Effect.fn('GitHubAdapter.merge')(function* ({
    repo,
    number,
    expectedHeadSha,
    method,
    commitTitle,
    commitMessage,
  }) {
    const pr = yield* getPullRequestNodeId(repo, number);
    yield* runGraphQl<unknown>(MERGE_PULL_REQUEST_MUTATION, {
      input: {
        pullRequestId: pr.id,
        expectedHeadOid: expectedHeadSha,
        mergeMethod: toGitHubMergeMethod(method),
        ...(commitTitle !== undefined && commitTitle.trim().length > 0
          ? { commitHeadline: commitTitle }
          : {}),
        ...(commitMessage !== undefined && commitMessage.trim().length > 0
          ? { commitBody: commitMessage }
          : {}),
      },
    });
    yield* clearEtags(repo);
    const refreshed = yield* getDetail({ repo, number, bypassEtag: true });
    if (refreshed.notModified) {
      return yield* new GitHostError({
        reason: 'HostError',
        detail: 'Expected refreshed Pull request detail after merge.',
      });
    }
    return refreshed.detail;
  });

  const setAutoMerge: GitHost['setAutoMerge'] = Effect.fn('GitHubAdapter.setAutoMerge')(function* ({
    repo,
    number,
    enabled,
    method,
    expectedHeadSha,
  }) {
    const pr = yield* getPullRequestNodeId(repo, number);
    if (enabled) {
      yield* runGraphQl<unknown>(ENABLE_AUTO_MERGE_MUTATION, {
        input: {
          pullRequestId: pr.id,
          mergeMethod: toGitHubMergeMethod(method ?? 'squash'),
          ...(expectedHeadSha !== undefined ? { expectedHeadOid: expectedHeadSha } : {}),
        },
      });
    } else {
      yield* runGraphQl<unknown>(DISABLE_AUTO_MERGE_MUTATION, {
        pullRequestId: pr.id,
      });
    }
    yield* clearEtags(repo);
    const refreshed = yield* getDetail({ repo, number, bypassEtag: true });
    if (refreshed.notModified) {
      return yield* new GitHostError({
        reason: 'HostError',
        detail: 'Expected refreshed Pull request detail after auto-merge change.',
      });
    }
    return refreshed.detail;
  });

  const host: GitHost = {
    kind: 'github',
    capabilities: GITHUB_CAPABILITIES,
    parseRemoteUrl,
    listForRepo,
    getSummaryByNumber,
    getDetail,
    getDiff,
    merge,
    setAutoMerge,
    clearEtags,
  };

  return host;
});
