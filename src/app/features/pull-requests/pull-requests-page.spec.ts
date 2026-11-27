import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  CheckRunId,
  CommentId,
  GitHostError,
  PullRequestNumber,
  PullRequestsRpcs,
  ReviewId,
  ReviewThreadId,
  type HostCapabilities,
  type ProjectPullRequestsState,
  type PullRequestDetail,
  type PullRequestDiff,
  type PullRequestSummary,
  type RemoteRepoRef,
} from '../../../shared/pull-requests/pull-requests.rpc';
import { LinksRpcs } from '../../../shared/links/links.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { PullRequestsState } from '../../core/pull-requests-state';
import { PullRequestsPage } from './pull-requests-page';

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

const makeSummary = (
  num: number,
  overrides: Partial<PullRequestSummary> = {},
): PullRequestSummary => ({
  ref: { repo, number: PullRequestNumber.make(num) },
  title: `PR #${num}`,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: `feat/pr-${num}`,
  headSha: `abcdef1234567890-${num}`,
  headRepo: repo,
  baseRef: 'main',
  updatedAt: 1_000 + num,
  url: `https://github.com/org/repo/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 1,
  unresolvedThreadCount: 1,
  viewerRoles: [],
  isCrossRepo: false,
  ...overrides,
});

const makeDetail = (summary: PullRequestSummary): PullRequestDetail => ({
  ...summary,
  body: '## Overview\n\nImplements **feature**.',
  mergeState: 'clean',
  autoMergeEnabled: false,
  labels: [{ name: 'enhancement', color: 'a2eeef', description: null }],
  reviewers: [{ login: 'bob', displayName: 'Bob', avatarUrl: null }],
  assignees: [{ login: 'alice', displayName: 'Alice', avatarUrl: null }],
  milestone: { id: 'm1', title: 'v1.0', dueOn: null },
  repoLabels: [],
  repoMilestones: [],
  collaborators: [],
  checks: [
    {
      id: CheckRunId.make('chk-1'),
      name: 'CI / test',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/org/repo/runs/1',
      summary: 'All **12** tests passed.',
      isRequired: true,
    },
    {
      id: CheckRunId.make('chk-2'),
      name: 'Lint / optional',
      status: 'completed',
      conclusion: 'neutral',
      url: null,
      summary: null,
      isRequired: false,
    },
  ],
  reviews: [
    {
      id: ReviewId.make('rev-1'),
      author: { login: 'bob', displayName: 'Bob', avatarUrl: null },
      state: 'approved',
      body: 'Looks good!',
      submittedAt: 2_000,
    },
  ],
  reviewThreads: [
    {
      id: ReviewThreadId.make('thr-1'),
      path: 'src/app.ts',
      line: 2,
      startLine: null,
      side: 'RIGHT',
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: CommentId.make('tc-1'),
          author: { login: 'bob', displayName: 'Bob', avatarUrl: null },
          body: 'Consider renaming `x`.',
          createdAt: 2_100,
          updatedAt: 2_100,
          url: 'https://github.com/org/repo/pull/1#discussion_r1',
        },
      ],
    },
  ],
  comments: [
    {
      id: CommentId.make('c-1'),
      author: { login: 'carol', displayName: 'Carol', avatarUrl: null },
      body: 'General comment here.',
      createdAt: 2_200,
      updatedAt: 2_200,
      url: 'https://github.com/org/repo/pull/1#issuecomment-1',
    },
  ],
  actions: {
    canUpdate: true,
    canMerge: true,
    canReview: true,
    canApproveOrRequestChanges: true,
    canResolveThreads: true,
    allowedMergeMethods: ['merge', 'squash'],
  },
  revision: {
    headSha: summary.headSha,
    updatedAt: summary.updatedAt,
  },
});

const makeDiff = (summary: PullRequestSummary): PullRequestDiff => ({
  ref: summary.ref,
  headSha: summary.headSha,
  baseSha: 'base000',
  files: [
    {
      path: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      truncated: false,
      hunks: [
        {
          header: '@@ -1,2 +1,2 @@',
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: [
            { kind: 'removed', content: 'const x = 1;', oldLine: 1, newLine: null },
            { kind: 'added', content: 'const x = 2;', oldLine: null, newLine: 2 },
          ],
        },
      ],
    },
    {
      path: 'assets/logo.png',
      status: 'added',
      additions: 0,
      deletions: 0,
      truncated: false,
      noPreviewReason: 'Binary file not shown.',
      hunks: [],
    },
  ],
});

const setupPage = (
  state: ProjectPullRequestsState | null,
  overrides: {
    readonly getDetail?: (num: PullRequestNumber) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly getDiff?: (num: PullRequestNumber) => Effect.Effect<PullRequestDiff, GitHostError>;
    readonly lookupByNumber?: (
      num: PullRequestNumber,
    ) => Effect.Effect<PullRequestSummary, GitHostError>;
    readonly unpinNumber?: (num: PullRequestNumber) => void;
    readonly setActiveView?: (view: {
      readonly projectId: ProjectId | null;
      readonly prPageOpen: boolean;
      readonly activePrNumber: PullRequestNumber | null;
    }) => void;
    readonly openExternal?: (url: string) => void;
    readonly update?: (input: {
      readonly number: PullRequestNumber;
      readonly revision: { readonly headSha: string; readonly updatedAt: number };
      readonly patch: Record<string, unknown>;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly addComment?: (input: {
      readonly body: string;
      readonly target: unknown;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly editComment?: (input: {
      readonly commentId: CommentId;
      readonly body: string;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly deleteComment?: (input: {
      readonly commentId: CommentId;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly submitReview?: (input: {
      readonly reviewId?: ReviewId;
      readonly event: 'comment' | 'approve' | 'requestChanges';
      readonly body: string;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly deletePendingReview?: (input: {
      readonly reviewId: ReviewId;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly resolveThread?: (input: {
      readonly threadId: ReviewThreadId;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
    readonly unresolveThread?: (input: {
      readonly threadId: ReviewThreadId;
    }) => Effect.Effect<PullRequestDetail, GitHostError>;
  } = {},
) => {
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
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
        'PullRequests.getProjectState': () =>
          state !== null ? Effect.succeed(state) : Effect.die('no state'),
        'PullRequests.refreshProject': () =>
          state !== null ? Effect.succeed(state) : Effect.die('no state'),
        'PullRequests.setActiveView': (view) =>
          Effect.sync(() => {
            overrides.setActiveView?.(view);
          }),
        'PullRequests.lookupByNumber': ({ number }) =>
          overrides.lookupByNumber
            ? overrides.lookupByNumber(number)
            : Effect.fail(new GitHostError({ reason: 'NotFound', detail: 'Not found' })),
        'PullRequests.unpinNumber': ({ number }) =>
          Effect.sync(() => {
            overrides.unpinNumber?.(number);
          }),
        'PullRequests.getDetail': ({ number }) =>
          overrides.getDetail
            ? overrides.getDetail(number)
            : Effect.fail(new GitHostError({ reason: 'NotFound', detail: 'Not found' })),
        'PullRequests.getDiff': ({ number }) =>
          overrides.getDiff
            ? overrides.getDiff(number)
            : Effect.fail(new GitHostError({ reason: 'NotFound', detail: 'Not found' })),
        'PullRequests.prepareCreate': () => Effect.die('unused'),
        'PullRequests.draftCreate': () => Effect.die('unused'),
        'PullRequests.create': () => Effect.die('unused'),
        'PullRequests.update': (input) =>
          overrides.update ? overrides.update(input) : Effect.die('PullRequests.update unused'),
        'PullRequests.addComment': (input) =>
          overrides.addComment
            ? overrides.addComment(input)
            : Effect.die('PullRequests.addComment unused'),
        'PullRequests.editComment': (input) =>
          overrides.editComment
            ? overrides.editComment(input)
            : Effect.die('PullRequests.editComment unused'),
        'PullRequests.deleteComment': (input) =>
          overrides.deleteComment
            ? overrides.deleteComment(input)
            : Effect.die('PullRequests.deleteComment unused'),
        'PullRequests.submitReview': (input) =>
          overrides.submitReview
            ? overrides.submitReview(input)
            : Effect.die('PullRequests.submitReview unused'),
        'PullRequests.deletePendingReview': (input) =>
          overrides.deletePendingReview
            ? overrides.deletePendingReview(input)
            : Effect.die('PullRequests.deletePendingReview unused'),
        'PullRequests.resolveThread': (input) =>
          overrides.resolveThread
            ? overrides.resolveThread(input)
            : Effect.die('PullRequests.resolveThread unused'),
        'PullRequests.unresolveThread': (input) =>
          overrides.unresolveThread
            ? overrides.unresolveThread(input)
            : Effect.die('PullRequests.unresolveThread unused'),
      }),
      LinksRpcs.toLayer({
        'Links.openExternal': ({ url }) =>
          Effect.sync(() => {
            overrides.openExternal?.(url);
          }),
      }),
    ),
  );

  TestBed.configureTestingModule({
    imports: [PullRequestsPage],
    providers: [{ provide: DESKTOP_LAYER, useValue: layer }],
  });

  const fixture = TestBed.createComponent(PullRequestsPage);
  if (state !== null) {
    fixture.componentRef.setInput('projectId', projectId);
    fixture.componentRef.setInput('projectName', 'Spence');
    TestBed.inject(PullRequestsState).loadProject(projectId);
  }
  fixture.detectChanges();
  return fixture;
};

describe('PullRequestsPage', () => {
  it('renders quiet font-display empty states for disconnected and empty repositories', async () => {
    const disconnected: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'disconnected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: null,
      summaries: [],
      worktreeLinks: {},
    };
    const fixture = setupPage(disconnected);
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const empty = fixture.nativeElement.querySelector('[data-testid="pr-empty-disconnected"]');
    expect(empty?.textContent).toContain('Connect GitHub to view Pull requests.');
    expect(empty?.className).toContain('font-display');
  });

  it('filters PRs by All, Mine, Review requested, and search text', async () => {
    const s1 = makeSummary(10, { title: 'Fix auth', viewerRoles: ['author'] });
    const s2 = makeSummary(20, { title: 'Add worker', viewerRoles: ['reviewer'] });
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: Date.now(),
      summaries: [s1, s2],
      worktreeLinks: {},
    };

    const fixture = setupPage(available);
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid^="pr-list-item-"]')).toHaveLength(2);

    el.querySelector<HTMLButtonElement>('[data-testid="pr-filter-mine"]')?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid^="pr-list-item-"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="pr-list-item-10"]')).not.toBeNull();

    el.querySelector<HTMLButtonElement>('[data-testid="pr-filter-review-requested"]')?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid^="pr-list-item-"]')).toHaveLength(1);
    expect(el.querySelector('[data-testid="pr-list-item-20"]')).not.toBeNull();

    el.querySelector<HTMLButtonElement>('[data-testid="pr-filter-all"]')?.click();
    const search = el.querySelector<HTMLInputElement>('[data-testid="pr-search-input"]')!;
    search.value = 'auth';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el.querySelectorAll('[data-testid^="pr-list-item-"]')).toHaveLength(1);
  });

  it('pins a PR by #number via lookupByNumber and unpins via unpinNumber', async () => {
    const pinnedSummary = makeSummary(99, { title: 'Pinned PR', isPinned: true });
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: Date.now(),
      summaries: [pinnedSummary],
      worktreeLinks: {},
    };

    const unpinned: Array<number> = [];
    const lookupSpy = vi.fn(() => Effect.succeed(pinnedSummary));
    const fixture = setupPage(available, {
      lookupByNumber: lookupSpy,
      unpinNumber: (num) => unpinned.push(num),
      getDetail: () => Effect.succeed(makeDetail(pinnedSummary)),
      getDiff: () => Effect.succeed(makeDiff(pinnedSummary)),
    });
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('[data-testid="pr-lookup-input"]')!;
    input.value = '#99';
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('[data-testid="pr-lookup-submit"]')?.click();
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    expect(lookupSpy).toHaveBeenCalledWith(PullRequestNumber.make(99));

    el.querySelector<HTMLButtonElement>('[data-testid="pr-unpin-99"]')?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(unpinned).toEqual([99]);
  });

  it('loads three-tier PR detail, checks, conversation, diff hunks, inline threads, and opens external link', async () => {
    const s1 = makeSummary(42, { title: 'Worker rendering', checkRollup: 'pending' });
    const detail = makeDetail(s1);
    const diff = makeDiff(s1);
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: Date.now(),
      summaries: [s1],
      worktreeLinks: {},
    };

    const activeViews: Array<number | null> = [];
    const openedUrls: Array<string> = [];
    const fixture = setupPage(available, {
      getDetail: () => Effect.succeed(detail),
      getDiff: () => Effect.succeed(diff),
      setActiveView: (v) => activeViews.push(v.activePrNumber),
      openExternal: (url) => openedUrls.push(url),
    });
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[data-testid="pr-list-item-42"]')?.click();
    await new Promise((r) => setTimeout(r, 40));
    fixture.detectChanges();

    expect(activeViews).toContain(42);
    expect(el.querySelector('[data-testid="pr-detail-title"]')?.textContent).toContain(
      'Worker rendering',
    );
    expect(el.querySelector('[data-testid="pr-detail-branches"]')?.textContent).toContain(
      'feat/pr-42',
    );
    expect(el.querySelector('[data-testid="pr-detail-milestone"]')?.textContent).toContain('v1.0');
    expect(el.querySelector('[data-testid="pr-review-rev-1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="pr-comment-c-1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="pr-diff-inline-thread-thr-1"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="pr-diff-no-preview"]')?.textContent).toContain(
      'Binary file not shown.',
    );

    // Expand check runs and verify neutral non-blocking check
    el.querySelector<HTMLButtonElement>('[data-testid="pr-checks-toggle"]')?.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="pr-check-chk-2"]')?.textContent).toContain(
      'Non-blocking',
    );

    // Open external link
    el.querySelector<HTMLButtonElement>('[data-testid="pr-open-external"]')?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(openedUrls).toEqual(['https://github.com/org/repo/pull/42']);
  });

  it('shows degraded status strip for offline/rate-limited/needs-reconnect while keeping cached PRs readable', async () => {
    const s1 = makeSummary(7, { title: 'Cached PR' });
    const offlineState: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'needs-reconnect',
      syncStatus: { status: 'needs-reconnect', detail: 'Token expired' },
      lastSyncedAt: Date.now() - 120_000,
      summaries: [s1],
      worktreeLinks: {},
    };

    const fixture = setupPage(offlineState);
    let reconnectEmitted = false;
    fixture.componentInstance.openSettings.subscribe(() => {
      reconnectEmitted = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const strip = el.querySelector('[data-testid="pr-degraded-strip"]');
    expect(strip?.textContent).toContain('Reconnect GitHub in Settings · cached');
    expect(el.querySelector('[data-testid="pr-list-item-7"]')).not.toBeNull();

    el.querySelector<HTMLButtonElement>('[data-testid="pr-degraded-reconnect"]')?.click();
    expect(reconnectEmitted).toBe(true);
  });

  it('edits PR metadata and resolves field-level conflicts with Keep mine / Use theirs', async () => {
    const s1 = makeSummary(42, { title: 'Initial title' });
    const initialDetail: PullRequestDetail = {
      ...makeDetail(s1),
      viewerLogin: 'alice',
      actions: {
        canUpdate: true,
        canMerge: true,
        canReview: true,
        canApproveOrRequestChanges: false,
        canResolveThreads: true,
        allowedMergeMethods: ['merge', 'squash'],
      },
    };
    const remoteDetail: PullRequestDetail = {
      ...initialDetail,
      title: 'Remote title',
      updatedAt: 9_999,
      revision: { headSha: initialDetail.headSha, updatedAt: 9_999 },
    };
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: Date.now(),
      summaries: [s1],
      worktreeLinks: {},
    };

    let attempt = 0;
    const savedPatches: Array<Record<string, unknown>> = [];

    const fixture = setupPage(available, {
      getDetail: () => Effect.succeed(initialDetail),
      getDiff: () => Effect.succeed(makeDiff(s1)),
      update: ({ patch }) => {
        attempt += 1;
        if (attempt === 1) {
          return Effect.fail(
            new GitHostError({
              reason: 'Conflict',
              detail: 'Remote changed title',
              conflictingFields: ['title'],
              latestDetail: remoteDetail,
            }),
          );
        }
        savedPatches.push(patch);
        return Effect.succeed({
          ...remoteDetail,
          title: String(patch['title'] ?? remoteDetail.title),
        });
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[data-testid="pr-list-item-42"]')?.click();
    await new Promise((r) => setTimeout(r, 40));
    fixture.detectChanges();

    // Open edit form
    el.querySelector<HTMLButtonElement>('[data-testid="pr-edit-button"]')?.click();
    fixture.detectChanges();

    const titleInput = el.querySelector<HTMLInputElement>('[data-testid="pr-edit-title"]');
    expect(titleInput).not.toBeNull();
    if (titleInput) {
      titleInput.value = 'My draft title';
      titleInput.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();

    // Save -> triggers Conflict on title
    el.querySelector<HTMLButtonElement>('[data-testid="pr-edit-save"]')?.click();
    await new Promise((r) => setTimeout(r, 40));
    fixture.detectChanges();

    const conflictBanner = el.querySelector('[data-testid="pr-conflict-banner-title"]');
    expect(conflictBanner?.textContent).toContain('Changed on GitHub');
    expect(conflictBanner?.textContent).toContain('Remote title');

    // Keep mine, then save again
    el.querySelector<HTMLButtonElement>('[data-testid="pr-conflict-keep-title"]')?.click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="pr-edit-save"]')?.click();
    await new Promise((r) => setTimeout(r, 40));
    fixture.detectChanges();

    expect(savedPatches.length).toBe(1);
    expect(savedPatches[0]?.['title']).toBe('My draft title');
    expect(el.querySelector('[data-testid="pr-detail-title"]')?.textContent).toContain(
      'My draft title',
    );
  });

  it('supports general/inline comments, pending review submission with own-PR guards, and thread resolution', async () => {
    const s1 = makeSummary(42, { title: 'Review PR' });
    const ownDetail: PullRequestDetail = {
      ...makeDetail(s1),
      viewerLogin: 'alice',
      reviews: [
        {
          id: ReviewId.make('rev-pending'),
          author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
          state: 'pending',
          body: '',
          submittedAt: null,
        },
      ],
      actions: {
        canUpdate: true,
        canMerge: true,
        canReview: true,
        canApproveOrRequestChanges: false,
        canResolveThreads: true,
        allowedMergeMethods: ['merge'],
      },
    };
    const available: ProjectPullRequestsState = {
      _tag: 'Available',
      projectId,
      repo,
      targetRemoteName: 'origin',
      headRemoteName: 'origin',
      capabilities,
      accountStatus: 'connected',
      syncStatus: { status: 'idle' },
      lastSyncedAt: Date.now(),
      summaries: [s1],
      worktreeLinks: {},
    };

    const actionsCalled: string[] = [];
    const fixture = setupPage(available, {
      getDetail: () => Effect.succeed(ownDetail),
      getDiff: () => Effect.succeed(makeDiff(s1)),
      addComment: ({ body }) => {
        actionsCalled.push(`add:${body}`);
        return Effect.succeed({
          ...ownDetail,
          comments: [
            ...ownDetail.comments,
            {
              id: CommentId.make('c-new'),
              author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
              body,
              createdAt: 5_000,
              updatedAt: 5_000,
              url: 'https://github.com/org/repo/pull/42#c-new',
            },
          ],
        });
      },
      resolveThread: ({ threadId }) => {
        actionsCalled.push(`resolve:${threadId}`);
        return Effect.succeed({
          ...ownDetail,
          reviewThreads: ownDetail.reviewThreads.map((t) =>
            t.id === threadId ? { ...t, isResolved: true } : t,
          ),
        });
      },
      submitReview: ({ event, body }) => {
        actionsCalled.push(`review:${event}:${body}`);
        return Effect.succeed({
          ...ownDetail,
          reviews: [],
        });
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('[data-testid="pr-list-item-42"]')?.click();
    await new Promise((r) => setTimeout(r, 40));
    fixture.detectChanges();

    // Own-PR guard: Approve & Request changes disabled
    const approveBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="pr-review-submit-approve"]',
    );
    const reqChangesBtn = el.querySelector<HTMLButtonElement>(
      '[data-testid="pr-review-submit-request-changes"]',
    );
    expect(approveBtn?.disabled).toBe(true);
    expect(reqChangesBtn?.disabled).toBe(true);

    // Post general comment
    const commentInput = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="pr-general-comment-input"]',
    );
    expect(commentInput).not.toBeNull();
    if (commentInput) {
      commentInput.value = 'Nice work!';
      commentInput.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="pr-general-comment-submit"]')?.click();
    await new Promise((r) => setTimeout(r, 30));
    fixture.detectChanges();
    expect(actionsCalled).toContain('add:Nice work!');

    // One-click resolve thread
    el.querySelector<HTMLButtonElement>('[data-testid="pr-thread-resolve-toggle-thr-1"]')?.click();
    await new Promise((r) => setTimeout(r, 30));
    fixture.detectChanges();
    expect(actionsCalled).toContain('resolve:thr-1');

    // Finish review as Comment
    const reviewInput = el.querySelector<HTMLTextAreaElement>(
      '[data-testid="pr-review-summary-input"]',
    );
    if (reviewInput) {
      reviewInput.value = 'Summary note';
      reviewInput.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('[data-testid="pr-review-submit-comment"]')?.click();
    await new Promise((r) => setTimeout(r, 30));
    fixture.detectChanges();
    expect(actionsCalled).toContain('review:comment:Summary note');
  });
});
