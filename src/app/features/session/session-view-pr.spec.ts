import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectId, Timestamp } from '../../../shared/projects/projects.rpc';
import {
  PullRequestNumber,
  PullRequestsRpcs,
  type ProjectPullRequestsState,
  type PullRequestSummary,
} from '../../../shared/pull-requests/pull-requests.rpc';
import {
  MessageId,
  SessionId,
  SessionsRpcs,
  TurnId,
  type ComposerDraft,
  type ComposerPullRequestAttachment,
  type SessionStreamItem,
} from '../../../shared/sessions/sessions.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { PullRequestsState } from '../../core/pull-requests-state';
import { SessionView } from './session-view';

const projectId = ProjectId.make('proj-pr-1');
const sessionId = SessionId.make('session-pr-1');
const turnId = TurnId.make('turn-pr-1');
const msgId = MessageId.make('msg-pr-1');
const now = Timestamp.make(1_700_000_000_000);

const makePr = (num: number, title: string): PullRequestSummary => ({
  ref: {
    repo: { host: 'github', canonicalPath: 'acme/spence' },
    number: PullRequestNumber.make(num),
  },
  title,
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: `feat/pr-${num}`,
  headSha: `sha${num}000000`,
  headRepo: { host: 'github', canonicalPath: 'acme/spence' },
  baseRef: 'main',
  updatedAt: now,
  url: `https://github.com/acme/spence/pull/${num}`,
  checkRollup: 'passing',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: ['author'],
  isCrossRepo: false,
});

const liveState = (): SessionStreamItem => ({
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    status: 'idle',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    commandsLoaded: true,
    queue: [],
    canAttachImages: true,
    imageLimits: { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 2 },
    agentName: 'Claude',
  },
});

const prStateAvailable = (
  summaries: ReadonlyArray<PullRequestSummary>,
): ProjectPullRequestsState => ({
  _tag: 'Available',
  projectId,
  repo: { host: 'github', canonicalPath: 'acme/spence' },
  targetRemoteName: 'origin',
  headRemoteName: 'origin',
  capabilities: {
    supportsDraft: true,
    supportsThreadResolution: true,
    supportsAutoMerge: true,
    supportsPendingReviews: true,
    supportsMilestones: true,
    supportedMergeMethods: ['squash'],
  },
  accountStatus: 'connected',
  syncStatus: { status: 'idle' },
  lastSyncedAt: now,
  summaries,
  worktreeLinks: {},
});

describe('SessionView PR attachments & @ picker', () => {
  const fixtures: Array<ComponentFixture<SessionView>> = [];

  afterEach(() => {
    for (const f of fixtures.splice(0)) f.destroy();
  });

  const mount = (options: {
    readonly summaries?: ReadonlyArray<PullRequestSummary>;
    readonly lookupPr?: PullRequestSummary;
    readonly events?: ReadonlyArray<SessionStreamItem>;
    readonly onPrompt?: (pullRequests?: ReadonlyArray<ComposerPullRequestAttachment>) => void;
    readonly onSavedDraft?: (draft: ComposerDraft) => void;
  }) => {
    const summaries = options.summaries ?? [
      makePr(10, 'Initial setup'),
      makePr(42, 'Composer PR context'),
    ];
    const layer = makeDesktopTestLayer(
      Layer.mergeAll(
        SessionsRpcs.toLayer({
          'Session.events': () => Stream.fromIterable([liveState(), ...(options.events ?? [])]),
          'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
          'Session.setComposer': ({ draft }) => {
            options.onSavedDraft?.(draft);
            return Effect.void;
          },
          'Session.prompt': ({ pullRequests }) => {
            options.onPrompt?.(pullRequests);
            return Effect.succeed(turnId);
          },
          'Session.changes': () => Stream.empty,
          'Session.list': () => Effect.succeed([]),
          'Session.create': () => Effect.succeed(sessionId),
          'Session.setAgent': () => Effect.void,
          'Session.steer': () => Effect.void,
          'Session.enqueue': () => Effect.void,
          'Session.setQueue': () => Effect.void,
          'Session.clearQueue': () => Effect.void,
          'Session.cancel': () => Effect.void,
          'Session.stopAgent': () => Effect.succeed({ _tag: 'stopped' as const }),
          'Session.rename': () => Effect.void,
          'Session.retryAgent': () => Effect.void,
          'Session.loginAgent': () => Effect.void,
          'Session.openAgentLog': () => Effect.void,
          'Session.answerPermission': () => Effect.void,
          'Session.setOption': () => Effect.void,
          'Session.clearContext': () => Effect.void,
          'Session.compact': () => Effect.void,
          'Session.startEmptyContext': () => Effect.void,
          'Session.archive': () => Effect.void,
          'Session.unarchive': () => Effect.void,
          'Session.countWorkers': () => Effect.succeed(0),
          'Session.delete': () => Effect.void,
          'Session.prepareHandoff': () => Effect.die('unused'),
          'Session.revalidateHandoff': () => Effect.die('unused'),
          'Session.executeHandoff': () => Effect.die('unused'),
          'Session.listHandoffAttempts': () => Effect.succeed([]),
          'Session.setTabs': () => Effect.void,
          'Session.restoreTabs': () => Effect.succeed(null),
        }),
        PullRequestsRpcs.toLayer({
          'HostAuth.getAccounts': () =>
            Effect.succeed({ accounts: [], secretStorageAvailable: true }),
          'HostAuth.startDeviceFlow': () => Effect.die('unused'),
          'HostAuth.pollDeviceFlow': () => Effect.die('unused'),
          'HostAuth.cancelDeviceFlow': () => Effect.void,
          'HostAuth.connectPat': () => Effect.die('unused'),
          'HostAuth.checkGhCli': () => Effect.die('unused'),
          'HostAuth.importGhCli': () => Effect.die('unused'),
          'HostAuth.verify': () => Effect.die('unused'),
          'HostAuth.disconnect': () => Effect.void,
          'PullRequests.changes': () => Stream.succeed(prStateAvailable(summaries)),
          'PullRequests.setActiveView': () => Effect.void,
          'PullRequests.getProjectState': () => Effect.succeed(prStateAvailable(summaries)),
          'PullRequests.refreshProject': () => Effect.succeed(prStateAvailable(summaries)),
          'PullRequests.lookupByNumber': ({ number }) =>
            options.lookupPr !== undefined && options.lookupPr.ref.number === number
              ? Effect.succeed(options.lookupPr)
              : Effect.die('not found'),
          'PullRequests.unpinNumber': () => Effect.void,
          'PullRequests.getDetail': () => Effect.die('unused'),
          'PullRequests.getDiff': () => Effect.die('unused'),
          'PullRequests.prepareCreate': () => Effect.die('unused'),
          'PullRequests.draftCreate': () => Effect.die('unused'),
          'PullRequests.create': () => Effect.die('unused'),
          'PullRequests.update': () => Effect.die('unused'),
          'PullRequests.addComment': () => Effect.die('unused'),
          'PullRequests.editComment': () => Effect.die('unused'),
          'PullRequests.deleteComment': () => Effect.die('unused'),
          'PullRequests.submitReview': () => Effect.die('unused'),
          'PullRequests.deletePendingReview': () => Effect.die('unused'),
          'PullRequests.resolveThread': () => Effect.die('unused'),
          'PullRequests.unresolveThread': () => Effect.die('unused'),
        }),
      ),
    );

    TestBed.configureTestingModule({
      imports: [SessionView],
      providers: [{ provide: DESKTOP_LAYER, useValue: layer }],
    });

    const fixture = TestBed.createComponent(SessionView);
    fixtures.push(fixture);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('projectId', projectId);
    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    return {
      fixture,
      prState: TestBed.inject(PullRequestsState),
    };
  };

  it('opens @ popover, attaches PR pill on Enter stripping @query, persists draft, and sends pullRequests', async () => {
    let sentPullRequests: ReadonlyArray<ComposerPullRequestAttachment> | undefined;
    const savedDrafts: ComposerDraft[] = [];
    const { fixture } = mount({
      onPrompt: (prs) => {
        sentPullRequests = prs;
      },
      onSavedDraft: (draft) => {
        savedDrafts.push(draft);
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const textarea = fixture.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Check @42';
    textarea.setSelectionRange(9, 9);
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const popover = fixture.nativeElement.querySelector('[data-testid="composer-pr-popover"]');
    expect(popover).not.toBeNull();

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    fixture.detectChanges();

    expect(textarea.value).toBe('Check ');
    const pill = fixture.nativeElement.querySelector('[data-testid="composer-pr-pill"]');
    expect(pill?.textContent).toContain('PR #42 · Composer PR context');
    expect(savedDrafts.at(-1)?.pullRequests?.length).toBe(1);

    // Send the message
    textarea.value = 'Review this PR';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(sentPullRequests).toHaveLength(1);
    expect(sentPullRequests?.[0]?.ref.number).toBe(42);
    expect(fixture.nativeElement.querySelector('[data-testid="composer-pr-pill"]')).toBeNull();
  });

  it('renders clickable PR pills on user Transcript Messages that open the PR page', async () => {
    const { fixture, prState } = mount({
      events: [
        {
          _tag: 'Transcript',
          event: {
            seq: 1,
            at: now,
            item: {
              _tag: 'Message',
              id: msgId,
              turnId,
              role: 'user',
              parts: [
                { _tag: 'text', text: 'Please check' },
                {
                  _tag: 'pullRequest',
                  kind: 'pullRequest',
                  ref: {
                    repo: { host: 'github', canonicalPath: 'acme/spence' },
                    number: PullRequestNumber.make(42),
                  },
                  title: 'Composer PR context',
                  state: 'open',
                  headSha: 'sha42000000',
                  url: 'https://github.com/acme/spence/pull/42',
                  snapshot: 'PR #42',
                },
              ],
            },
          },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const pill = fixture.nativeElement.querySelector(
      '[data-testid="message-pr-pill"]',
    ) as HTMLButtonElement | null;
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('PR #42 · Composer PR context');
    expect(pill?.title).toBe('sha4200 · open');

    pill?.click();
    expect(prState.prPageOpen()).toBe(true);
    expect(prState.selectedPrNumber()).toBe(42);
  });
});
