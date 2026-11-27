import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  GitHostError,
  PullRequestNumber,
  PullRequestsRpcs,
  type CreatePrPreparation,
  type PullRequestSummary,
} from '../../../shared/pull-requests/pull-requests.rpc';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  SettingsRpcs,
  type Settings,
} from '../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { PrCreateForm } from './pr-create-form';

const projectId = ProjectId.make('proj-1');

const makePrep = (overrides?: Partial<CreatePrPreparation>): CreatePrPreparation => ({
  worktreePath: '/tmp/repo',
  headRef: 'feat/login',
  headSha: 'abc1234',
  defaultBaseRef: 'develop',
  baseRef: 'develop',
  availableBaseRefs: ['develop', 'main'],
  aheadCount: 2,
  behindCount: 0,
  needsPush: true,
  headRemoteName: 'origin',
  isFork: false,
  isDirty: true,
  templateBody: '## Checklist\n- [ ] Tests\n',
  supportsDraft: true,
  blockers: [],
  existingOpenPr: null,
  ...overrides,
});

const createdSummary: PullRequestSummary = {
  ref: { repo: { host: 'github', canonicalPath: 'org/repo' }, number: PullRequestNumber.make(42) },
  title: 'feat: login',
  state: 'open',
  author: { login: 'alice', displayName: 'Alice', avatarUrl: null },
  headRef: 'feat/login',
  headSha: 'abc1234',
  headRepo: { host: 'github', canonicalPath: 'org/repo' },
  baseRef: 'develop',
  updatedAt: 1_000,
  url: 'https://github.com/org/repo/pull/42',
  checkRollup: 'none',
  reviewDecision: 'none',
  commentCount: 0,
  unresolvedThreadCount: 0,
  viewerRoles: ['author'],
  isCrossRepo: false,
};

const setupForm = async (options?: {
  readonly prep?: CreatePrPreparation;
  readonly draft?: () => Effect.Effect<
    { readonly title: string; readonly body: string },
    GitHostError
  >;
  readonly onCreate?: (input: unknown) => void;
}) => {
  const prep = options?.prep ?? makePrep();
  const handlers = Layer.mergeAll(
    PullRequestsRpcs.toLayer({
      'HostAuth.getAccounts': () => Effect.succeed({ accounts: [], secretStorageAvailable: true }),
      'HostAuth.startDeviceFlow': () => Effect.die('unused'),
      'HostAuth.pollDeviceFlow': () => Effect.die('unused'),
      'HostAuth.cancelDeviceFlow': () => Effect.void,
      'HostAuth.connectPat': () => Effect.die('unused'),
      'HostAuth.checkGhCli': () => Effect.die('unused'),
      'HostAuth.importGhCli': () => Effect.die('unused'),
      'HostAuth.verify': () => Effect.die('unused'),
      'HostAuth.disconnect': () => Effect.void,
      'PullRequests.changes': () => Stream.empty,
      'PullRequests.setActiveView': () => Effect.void,
      'PullRequests.getProjectState': () => Effect.die('unused'),
      'PullRequests.refreshProject': () => Effect.die('unused'),
      'PullRequests.lookupByNumber': () => Effect.die('unused'),
      'PullRequests.unpinNumber': () => Effect.void,
      'PullRequests.getDetail': () => Effect.die('unused'),
      'PullRequests.getDiff': () => Effect.die('unused'),
      'PullRequests.prepareCreate': () => Effect.succeed(prep),
      'PullRequests.draftCreate':
        options?.draft ??
        (() => Effect.succeed({ title: 'AI drafted title', body: 'AI drafted body' })),
      'PullRequests.create': (input) =>
        Effect.sync(() => {
          options?.onCreate?.(input);
          return createdSummary;
        }),
      'PullRequests.update': () => Effect.die('unused'),
      'PullRequests.addComment': () => Effect.die('unused'),
      'PullRequests.editComment': () => Effect.die('unused'),
      'PullRequests.deleteComment': () => Effect.die('unused'),
      'PullRequests.submitReview': () => Effect.die('unused'),
      'PullRequests.deletePendingReview': () => Effect.die('unused'),
      'PullRequests.resolveThread': () => Effect.die('unused'),
      'PullRequests.unresolveThread': () => Effect.die('unused'),
    }),
    SettingsRpcs.toLayer({
      'Settings.get': () =>
        Effect.succeed({
          language: 'en',
          theme: 'system',
          notifications: false,
          sendMode: 'enter',
          projectOrder: [],
          crossProjectAccess: [],
          browserAllowedOrigins: [],
          defaultPermissionMode: 'ask',
          defaultAgent: 'claude',
          autoArchiveDays: 0,
          subagents: 'off',
          agents: {},
          pullRequests: DEFAULT_PULL_REQUEST_SETTINGS,
        } as unknown as Settings),
      'Settings.update': () => Effect.die('unused'),
    }),
  );

  TestBed.configureTestingModule({
    imports: [PrCreateForm],
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) },
      { provide: KEYMAP_PLATFORM, useValue: 'linux' },
    ],
  });

  const fixture = TestBed.createComponent(PrCreateForm);
  fixture.componentRef.setInput('projectId', projectId);
  fixture.detectChanges();
  await new Promise((r) => setTimeout(r, 30));
  fixture.detectChanges();
  return fixture;
};

describe('PrCreateForm', () => {
  it('shows Push & create, dirty note, and auto-drafted title/body', async () => {
    let createdPayload: unknown = null;
    const fixture = await setupForm({
      onCreate: (input) => {
        createdPayload = input;
      },
    });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="pr-create-dirty-note"]')).not.toBeNull();
    const submit = root.querySelector<HTMLButtonElement>('[data-testid="pr-create-submit"]');
    expect(submit?.textContent).toContain('Push & create');
    expect(submit?.disabled).toBe(false);

    const titleInput = root.querySelector<HTMLInputElement>(
      '[data-testid="pr-create-title-input"]',
    );
    const bodyInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="pr-create-body-input"]',
    );
    expect(titleInput?.value).toBe('AI drafted title');
    expect(bodyInput?.value).toBe('AI drafted body');

    submit?.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(createdPayload).toMatchObject({
      projectId,
      baseRef: 'develop',
      headRef: 'feat/login',
      pushFirst: true,
    });
  });

  it("disables submit when blockers exist and shows quiet Couldn't draft on draft failure", async () => {
    const fixture = await setupForm({
      prep: makePrep({
        needsPush: false,
        blockers: [{ reason: 'ZeroCommitsAhead', detail: 'No commits ahead of develop.' }],
      }),
      draft: () => Effect.fail(new GitHostError({ reason: 'HostError', detail: 'Draft failed' })),
    });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="pr-create-blockers"]')?.textContent).toContain(
      'No commits ahead of develop.',
    );
    const submit = root.querySelector<HTMLButtonElement>('[data-testid="pr-create-submit"]');
    expect(submit?.disabled).toBe(true);
    expect(submit?.textContent).toContain('Create pull request');
  });

  it("shows quiet Couldn't draft when draftCreate fails on an eligible branch", async () => {
    const fixture = await setupForm({
      draft: () => Effect.fail(new GitHostError({ reason: 'HostError', detail: 'Draft failed' })),
    });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[data-testid="pr-create-draft-failed"]')?.textContent).toContain(
      "Couldn't draft",
    );
    const bodyInput = root.querySelector<HTMLTextAreaElement>(
      '[data-testid="pr-create-body-input"]',
    );
    expect(bodyInput?.value).toBe('## Checklist\n- [ ] Tests\n');
  });
});
