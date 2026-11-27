import { TestBed } from '@angular/core/testing';
import { Effect, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProjectId } from '../../shared/projects/projects.rpc';
import {
  PullRequestNumber,
  PullRequestsRpcs,
  type HostCapabilities,
  type ProjectPullRequestsState,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../shared/pull-requests/pull-requests.rpc';
import { makeDesktopTestLayer } from './desktop-layers';
import { DESKTOP_LAYER } from './effect-runtime';
import { PullRequestsState } from './pull-requests-state';

const repo: RemoteRepoRef = { host: 'github', canonicalPath: 'org/repo' };
const projectId = ProjectId.make('proj-1');
const capabilities: HostCapabilities = {
  supportsDraft: true,
  supportsThreadResolution: true,
  supportsAutoMerge: true,
  supportsPendingReviews: true,
  supportsMilestones: true,
  supportedMergeMethods: ['merge', 'squash'],
};

const makeSummary = (num: number, headRef: string): PullRequestSummary => ({
  ref: { repo, number: PullRequestNumber.make(num) },
  title: `PR #${num}`,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef,
  headSha: `sha-${num}`,
  headRepo: repo,
  baseRef: 'main',
  updatedAt: 1_000 + num,
  url: `https://github.com/org/repo/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: [],
  isCrossRepo: false,
});

describe('PullRequestsState', () => {
  it('loads project state, computes openCountForProject, and resolves linkForBranch', async () => {
    const primary = makeSummary(42, 'feat/pr-42');
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: 5_000,
      summaries: [primary, { ...makeSummary(43, 'feat/closed'), state: 'closed' }],
      worktreeLinks: {
        '/repo/wt': {
          primary,
          openCount: 1,
          siblingRefs: [],
        },
      },
    };

    const layer = makeDesktopTestLayer(
      PullRequestsRpcs.toLayer({
        'HostAuth.getAccounts': () => Effect.die('unused'),
        'HostAuth.startDeviceFlow': () => Effect.die('unused'),
        'HostAuth.pollDeviceFlow': () => Effect.die('unused'),
        'HostAuth.cancelDeviceFlow': () => Effect.void,
        'HostAuth.connectPat': () => Effect.die('unused'),
        'HostAuth.checkGhCli': () => Effect.die('unused'),
        'HostAuth.importGhCli': () => Effect.die('unused'),
        'HostAuth.verify': () => Effect.die('unused'),
        'HostAuth.disconnect': () => Effect.die('unused'),
        'PullRequests.changes': () => Stream.empty,
        'PullRequests.getProjectState': () => Effect.succeed(available),
        'PullRequests.refreshProject': () => Effect.succeed(available),
        'PullRequests.setActiveView': () => Effect.void,
        'PullRequests.lookupByNumber': () => Effect.die('unused'),
        'PullRequests.unpinNumber': () => Effect.void,
        'PullRequests.getDetail': () => Effect.die('unused'),
        'PullRequests.getDiff': () => Effect.die('unused'),
        'PullRequests.prepareCreate': () => Effect.die('unused'),
        'PullRequests.draftCreate': () => Effect.die('unused'),
        'PullRequests.create': () => Effect.die('unused'),
        'PullRequests.merge': () => Effect.die('unused'),
        'PullRequests.setAutoMerge': () => Effect.die('unused'),
        'PullRequests.updateLocalBaseBranch': () => Effect.die('unused'),
        'PullRequests.switchToBaseBranch': () => Effect.die('unused'),
        'PullRequests.getPostMergeStatus': () => Effect.die('unused'),
        'PullRequests.update': () => Effect.die('unused'),
        'PullRequests.addComment': () => Effect.die('unused'),
        'PullRequests.editComment': () => Effect.die('unused'),
        'PullRequests.deleteComment': () => Effect.die('unused'),
        'PullRequests.submitReview': () => Effect.die('unused'),
        'PullRequests.deletePendingReview': () => Effect.die('unused'),
        'PullRequests.resolveThread': () => Effect.die('unused'),
        'PullRequests.unresolveThread': () => Effect.die('unused'),
      }),
    );

    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_LAYER, useValue: layer }],
    });

    const state = TestBed.inject(PullRequestsState);
    state.setActiveView({ projectId, prPageOpen: false, activePrNumber: null });
    state.loadProject(projectId);

    for (let i = 0; i < 6; i++) await Promise.resolve();

    expect(state.openCountForProject(projectId)).toBe(1);
    expect(state.linkForBranch('feat/pr-42')?.primary.ref.number).toBe(42);
    expect(state.linkForBranch('feat/unlinked')).toBeNull();
  });
});
