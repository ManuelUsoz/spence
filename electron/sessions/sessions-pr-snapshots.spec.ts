import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  GitHostError,
  PullRequestNumber,
  type PullRequestDetail,
} from '../../src/shared/pull-requests/pull-requests.rpc';
import type { ComposerPullRequestAttachment } from '../../src/shared/sessions/sessions.rpc';
import {
  PullRequestsService,
  type PullRequestsServiceShape,
} from '../git-hosts/pull-requests-service';
import { Sessions } from './sessions';
import { events, text, transcript, untilTurnEnd, withSessionsCustom } from './sessions-spec-fakes';

const projectId = ProjectId.make('proj-1');
const now = Timestamp.make(1_700_000_000_000);

const makeDetail = (): PullRequestDetail => ({
  ref: {
    repo: { host: 'github', canonicalPath: 'acme/spence' },
    number: PullRequestNumber.make(198),
  },
  title: 'Add Composer PR context',
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: 'feat/pr-context',
  headSha: 'abc1234567890',
  headRepo: { host: 'github', canonicalPath: 'acme/spence' },
  baseRef: 'main',
  updatedAt: now,
  url: 'https://github.com/acme/spence/pull/198',
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: ['author'],
  isCrossRepo: false,
  body: 'PR description body',
  mergeState: 'clean',
  autoMergeEnabled: false,
  labels: [],
  reviewers: [],
  assignees: [],
  milestone: null,
  repoLabels: [],
  repoMilestones: [],
  collaborators: [],
  checks: [],
  reviews: [],
  reviewThreads: [],
  comments: [],
  actions: {
    canUpdate: true,
    canMerge: true,
    canReview: true,
    canApproveOrRequestChanges: true,
    canResolveThreads: true,
    allowedMergeMethods: ['squash'],
  },
  revision: { headSha: 'abc1234567890', updatedAt: now },
});

const attachment: ComposerPullRequestAttachment = {
  kind: 'pullRequest',
  projectId,
  ref: {
    repo: { host: 'github', canonicalPath: 'acme/spence' },
    number: PullRequestNumber.make(198),
  },
  title: 'Add Composer PR context',
  state: 'open',
  headSha: 'abc1234567890',
  url: 'https://github.com/acme/spence/pull/198',
};

const makePrServiceLayer = (
  getSnapshotInputs: PullRequestsServiceShape['getSnapshotInputs'],
): Layer.Layer<PullRequestsService> =>
  Layer.succeed(PullRequestsService, {
    changes: Stream.empty,
    setActiveView: () => Effect.void,
    getProjectState: () => Effect.die('unused'),
    refreshProject: () => Effect.die('unused'),
    lookupByNumber: () => Effect.die('unused'),
    unpinNumber: () => Effect.void,
    getDetail: () => Effect.die('unused'),
    getDiff: () => Effect.die('unused'),
    getSnapshotInputs,
    prepareCreate: () => Effect.die('unused'),
    draftCreate: () => Effect.die('unused'),
    create: () => Effect.die('unused'),
    update: () => Effect.die('unused'),
    addComment: () => Effect.die('unused'),
    editComment: () => Effect.die('unused'),
    deleteComment: () => Effect.die('unused'),
    submitReview: () => Effect.die('unused'),
    deletePendingReview: () => Effect.die('unused'),
    resolveThread: () => Effect.die('unused'),
    unresolveThread: () => Effect.die('unused'),
    notifyTurnEnded: () => Effect.void,
    evictProject: () => Effect.void,
    evictAll: () => Effect.void,
  });

describe('Sessions PR send-time snapshots', () => {
  it.effect('resolves PullRequestPart on prompt and stores it on the Transcript Message', () =>
    withSessionsCustom(
      {
        pullRequests: makePrServiceLayer(() =>
          Effect.succeed({
            detail: makeDetail(),
            isCachedFallback: false,
            fetchedAt: now,
          }),
        ),
      },
      (projId) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(projId);
          yield* sessions.prompt(id, text('echo:hello'), undefined, [
            { ...attachment, projectId: projId },
          ]);
          const streamItems = yield* untilTurnEnd(events(id));
          const items = transcript(streamItems);
          const userMessage = items.find((item) => item._tag === 'Message' && item.role === 'user');
          expect(userMessage?._tag).toBe('Message');
          if (userMessage?._tag === 'Message') {
            const prPart = userMessage.parts.find((p) => p._tag === 'pullRequest');
            expect(prPart).toBeDefined();
            if (prPart?._tag === 'pullRequest') {
              expect(prPart.ref.number).toBe(198);
              expect(prPart.snapshot).toContain('PR #198: Add Composer PR context');
              expect(prPart.isCachedFallback).toBeUndefined();
            }
          }
        }),
    ),
  );

  it.effect('includes cached snapshot header when offline fallback is used', () =>
    withSessionsCustom(
      {
        pullRequests: makePrServiceLayer(() =>
          Effect.succeed({
            detail: makeDetail(),
            isCachedFallback: true,
            fetchedAt: now,
          }),
        ),
      },
      (projId) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(projId);
          yield* sessions.prompt(id, text('echo:cached'), undefined, [
            { ...attachment, projectId: projId },
          ]);
          const streamItems = yield* untilTurnEnd(events(id));
          const items = transcript(streamItems);
          const userMessage = items.find((item) => item._tag === 'Message' && item.role === 'user');
          if (userMessage?._tag === 'Message') {
            const prPart = userMessage.parts.find((p) => p._tag === 'pullRequest');
            expect(prPart?._tag).toBe('pullRequest');
            if (prPart?._tag === 'pullRequest') {
              expect(prPart.isCachedFallback).toBe(true);
              expect(prPart.snapshot).toContain('[cached snapshot');
            }
          }
        }),
    ),
  );

  it.effect('blocks send with PullRequestUnavailable when offline and no cache exists', () =>
    withSessionsCustom(
      {
        pullRequests: makePrServiceLayer(() =>
          Effect.fail(
            new GitHostError({
              reason: 'NetworkUnavailable',
              detail: 'GitHub is unreachable',
            }),
          ),
        ),
      },
      (projId) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const id = yield* sessions.create(projId);
          const err = yield* Effect.flip(
            sessions.prompt(id, text('echo:fail'), undefined, [
              { ...attachment, projectId: projId },
            ]),
          );
          expect(err.reason).toBe('PullRequestUnavailable');
          expect(err.detail).toContain('GitHub is unreachable');
          expect(yield* sessions.isDraft(id)).toBe(true);
        }),
    ),
  );
});
