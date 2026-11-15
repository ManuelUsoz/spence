import { Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionStreamItem,
  type LiveState,
} from '../../../shared/sessions/sessions.rpc';
import {
  SourceControlError,
  SourceControlRpcs,
  type CommitDetail,
  type CommitHistorySnapshot,
  type CurrentChangesSnapshot,
  type DiffPreview,
  type DiffScope,
} from '../../../shared/source-control/source-control.rpc';
import { WorktreesRpcs } from '../../../shared/worktrees/worktrees.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { InspectorPanel } from './inspector-panel';
import { SessionView } from './session-view';

@Component({ selector: 'app-install-offer-stub', template: '' })
class InstallOfferStub {}

const sessionId = SessionId.make('session-inspector-1');
const projectId = ProjectId.make('project-1');

const liveItem: SessionStreamItem = {
  _tag: 'Live',
  state: {
    agentStatus: 'ready',
    title: { autoIsPlaceholder: false },
    options: { permissionMode: 'auto' },
    commands: [],
    canAttachImages: false,
    imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  } satisfies LiveState,
};

const sampleChangesSnapshot = (
  patch?: Partial<CurrentChangesSnapshot>,
): CurrentChangesSnapshot => ({
  sessionId,
  cwd: 'C:/repo/wt-feature',
  inspectedAt: 1_700_000_001_000,
  state: {
    _tag: 'Available',
    gitVersion: '2.47.0',
    toplevelPath: 'C:/repo/wt-feature',
    head: {
      _tag: 'Branch',
      branch: 'feat/inspector',
      ref: 'refs/heads/feat/inspector',
      commit: '1234567890abcdef',
    },
    integration: 'None',
    hasConflicts: false,
    unstablePaths: [],
    excludedEntries: [],
    incompleteDiffCounts: false,
    summary: {
      changedCount: 3,
      stagedCount: 1,
      unstagedCount: 3,
      untrackedCount: 1,
      conflictedCount: 0,
      additions: 5,
      deletions: 2,
    },
    files: [
      {
        path: 'src/app.ts',
        status: 'Modified',
        indexStatus: 'Modified',
        workTreeStatus: 'Modified',
        staged: true,
        unstaged: true,
        hasStagedAndUnstaged: true,
        stagedNetZeroWorking: false,
        kind: 'Regular',
        additions: 3,
        deletions: 1,
      },
      {
        path: 'src/old-deleted.ts',
        status: 'Deleted',
        indexStatus: 'Unmodified',
        workTreeStatus: 'Deleted',
        staged: false,
        unstaged: true,
        hasStagedAndUnstaged: false,
        stagedNetZeroWorking: false,
        kind: 'Regular',
        additions: 0,
        deletions: 1,
      },
      {
        path: 'notes/untracked.md',
        status: 'Untracked',
        indexStatus: 'Untracked',
        workTreeStatus: 'Untracked',
        staged: false,
        unstaged: true,
        hasStagedAndUnstaged: false,
        stagedNetZeroWorking: false,
        kind: 'Regular',
        additions: 2,
        deletions: 0,
      },
    ],
  },
  ...patch,
});

interface SourceControlStub {
  readonly status: () => Effect.Effect<CurrentChangesSnapshot, SourceControlError>;
  readonly diff: (
    path: string,
    scope?: DiffScope,
  ) => Effect.Effect<DiffPreview, SourceControlError>;
  readonly commits: (
    limit?: number,
    offset?: number,
  ) => Effect.Effect<CommitHistorySnapshot, SourceControlError>;
  readonly commitDetail: (sha: string) => Effect.Effect<CommitDetail, SourceControlError>;
  readonly commitFileDiff: (
    sha: string,
    path: string,
  ) => Effect.Effect<DiffPreview, SourceControlError>;
}

const makeLayer = (sc: Partial<SourceControlStub>, onStatusCall?: () => void) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      AgentsRpcs.toLayer({
        'Agents.list': () => Effect.succeed([]),
        'Agents.installCommand': () => Effect.die('unused'),
        'Agents.install': () => Effect.die('unused'),
        'Agents.openInstallLog': () => Effect.die('unused'),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.locate': () => Effect.succeed(null),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      WorktreesRpcs.toLayer({
        'Worktrees.inventory': ({ path }) =>
          Effect.succeed({
            projectId,
            cwd: path,
            capability: { _tag: 'Available', gitVersion: '2.47.0', executable: 'git' },
            worktrees: [],
            refreshedAt: 1,
          }),
        'Worktrees.refresh': ({ path }) =>
          Effect.succeed({
            projectId,
            cwd: path,
            capability: { _tag: 'Available', gitVersion: '2.47.0', executable: 'git' },
            worktrees: [],
            refreshedAt: 2,
          }),
        'Worktrees.locate': () => Effect.die('unused'),
        'Worktrees.prepareCreate': () => Effect.die('unused'),
        'Worktrees.revalidateCreate': () => Effect.die('unused'),
        'Worktrees.executeCreate': () => Effect.die('unused'),
        'Worktrees.pickDestination': () => Effect.die('unused'),
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.succeed([]),
        'Session.create': () => Effect.succeed(sessionId),
        'Session.setAgent': () => Effect.void,
        'Session.prompt': () => Effect.die('unused'),
        'Session.rename': () => Effect.void,
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.cancel': () => Effect.void,
        'Session.stopAgent': () => Effect.succeed({ _tag: 'stopped', pid: 1 }),
        'Session.answerPermission': () => Effect.void,
        'Session.setOption': () => Effect.void,
        'Session.clearContext': () => Effect.void,
        'Session.compact': () => Effect.void,
        'Session.startEmptyContext': () => Effect.void,
        'Session.archive': () => Effect.void,
        'Session.unarchive': () => Effect.void,
        'Session.delete': () => Effect.void,
        'Session.events': () => Stream.make(liveItem),
        'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
        'Session.setComposer': () => Effect.void,
        'Session.prepareHandoff': () => Effect.die('unused'),
        'Session.revalidateHandoff': () => Effect.die('unused'),
        'Session.executeHandoff': () => Effect.die('unused'),
        'Session.selectDraftWorktree': () => Effect.void,
        'Session.locateWorktree': () => Effect.succeed({ _tag: 'Cancelled' }),
        'Session.listHandoffAttempts': () => Effect.succeed([]),
      }),
      SourceControlRpcs.toLayer({
        'SourceControl.listOperations': () => Effect.die('unused'),
        'SourceControl.getOperation': () => Effect.die('unused'),
        'SourceControl.operationEvents': () => Stream.empty,
        'SourceControl.reconcileOperation': () => Effect.die('unused'),
        'SourceControl.dismissOperation': () => Effect.die('unused'),
        'SourceControl.cancelOperation': () => Effect.die('unused'),
        'SourceControl.status': () =>
          Effect.sync(() => {
            onStatusCall?.();
          }).pipe(
            Effect.andThen(sc.status ? sc.status() : Effect.succeed(sampleChangesSnapshot())),
          ),
        'SourceControl.diff': ({ path, scope }) =>
          sc.diff
            ? sc.diff(path, scope)
            : Effect.succeed({
                _tag: 'Patch',
                path,
                scope: scope ?? 'combined',
                hunks: [
                  {
                    header: '@@ -1,1 +1,2 @@',
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 2,
                    lines: [
                      { kind: 'context', oldLine: 1, newLine: 1, text: 'base' },
                      { kind: 'add', newLine: 2, text: 'added' },
                    ],
                  },
                ],
                additions: 1,
                deletions: 0,
                truncated: false,
                unstable: false,
              }),
        'SourceControl.commits': ({ limit, offset }) =>
          sc.commits
            ? sc.commits(limit, offset)
            : Effect.succeed({
                _tag: 'History',
                sessionId,
                cwd: 'C:/repo/wt-feature',
                head: {
                  _tag: 'Branch',
                  branch: 'feat/inspector',
                  ref: 'refs/heads/feat/inspector',
                },
                commits: [],
                hasMore: false,
              }),
        'SourceControl.commitDetail': ({ sha }) =>
          sc.commitDetail
            ? sc.commitDetail(sha)
            : Effect.fail(
                new SourceControlError({ reason: 'NotFound', detail: 'commit not stubbed' }),
              ),
        'SourceControl.commitFileDiff': ({ sha, path }) =>
          sc.commitFileDiff
            ? sc.commitFileDiff(sha, path)
            : Effect.fail(
                new SourceControlError({
                  reason: 'NotFound',
                  detail: 'commit file diff not stubbed',
                }),
              ),
      }),
    ),
  );

const flush = async (fixture: ComponentFixture<unknown>): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  fixture.detectChanges();
};

const query = <T extends Element>(fixture: ComponentFixture<unknown>, selector: string): T => {
  const el = (fixture.nativeElement as HTMLElement).querySelector<T>(selector);
  expect(el).not.toBeNull();
  return el as T;
};

describe('Right inspector panel (Changes and Git history)', () => {
  it('stays closed on mount without calling SourceControl.status, opens from composer-bottom, updates counts, and restores focus on close', async () => {
    let statusCalls = 0;
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeLayer({}, () => {
            statusCalls += 1;
          }),
        },
        { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
      ],
    });
    const fixture = TestBed.createComponent(SessionView);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('projectId', projectId);
    fixture.detectChanges();
    await flush(fixture);

    expect(statusCalls).toBe(0);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="inspector-panel"]'),
    ).toBeNull();

    const toggleBtn = query<HTMLButtonElement>(fixture, '[data-testid="inspector-toggle"]');
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    toggleBtn.focus();
    toggleBtn.click();
    await flush(fixture);

    expect(statusCalls).toBe(1);
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true');
    const panel = query<HTMLElement>(fixture, '[data-testid="inspector-panel"]');
    expect(panel.textContent).toContain('feat/inspector');
    expect(toggleBtn.textContent).toContain('3');
    expect(toggleBtn.textContent).toContain('+5');

    // Write actions from #108-#119 remain omitted/disabled in #102
    const buttonTexts = [...panel.querySelectorAll('button')].map((b) =>
      (b.textContent ?? '').trim().toLowerCase(),
    );
    for (const forbidden of ['commit', 'push', 'discard', 'restore']) {
      expect(buttonTexts).not.toContain(forbidden);
    }

    const closeBtn = query<HTMLButtonElement>(fixture, '[data-testid="inspector-close"]');
    closeBtn.click();
    await flush(fixture);

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="inspector-panel"]'),
    ).toBeNull();
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggleBtn);
  });

  it('renders current-change rows, supports combined/staged/unstaged inline diff scopes, and discloses unstable/binary/too-large files', async () => {
    const diffCalls: Array<{ readonly path: string; readonly scope?: DiffScope }> = [];
    const snapshotWithEdgeCases: CurrentChangesSnapshot = {
      sessionId,
      cwd: 'C:/repo/wt-feature',
      inspectedAt: 2_000,
      state: {
        _tag: 'Available',
        gitVersion: '2.47.0',
        toplevelPath: 'C:/repo/wt-feature',
        head: { _tag: 'Branch', branch: 'main', ref: 'refs/heads/main', commit: 'abc1234' },
        integration: 'Merge',
        hasConflicts: true,
        unstablePaths: ['src/app.ts'],
        instabilityDetail: 'Detected concurrent edits while inspecting src/app.ts.',
        excludedEntries: [
          {
            path: 'nested-repo',
            reason: 'NestedRepo',
            detail: 'Nested Git repository excluded.',
          },
        ],
        incompleteDiffCounts: true,
        summary: {
          changedCount: 3,
          stagedCount: 1,
          unstagedCount: 2,
          untrackedCount: 1,
          conflictedCount: 1,
          additions: 3,
          deletions: 1,
        },
        files: [
          {
            path: 'src/app.ts',
            status: 'Modified',
            indexStatus: 'Modified',
            workTreeStatus: 'Modified',
            staged: true,
            unstaged: true,
            hasStagedAndUnstaged: true,
            stagedNetZeroWorking: false,
            kind: 'Regular',
            additions: 3,
            deletions: 1,
            unstable: true,
          },
          {
            path: 'assets/logo.png',
            status: 'Untracked',
            indexStatus: 'Untracked',
            workTreeStatus: 'Untracked',
            staged: false,
            unstaged: true,
            hasStagedAndUnstaged: false,
            stagedNetZeroWorking: false,
            kind: 'Binary',
            additions: null,
            deletions: null,
          },
          {
            path: 'conflict.txt',
            status: 'Conflicted',
            indexStatus: 'Conflicted',
            workTreeStatus: 'Conflicted',
            staged: false,
            unstaged: false,
            hasStagedAndUnstaged: false,
            stagedNetZeroWorking: false,
            kind: 'Regular',
            additions: null,
            deletions: null,
          },
        ],
      },
    };

    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeLayer({
            status: () => Effect.succeed(snapshotWithEdgeCases),
            diff: (filePath, scope) => {
              diffCalls.push({ path: filePath, ...(scope === undefined ? {} : { scope }) });
              if (filePath === 'assets/logo.png') {
                return Effect.succeed({
                  _tag: 'Unavailable',
                  path: filePath,
                  scope: scope ?? 'combined',
                  reason: 'Binary',
                  detail: 'Binary file cannot be rendered as inline text diff.',
                  unstable: false,
                });
              }
              return Effect.succeed({
                _tag: 'Patch',
                path: filePath,
                scope: scope ?? 'combined',
                hunks: [
                  {
                    header: '@@ -1,1 +1,3 @@',
                    oldStart: 1,
                    oldLines: 1,
                    newStart: 1,
                    newLines: 3,
                    lines: [
                      { kind: 'context', oldLine: 1, newLine: 1, text: 'const x = 1;' },
                      {
                        kind: 'add',
                        newLine: 2,
                        text:
                          scope === 'staged'
                            ? 'const stagedOnly = true;'
                            : 'const combined = true;',
                      },
                    ],
                  },
                ],
                additions: 1,
                deletions: 0,
                truncated: false,
                unstable: true,
                instabilityDetail: 'File changed on disk during diff capture.',
              });
            },
          }),
        },
      ],
    });
    const fixture = TestBed.createComponent(InspectorPanel);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    await flush(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="changes-integration-banner"]')?.textContent).toContain(
      'Merge',
    );
    expect(el.querySelector('[data-testid="changes-unstable-banner"]')?.textContent).toContain(
      'src/app.ts',
    );
    expect(el.querySelector('[data-testid="changes-excluded-banner"]')?.textContent).toContain(
      'nested-repo',
    );
    expect(el.querySelector('[data-testid="changes-incomplete-banner"]')).not.toBeNull();

    // Expand staged+unstaged file -> combined default -> switch to staged
    const appToggle = query<HTMLButtonElement>(
      fixture,
      '[data-testid="change-row"][data-path="src/app.ts"] [data-testid="change-row-toggle"]',
    );
    appToggle.click();
    await flush(fixture);

    expect(diffCalls[0]).toEqual({ path: 'src/app.ts', scope: 'combined' });
    expect(el.querySelector('[data-testid="diff-unstable-banner"]')).not.toBeNull();
    expect(el.textContent).toContain('const combined = true;');

    const stagedScopeBtn = query<HTMLButtonElement>(fixture, '[data-testid="diff-scope-staged"]');
    stagedScopeBtn.click();
    await flush(fixture);
    expect(diffCalls[1]).toEqual({ path: 'src/app.ts', scope: 'staged' });
    expect(el.textContent).toContain('const stagedOnly = true;');

    // Expand binary file -> Unavailable disclosure without saying "no changes"
    const binToggle = query<HTMLButtonElement>(
      fixture,
      '[data-testid="change-row"][data-path="assets/logo.png"] [data-testid="change-row-toggle"]',
    );
    binToggle.click();
    await flush(fixture);
    expect(el.querySelector('[data-testid="diff-unavailable"]')?.textContent).toContain('Binary');
  });

  it('discloses WorktreeMissing, MissingGit, NonGit, Detached, Unborn, and status error + Retry accurately', async () => {
    let failFirstStatus = true;
    let currentState: CurrentChangesSnapshot['state'] = {
      _tag: 'MissingGit',
      detail: 'Git binary was not found on PATH.',
    };

    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeLayer({
            status: () => {
              if (failFirstStatus) {
                failFirstStatus = false;
                return Effect.fail(
                  new SourceControlError({ reason: 'WorkerFailed', detail: 'Worker crashed' }),
                );
              }
              return Effect.succeed({
                sessionId,
                cwd: 'C:/repo/wt',
                inspectedAt: Date.now(),
                state: currentState,
              });
            },
          }),
        },
      ],
    });
    const fixture = TestBed.createComponent(InspectorPanel);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    await flush(fixture);

    // Failed initial status shows error + working Retry
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="changes-error"]'),
    ).not.toBeNull();
    query<HTMLButtonElement>(fixture, '[data-testid="changes-retry"]').click();
    await flush(fixture);

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="changes-missing-git"]'),
    ).not.toBeNull();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="changes-empty"]'),
    ).toBeNull();

    const refresh = async (next: CurrentChangesSnapshot['state']) => {
      currentState = next;
      await fixture.componentInstance.refresh();
      await flush(fixture);
    };

    await refresh({
      _tag: 'WorktreeMissing',
      reason: 'ReplacedFolder',
      detail: 'Bound Worktree directory was replaced by another repository.',
      expectedPath: 'C:/repo/wt',
      lastKnownBranch: 'feat/old',
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="changes-worktree-missing"]',
      )?.textContent,
    ).toContain('feat/old');

    await refresh({
      _tag: 'NonGit',
      path: 'C:/plain',
      detail: 'Folder is not a Git repository.',
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="changes-non-git"]'),
    ).not.toBeNull();

    await refresh({
      _tag: 'Available',
      gitVersion: '2.47.0',
      toplevelPath: 'C:/repo/wt',
      head: { _tag: 'Detached', commit: 'deadbeef12345678' },
      integration: 'None',
      hasConflicts: false,
      unstablePaths: [],
      excludedEntries: [],
      incompleteDiffCounts: false,
      summary: {
        changedCount: 0,
        stagedCount: 0,
        unstagedCount: 0,
        untrackedCount: 0,
        conflictedCount: 0,
        additions: 0,
        deletions: 0,
      },
      files: [],
    });
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="changes-head-detached"]')
        ?.textContent,
    ).toContain('deadbee');
  });

  it('browses secondary Git commit history via menu, paginates, inspects commit files, and separates commits from current changes', async () => {
    const commitCalls: number[] = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeLayer({
            commits: (_limit, offset = 0) => {
              commitCalls.push(offset);
              if (offset === 0) {
                return Effect.succeed({
                  _tag: 'History',
                  sessionId,
                  cwd: 'C:/repo',
                  head: {
                    _tag: 'Branch',
                    branch: 'main',
                    ref: 'refs/heads/main',
                    commit: 'aaaa1111',
                  },
                  commits: [
                    {
                      sha: 'aaaa1111aaaa1111',
                      shortSha: 'aaaa111',
                      parentShas: ['bbbb2222bbbb2222', 'cccc3333cccc3333'],
                      isMerge: true,
                      subject: 'Merge feature branch',
                      body: '',
                      authorName: 'Ada Lovelace',
                      authorEmail: 'ada@example.com',
                      authoredAtSeconds: 1_700_000_000,
                      refs: ['HEAD -> main'],
                    },
                  ],
                  hasMore: true,
                  nextOffset: 1,
                });
              }
              return Effect.succeed({
                _tag: 'History',
                sessionId,
                cwd: 'C:/repo',
                head: {
                  _tag: 'Branch',
                  branch: 'main',
                  ref: 'refs/heads/main',
                  commit: 'aaaa1111',
                },
                commits: [
                  {
                    sha: 'bbbb2222bbbb2222',
                    shortSha: 'bbbb222',
                    parentShas: [],
                    isMerge: false,
                    subject: 'Initial root commit',
                    body: '',
                    authorName: 'Ada Lovelace',
                    authorEmail: 'ada@example.com',
                    authoredAtSeconds: 1_699_990_000,
                    refs: [],
                  },
                ],
                hasMore: false,
              });
            },
            commitDetail: (sha) =>
              Effect.succeed({
                sessionId,
                cwd: 'C:/repo',
                commit: {
                  sha,
                  shortSha: sha.slice(0, 7),
                  parentShas: ['bbbb2222bbbb2222', 'cccc3333cccc3333'],
                  isMerge: true,
                  subject: 'Merge feature branch',
                  body: 'Detailed merge body',
                  authorName: 'Ada Lovelace',
                  authorEmail: 'ada@example.com',
                  authoredAtSeconds: 1_700_000_000,
                  refs: ['HEAD -> main'],
                },
                files: [
                  {
                    path: 'src/merged.ts',
                    status: 'Added',
                    additions: 10,
                    deletions: 0,
                    binary: false,
                  },
                ],
                truncatedFiles: false,
              }),
            commitFileDiff: (_sha, filePath) =>
              Effect.succeed({
                _tag: 'Patch',
                path: filePath,
                scope: 'combined',
                hunks: [
                  {
                    header: '@@ -0,0 +1,1 @@',
                    oldStart: 0,
                    oldLines: 0,
                    newStart: 1,
                    newLines: 1,
                    lines: [{ kind: 'add', newLine: 1, text: 'export const merged = true;' }],
                  },
                ],
                additions: 1,
                deletions: 0,
                truncated: false,
                unstable: false,
              }),
          }),
        },
      ],
    });

    const fixture = TestBed.createComponent(InspectorPanel);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
    await flush(fixture);

    // Open contextual menu and switch to Git history
    query<HTMLButtonElement>(fixture, '[data-testid="inspector-menu-trigger"]').click();
    fixture.detectChanges();
    const historyMenuBtn = document.querySelector<HTMLButtonElement>(
      '[data-testid="inspector-menu-history"]',
    );
    expect(historyMenuBtn).not.toBeNull();
    historyMenuBtn?.click();
    await flush(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(commitCalls).toEqual([0]);
    expect(el.textContent).toContain('Git history');
    expect(el.textContent).toContain('Merge feature branch');

    // Paginate
    query<HTMLButtonElement>(fixture, '[data-testid="history-load-more"]').click();
    await flush(fixture);
    expect(commitCalls).toEqual([0, 1]);
    expect(el.textContent).toContain('Initial root commit');

    // Select commit -> commit detail -> file diff
    query<HTMLButtonElement>(
      fixture,
      '[data-testid="commit-row"][data-sha="aaaa1111aaaa1111"]',
    ).click();
    await flush(fixture);
    expect(el.querySelector('[data-testid="commit-detail-panel"]')?.textContent).toContain(
      'Detailed merge body',
    );

    query<HTMLButtonElement>(fixture, '[data-testid="commit-file-row"]').click();
    await flush(fixture);
    expect(el.textContent).toContain('export const merged = true;');

    // Back to current changes restores current changes view
    query<HTMLButtonElement>(fixture, '[data-testid="inspector-back-to-changes"]').click();
    await flush(fixture);
    expect(el.querySelector('[data-testid="change-row"]')).not.toBeNull();
  });
});
