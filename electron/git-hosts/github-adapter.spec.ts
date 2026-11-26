import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect } from 'vitest';
import {
  PullRequestNumber,
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
    const res = handler({ url: req.url, headers, method: req.method });
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
});
