import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import {
  CommentId,
  GitHostError,
  PullRequestNumber,
  ReviewId,
  ReviewThreadId,
  type RemoteRepoRef,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import { layerSecretStorageFake } from '../devices/secret-storage';
import { layerStore } from '../store/store';
import { GitHostRegistry, makeGitHostRegistry } from './git-host';
import { makeGitHubAdapter } from './github-adapter';
import { layerGitHubHttp } from './github-http';
import { GhCli, HostAuth, layerHostAuth } from './host-auth';

const repo: RemoteRepoRef = { host: 'github', canonicalPath: 'org/repo' };

const makeTestLayer = (
  storeRoot: string,
  handler: (req: {
    readonly url: string;
    readonly headers: Record<string, string>;
    readonly method: string;
    readonly bodyText: string;
  }) => {
    readonly status: number;
    readonly headers?: Record<string, string | undefined>;
    readonly body?: unknown;
  },
) => {
  const fakeHttpClient = HttpClient.make((req) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const bodyTextInput =
      req.body._tag === 'Uint8Array' ? new TextDecoder().decode(req.body.body) : '';
    const res = handler({ url: req.url, headers, method: req.method, bodyText: bodyTextInput });
    const responseHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      if (typeof v === 'string') responseHeaders[k] = v;
    }
    const bodyText =
      typeof res.body === 'string'
        ? res.body
        : res.body === undefined
          ? ''
          : JSON.stringify(res.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        req,
        new Response(res.status === 304 ? null : bodyText, {
          status: res.status,
          headers: responseHeaders,
        }),
      ),
    );
  });

  const httpLayer = layerGitHubHttp.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeHttpClient)),
  );
  const authLayer = layerHostAuth.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerStore(storeRoot),
        layerSecretStorageFake({ available: true }),
        httpLayer,
        Layer.succeed(GhCli, {
          check: () => Effect.succeed({ available: false, authenticated: false, handle: null }),
          readToken: () => Effect.die('unused'),
        }),
      ),
    ),
  );
  const registryLayer = Layer.effect(
    GitHostRegistry,
    Effect.gen(function* () {
      const adapter = yield* makeGitHubAdapter;
      return makeGitHostRegistry([adapter]);
    }),
  ).pipe(Layer.provide(Layer.mergeAll(authLayer, httpLayer)));

  return Layer.mergeAll(authLayer, httpLayer, registryLayer);
};

describe('GitHubAdapter', () => {
  it('short-circuits listForRepo on 304 Not Modified without calling GraphQL, and bypasses ETag when requested', async () => {
    const requests: Array<{ url: string; ifNoneMatch?: string }> = [];
    let graphqlCalls = 0;

    const storeRoot = await mkdtemp(path.join(tmpdir(), 'spence-gh-adapter-'));
    try {
      const layer = makeTestLayer(storeRoot, (req) => {
        requests.push({
          url: req.url,
          ...(req.headers['if-none-match'] ? { ifNoneMatch: req.headers['if-none-match'] } : {}),
        });
        if (req.url.endsWith('/user')) {
          return {
            status: 200,
            headers: { 'x-oauth-scopes': 'repo, read:org' },
            body: { login: 'alice', name: 'Alice', avatar_url: null },
          };
        }
        if (req.url.includes('/pulls?state=all')) {
          if (req.headers['if-none-match'] === '"etag-1"') {
            return { status: 304, headers: { etag: '"etag-1"' } };
          }
          return { status: 200, headers: { etag: '"etag-1"' }, body: [] };
        }
        if (req.url.endsWith('/graphql')) {
          graphqlCalls += 1;
          return {
            status: 200,
            body: {
              data: {
                repository: {
                  pullRequests: {
                    nodes: [
                      {
                        number: 42,
                        title: 'Add feature',
                        url: 'https://github.com/org/repo/pull/42',
                        state: 'OPEN',
                        isDraft: false,
                        headRefName: 'feat/add',
                        headRefOid: 'sha-42',
                        baseRefName: 'main',
                        updatedAt: '2026-11-20T12:00:00Z',
                        isCrossRepository: false,
                        headRepository: { nameWithOwner: 'org/repo' },
                        reviewDecision: null,
                        author: { login: 'alice', name: 'Alice', avatarUrl: null },
                        comments: { totalCount: 2 },
                        reviewThreads: { totalCount: 1 },
                        reviewRequests: { nodes: [] },
                        assignees: { nodes: [] },
                        commits: {
                          nodes: [
                            {
                              commit: {
                                statusCheckRollup: { state: 'SUCCESS' },
                              },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          };
        }
        return { status: 404, body: { message: 'Not found' } };
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* HostAuth;
          const registry = yield* GitHostRegistry;
          yield* auth.connectPat('github', 'ghp_test', 'secure');
          const host = yield* registry.get('github');

          // 1st call: 200 + ETag stored + GraphQL hydrated
          const first = yield* host.listForRepo({ repo });
          expect(first.notModified).toBe(false);
          if (!first.notModified) {
            expect(first.summaries).toHaveLength(1);
            expect(first.summaries[0]?.ref.number).toBe(42);
          }
          expect(graphqlCalls).toBe(1);

          // 2nd call: sends If-None-Match -> 304 -> 0 additional GraphQL calls
          const second = yield* host.listForRepo({ repo });
          expect(second.notModified).toBe(true);
          expect(graphqlCalls).toBe(1);
          expect(requests.at(-1)?.ifNoneMatch).toBe('"etag-1"');

          // 3rd call with bypassEtag: true -> skips ETag and calls GraphQL
          const third = yield* host.listForRepo({ repo, bypassEtag: true });
          expect(third.notModified).toBe(false);
          expect(graphqlCalls).toBe(2);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('checks pull and check-runs ETags for getDetail when checkPending is true', async () => {
    let graphqlDetailCalls = 0;

    const storeRoot = await mkdtemp(path.join(tmpdir(), 'spence-gh-adapter-'));
    try {
      const layer = makeTestLayer(storeRoot, (req) => {
        if (req.url.endsWith('/user')) {
          return {
            status: 200,
            headers: { 'x-oauth-scopes': 'repo, read:org' },
            body: { login: 'alice', name: 'Alice', avatar_url: null },
          };
        }
        if (req.url.endsWith('/pulls/7')) {
          if (req.headers['if-none-match'] === '"pr-etag"') {
            return { status: 304, headers: { etag: '"pr-etag"' } };
          }
          return {
            status: 200,
            headers: { etag: '"pr-etag"' },
            body: { number: 7, head: { sha: 'sha-7' } },
          };
        }
        if (req.url.includes('/commits/sha-7/check-runs')) {
          if (req.headers['if-none-match'] === '"checks-etag"') {
            return { status: 304, headers: { etag: '"checks-etag"' } };
          }
          return {
            status: 200,
            headers: { etag: '"checks-etag"' },
            body: { total_count: 1, check_runs: [] },
          };
        }
        if (req.url.endsWith('/graphql')) {
          graphqlDetailCalls += 1;
          return {
            status: 200,
            body: {
              data: {
                repository: {
                  mergeCommitAllowed: true,
                  squashMergeAllowed: true,
                  rebaseMergeAllowed: false,
                  labels: { nodes: [] },
                  milestones: { nodes: [] },
                  assignableUsers: { nodes: [] },
                  pullRequest: {
                    number: 7,
                    title: 'Pending checks PR',
                    url: 'https://github.com/org/repo/pull/7',
                    body: 'Details',
                    state: 'OPEN',
                    isDraft: false,
                    headRefName: 'feat/checks',
                    headRefOid: 'sha-7',
                    baseRefName: 'main',
                    updatedAt: '2026-11-20T12:00:00Z',
                    isCrossRepository: false,
                    headRepository: { nameWithOwner: 'org/repo' },
                    mergeStateStatus: 'BLOCKED',
                    autoMergeRequest: null,
                    reviewDecision: 'REVIEW_REQUIRED',
                    viewerCanUpdate: true,
                    viewerDidAuthor: false,
                    viewerPermission: 'WRITE',
                    author: { login: 'alice', name: 'Alice', avatarUrl: null },
                    labels: { nodes: [] },
                    reviewRequests: { nodes: [] },
                    assignees: { nodes: [] },
                    milestone: null,
                    comments: { totalCount: 0, nodes: [] },
                    reviewThreads: { totalCount: 0, nodes: [] },
                    reviews: { nodes: [] },
                    commits: {
                      nodes: [
                        {
                          commit: {
                            statusCheckRollup: {
                              contexts: {
                                nodes: [
                                  {
                                    __typename: 'CheckRun',
                                    id: 'cr-1',
                                    name: 'ci',
                                    status: 'IN_PROGRESS',
                                    conclusion: null,
                                    detailsUrl: null,
                                    isRequired: true,
                                  },
                                ],
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        return { status: 404, body: {} };
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* HostAuth;
          const registry = yield* GitHostRegistry;
          yield* auth.connectPat('github', 'ghp_test', 'secure');
          const host = yield* registry.get('github');
          const num = PullRequestNumber.make(7);

          // Initial open (bypassEtag: true)
          const first = yield* host.getDetail({ repo, number: num, bypassEtag: true });
          expect(first.notModified).toBe(false);
          expect(graphqlDetailCalls).toBe(1);

          // Poll 1: primes REST ETags -> 200 -> calls GraphQL
          const poll1 = yield* host.getDetail({ repo, number: num, checkPending: true });
          expect(poll1.notModified).toBe(false);
          expect(graphqlDetailCalls).toBe(2);

          // Poll 2: both PR and check-runs return 304 -> notModified: true, 0 GraphQL calls
          const poll2 = yield* host.getDetail({ repo, number: num, checkPending: true });
          expect(poll2.notModified).toBe(true);
          expect(graphqlDetailCalls).toBe(2);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('updates PR metadata (title, body, baseRef, draft, reviewers, assignees, labels, milestone) via GraphQL and REST', async () => {
    const ops: Array<{ readonly kind: string; readonly payload: unknown }> = [];
    const storeRoot = await mkdtemp(path.join(tmpdir(), 'spence-gh-update-'));
    try {
      const layer = makeTestLayer(storeRoot, (req) => {
        if (req.url.endsWith('/user')) {
          return {
            status: 200,
            headers: { 'x-oauth-scopes': 'repo, read:org' },
            body: { login: 'alice', name: 'Alice', avatar_url: null },
          };
        }
        if (req.url.endsWith('/issues/7') && req.method === 'PATCH') {
          ops.push({ kind: 'patch-issue', payload: JSON.parse(req.bodyText) });
          return { status: 200, body: {} };
        }
        if (req.url.endsWith('/pulls/7/requested_reviewers') && req.method === 'POST') {
          ops.push({ kind: 'add-reviewers', payload: JSON.parse(req.bodyText) });
          return { status: 201, body: {} };
        }
        if (req.url.endsWith('/pulls/7/requested_reviewers') && req.method === 'DELETE') {
          ops.push({ kind: 'remove-reviewers', payload: JSON.parse(req.bodyText) });
          return { status: 200, body: {} };
        }
        if (req.url.endsWith('/graphql')) {
          const parsed = JSON.parse(req.bodyText) as { query: string; variables: unknown };
          if (parsed.query.includes('UpdatePullRequest(')) {
            ops.push({ kind: 'gql-update-pr', payload: parsed.variables });
            return {
              status: 200,
              body: { data: { updatePullRequest: { pullRequest: { id: 'PR_7' } } } },
            };
          }
          if (parsed.query.includes('ConvertPullRequestToDraft(')) {
            ops.push({ kind: 'gql-to-draft', payload: parsed.variables });
            return {
              status: 200,
              body: { data: { convertPullRequestToDraft: { pullRequest: { id: 'PR_7' } } } },
            };
          }
          if (parsed.query.includes('PullRequestDetail(')) {
            return {
              status: 200,
              body: {
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: true,
                    rebaseMergeAllowed: true,
                    viewerPermission: 'WRITE',
                    labels: { nodes: [{ name: 'bug', color: 'd73a4a', description: null }] },
                    milestones: { nodes: [{ id: 'MS_2', number: 2, title: 'v2.0', dueOn: null }] },
                    assignableUsers: { nodes: [{ login: 'bob', name: 'Bob', avatarUrl: null }] },
                    pullRequest: {
                      id: 'PR_7',
                      number: 7,
                      title: 'Updated title',
                      url: 'https://github.com/org/repo/pull/7',
                      body: 'Updated body',
                      state: 'OPEN',
                      isDraft: true,
                      headRefName: 'feat/x',
                      headRefOid: 'sha-7',
                      baseRefName: 'develop',
                      updatedAt: '2026-01-01T00:05:00.000Z',
                      isCrossRepository: false,
                      headRepository: { nameWithOwner: 'org/repo' },
                      mergeStateStatus: 'CLEAN',
                      autoMergeRequest: null,
                      reviewDecision: 'REVIEW_REQUIRED',
                      viewerCanUpdate: true,
                      viewerDidAuthor: true,
                      author: { login: 'alice', name: 'Alice', avatarUrl: null },
                      labels: { nodes: [{ name: 'bug', color: 'd73a4a', description: null }] },
                      reviewRequests: {
                        nodes: [
                          { requestedReviewer: { login: 'carol', name: 'Carol', avatarUrl: null } },
                        ],
                      },
                      assignees: { nodes: [{ login: 'bob', name: 'Bob', avatarUrl: null }] },
                      milestone: { id: 'MS_2', number: 2, title: 'v2.0', dueOn: null },
                      comments: { totalCount: 0, nodes: [] },
                      reviewThreads: { totalCount: 0, nodes: [] },
                      reviews: { nodes: [] },
                      commits: { nodes: [] },
                    },
                  },
                },
              },
            };
          }
        }
        return { status: 404, body: {} };
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* HostAuth;
          const registry = yield* GitHostRegistry;
          yield* auth.connectPat('github', 'ghp_test', 'secure');
          const host = yield* registry.get('github');
          const num = PullRequestNumber.make(7);
          const initialRes = yield* host.getDetail({ repo, number: num, bypassEtag: true });
          if (initialRes.notModified) throw new Error('expected detail');

          const updated = yield* host.update({
            repo,
            number: num,
            currentDetail: {
              ...initialRes.detail,
              state: 'open',
              reviewers: [{ login: 'old-rev', displayName: null, avatarUrl: null }],
              repoMilestones: [{ id: 'MS_2', number: 2, title: 'v2.0', dueOn: null }],
            },
            patch: {
              title: 'Updated title',
              body: 'Updated body',
              baseRef: 'develop',
              draft: true,
              reviewers: ['carol'],
              assignees: ['bob'],
              labels: ['bug'],
              milestoneId: 'MS_2',
            },
          });

          expect(updated.title).toBe('Updated title');
          expect(ops.map((o) => o.kind)).toContain('gql-update-pr');
          expect(ops.map((o) => o.kind)).toContain('gql-to-draft');
          expect(ops.map((o) => o.kind)).toContain('patch-issue');
          expect(ops.map((o) => o.kind)).toContain('add-reviewers');
          expect(ops.map((o) => o.kind)).toContain('remove-reviewers');
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it('handles comments (general, thread reply, pending/immediate diff line), reviews (own-PR & empty guards), and thread resolution', async () => {
    const mutations: Array<{ readonly op: string; readonly variables: Record<string, unknown> }> =
      [];
    let viewerDidAuthor = false;
    let hasPendingReview = false;
    let pendingHasInlineComments = false;
    let threadResolved = false;

    const storeRoot = await mkdtemp(path.join(tmpdir(), 'spence-gh-reviews-'));
    try {
      const layer = makeTestLayer(storeRoot, (req) => {
        if (req.url.endsWith('/user')) {
          return {
            status: 200,
            headers: { 'x-oauth-scopes': 'repo, read:org' },
            body: { login: 'alice', name: 'Alice', avatar_url: null },
          };
        }
        if (req.url.endsWith('/graphql')) {
          const parsed = JSON.parse(req.bodyText) as {
            query: string;
            variables: Record<string, unknown>;
          };
          if (parsed.query.includes('PullRequestNodeId(')) {
            return { status: 200, body: { data: { repository: { pullRequest: { id: 'PR_7' } } } } };
          }
          if (parsed.query.includes('AddComment(')) {
            mutations.push({ op: 'AddComment', variables: parsed.variables });
            return { status: 200, body: { data: { addComment: { clientMutationId: '1' } } } };
          }
          if (parsed.query.includes('AddReviewThreadReply(')) {
            mutations.push({ op: 'AddReviewThreadReply', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { addPullRequestReviewThreadReply: { comment: { id: 'RC_1' } } } },
            };
          }
          if (parsed.query.includes('AddPullRequestReview(')) {
            mutations.push({ op: 'AddPullRequestReview', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { addPullRequestReview: { pullRequestReview: { id: 'REV_NEW' } } } },
            };
          }
          if (parsed.query.includes('AddPullRequestReviewThread(')) {
            mutations.push({ op: 'AddPullRequestReviewThread', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { addPullRequestReviewThread: { thread: { id: 'THR_NEW' } } } },
            };
          }
          if (parsed.query.includes('UpdateIssueComment(')) {
            mutations.push({ op: 'UpdateIssueComment', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { updateIssueComment: { issueComment: { id: 'IC_1' } } } },
            };
          }
          if (parsed.query.includes('DeleteReviewComment(')) {
            mutations.push({ op: 'DeleteReviewComment', variables: parsed.variables });
            return {
              status: 200,
              body: {
                data: {
                  deletePullRequestReviewComment: { pullRequestReviewComment: { id: 'RC_1' } },
                },
              },
            };
          }
          if (parsed.query.includes('SubmitPullRequestReview(')) {
            mutations.push({ op: 'SubmitPullRequestReview', variables: parsed.variables });
            return {
              status: 200,
              body: {
                data: { submitPullRequestReview: { pullRequestReview: { id: 'REV_PENDING' } } },
              },
            };
          }
          if (parsed.query.includes('DeletePullRequestReview(')) {
            mutations.push({ op: 'DeletePullRequestReview', variables: parsed.variables });
            return {
              status: 200,
              body: {
                data: { deletePullRequestReview: { pullRequestReview: { id: 'REV_PENDING' } } },
              },
            };
          }
          if (parsed.query.includes('ResolveReviewThread(')) {
            threadResolved = true;
            mutations.push({ op: 'ResolveReviewThread', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { resolveReviewThread: { thread: { isResolved: true } } } },
            };
          }
          if (parsed.query.includes('UnresolveReviewThread(')) {
            threadResolved = false;
            mutations.push({ op: 'UnresolveReviewThread', variables: parsed.variables });
            return {
              status: 200,
              body: { data: { unresolveReviewThread: { thread: { isResolved: false } } } },
            };
          }
          if (parsed.query.includes('PullRequestDetail(')) {
            return {
              status: 200,
              body: {
                data: {
                  repository: {
                    mergeCommitAllowed: true,
                    squashMergeAllowed: true,
                    rebaseMergeAllowed: true,
                    viewerPermission: 'WRITE',
                    labels: { nodes: [] },
                    milestones: { nodes: [] },
                    assignableUsers: { nodes: [] },
                    pullRequest: {
                      id: 'PR_7',
                      number: 7,
                      title: 'PR 7',
                      url: 'https://github.com/org/repo/pull/7',
                      body: '',
                      state: 'OPEN',
                      isDraft: false,
                      headRefName: 'feat/x',
                      headRefOid: 'sha-7',
                      baseRefName: 'main',
                      updatedAt: '2026-01-01T00:00:00.000Z',
                      isCrossRepository: false,
                      headRepository: { nameWithOwner: 'org/repo' },
                      mergeStateStatus: 'CLEAN',
                      autoMergeRequest: null,
                      reviewDecision: 'REVIEW_REQUIRED',
                      viewerCanUpdate: true,
                      viewerDidAuthor,
                      author: {
                        login: viewerDidAuthor ? 'alice' : 'bob',
                        name: null,
                        avatarUrl: null,
                      },
                      labels: { nodes: [] },
                      reviewRequests: { nodes: [] },
                      assignees: { nodes: [] },
                      milestone: null,
                      comments: { totalCount: 0, nodes: [] },
                      reviews: {
                        nodes: hasPendingReview
                          ? [
                              {
                                id: 'REV_PENDING',
                                state: 'PENDING',
                                body: '',
                                submittedAt: null,
                                author: { login: 'alice', name: 'Alice', avatarUrl: null },
                              },
                            ]
                          : [],
                      },
                      reviewThreads: {
                        totalCount: 1,
                        nodes: [
                          {
                            id: 'THR_1',
                            path: 'src/a.ts',
                            line: 10,
                            startLine: null,
                            diffSide: 'RIGHT',
                            isResolved: threadResolved,
                            isOutdated: false,
                            comments: {
                              nodes: pendingHasInlineComments
                                ? [
                                    {
                                      id: 'RC_P1',
                                      body: 'pending note',
                                      createdAt: '2026-01-01T00:00:00.000Z',
                                      updatedAt: '2026-01-01T00:00:00.000Z',
                                      url: 'https://github.com/org/repo/pull/7#r1',
                                      pullRequestReview: { id: 'REV_PENDING' },
                                      author: { login: 'alice', name: 'Alice', avatarUrl: null },
                                    },
                                  ]
                                : [],
                            },
                          },
                        ],
                      },
                      commits: { nodes: [] },
                    },
                  },
                },
              },
            };
          }
        }
        return { status: 404, body: {} };
      });

      await Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* HostAuth;
          const registry = yield* GitHostRegistry;
          yield* auth.connectPat('github', 'ghp_test', 'secure');
          const host = yield* registry.get('github');
          const num = PullRequestNumber.make(7);

          // 1. General comment
          yield* host.addComment({ repo, number: num, body: 'Hello', target: { _tag: 'General' } });
          expect(mutations.at(-1)?.op).toBe('AddComment');

          // 2. Thread reply
          yield* host.addComment({
            repo,
            number: num,
            body: 'Reply',
            target: { _tag: 'ThreadReply', threadId: ReviewThreadId.make('THR_1') },
          });
          expect(mutations.at(-1)?.op).toBe('AddReviewThreadReply');

          // 3. Pending diff line comment when no pending review exists -> AddPullRequestReview (no event)
          yield* host.addComment({
            repo,
            number: num,
            body: 'Check this line',
            target: {
              _tag: 'DiffLine',
              path: 'src/a.ts',
              line: 12,
              side: 'LEFT',
              startLine: 10,
              startSide: 'LEFT',
              pending: true,
            },
          });
          expect(mutations.at(-1)?.op).toBe('AddPullRequestReview');
          expect(mutations.at(-1)?.variables['event']).toBeUndefined();

          // 4. Pending diff line comment when pending review ALREADY exists -> AddPullRequestReviewThread
          hasPendingReview = true;
          yield* host.addComment({
            repo,
            number: num,
            body: 'Another line',
            target: { _tag: 'DiffLine', path: 'src/a.ts', line: 15, side: 'RIGHT', pending: true },
          });
          expect(mutations.at(-1)?.op).toBe('AddPullRequestReviewThread');
          expect(mutations.at(-1)?.variables['pullRequestReviewId']).toBe('REV_PENDING');

          // 5. Immediate diff line comment (Comment now) -> AddPullRequestReview with event: COMMENT
          yield* host.addComment({
            repo,
            number: num,
            body: 'Immediate note',
            target: { _tag: 'DiffLine', path: 'src/a.ts', line: 20, side: 'RIGHT', pending: false },
          });
          expect(mutations.at(-1)?.op).toBe('AddPullRequestReview');
          expect(mutations.at(-1)?.variables['event']).toBe('COMMENT');

          // 6. Edit & delete comment
          yield* host.editComment({
            repo,
            number: num,
            commentId: CommentId.make('IC_1'),
            kind: 'issue',
            body: 'Edited',
          });
          expect(mutations.at(-1)?.op).toBe('UpdateIssueComment');

          yield* host.deleteComment({
            repo,
            number: num,
            commentId: CommentId.make('RC_1'),
            kind: 'review',
          });
          expect(mutations.at(-1)?.op).toBe('DeleteReviewComment');

          // 7. Request changes with empty body & no pending inline comments -> ValidationFailed
          const emptyErr = yield* host
            .submitReview({
              repo,
              number: num,
              reviewId: ReviewId.make('REV_PENDING'),
              event: 'requestChanges',
              body: '   ',
            })
            .pipe(Effect.flip);
          expect(emptyErr).toBeInstanceOf(GitHostError);
          expect(emptyErr.reason).toBe('ValidationFailed');

          // 8. Request changes with pending inline comment succeeds
          pendingHasInlineComments = true;
          yield* host.submitReview({
            repo,
            number: num,
            reviewId: ReviewId.make('REV_PENDING'),
            event: 'requestChanges',
            body: '',
          });
          expect(mutations.at(-1)?.op).toBe('SubmitPullRequestReview');
          expect(mutations.at(-1)?.variables['event']).toBe('REQUEST_CHANGES');

          // 9. Own-PR guard blocks approve & requestChanges
          viewerDidAuthor = true;
          const ownPrErr = yield* host
            .submitReview({
              repo,
              number: num,
              event: 'approve',
              body: 'LGTM',
            })
            .pipe(Effect.flip);
          expect(ownPrErr).toBeInstanceOf(GitHostError);
          expect(ownPrErr.reason).toBe('Forbidden');

          // 10. Delete pending review
          yield* host.deletePendingReview({
            repo,
            number: num,
            reviewId: ReviewId.make('REV_PENDING'),
          });
          expect(mutations.at(-1)?.op).toBe('DeletePullRequestReview');

          // 11. Resolve & unresolve thread
          const resolved = yield* host.resolveThread({
            repo,
            number: num,
            threadId: ReviewThreadId.make('THR_1'),
          });
          expect(resolved.reviewThreads[0]?.isResolved).toBe(true);
          const unresolved = yield* host.unresolveThread({
            repo,
            number: num,
            threadId: ReviewThreadId.make('THR_1'),
          });
          expect(unresolved.reviewThreads[0]?.isResolved).toBe(false);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
    }
  });
});
