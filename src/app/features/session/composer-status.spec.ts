import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import {
  SourceControlRpcs,
  type BranchEntry,
  type ChangedFile,
  type ChangesResult,
} from '../../../shared/source-control/source-control.rpc';
import {
  WorktreesRpcs,
  type PrepareDraftResult,
  type WorktreePrepEvent,
  type WorktreesResult,
} from '../../../shared/worktrees/worktrees.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { branchNameFor, ComposerStatus } from './composer-status';

// jsdom has no layout: Spartan's menu and list items call scrollIntoView when they highlight.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const sessionId = SessionId.make('session-1');

const file = (path: string, additions: number | null, deletions: number | null): ChangedFile => ({
  path,
  status: 'Modified',
  staged: false,
  unstaged: true,
  kind: 'Regular',
  additions,
  deletions,
});

const available = (files: ReadonlyArray<ChangedFile>, branch = 'feat/composer'): ChangesResult => ({
  _tag: 'Available',
  head: { _tag: 'Branch', branch },
  integration: 'None',
  files,
  excludedCount: 0,
  remotes: [],
});

interface Served {
  result: ChangesResult;
  asks: number;
  /** Whether the Session may still start in a new worktree (it has run no Turn). */
  canSelect: boolean;
  setupCommand: string | null;
  branches: ReadonlyArray<BranchEntry>;
  prepare: PrepareDraftResult;
  streamEvents?: ReadonlyArray<WorktreePrepEvent>;
  prepareAsks: Array<{
    branch: string;
    base: string | undefined;
    setupCommand: string | null | undefined;
  }>;
}

const make = (result: ChangesResult, canSelect = true): Served => ({
  result,
  asks: 0,
  canSelect,
  setupCommand: 'npm ci',
  branches: [
    { name: 'develop', current: false },
    { name: 'feat/composer', current: true },
    { name: 'main', current: false },
  ],
  prepare: {
    _tag: 'Prepared',
    entry: {
      path: '/repo/app.worktrees/wt-new',
      folderName: 'wt-new',
      branch: 'wt/new',
      detached: false,
      isPrimary: false,
      isCurrent: true,
      missing: false,
      locked: false,
    },
  },
  prepareAsks: [],
});

const serve = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      SourceControlRpcs.toLayer({
        'SourceControl.changes': () => {
          served.asks += 1;
          return Effect.succeed(served.result);
        },
        'SourceControl.branches': () =>
          Effect.succeed({ _tag: 'Available' as const, branches: served.branches }),
        'SourceControl.diff': () => Effect.die('not served'),
        'SourceControl.commits': () => Effect.die('not served'),
        'SourceControl.commit': () => Effect.die('not served'),
        'SourceControl.prepareDiscard': () => Effect.die('not served'),
        'SourceControl.discard': () => Effect.die('not served'),
        'SourceControl.revert': () => Effect.die('not served'),
        'SourceControl.commitDetail': () => Effect.die('not served'),
        'SourceControl.commitDiff': () => Effect.die('not served'),
        'SourceControl.fetch': () => Effect.die('not served'),
        'SourceControl.pull': () => Effect.die('not served'),
        'SourceControl.push': () => Effect.die('not served'),
      }),
      WorktreesRpcs.toLayer({
        'Worktrees.list': () =>
          Effect.succeed<WorktreesResult>({
            _tag: 'Available',
            entries: [],
            canSelect: served.canSelect,
            setupCommand: served.setupCommand,
          }),
        'Worktrees.prepareDraft': ({ branch, base }) => {
          served.prepareAsks.push({ branch, base, setupCommand: undefined });
          return Effect.succeed(served.prepare);
        },
        'Worktrees.prepareDraftStream': ({ branch, base, setupCommand }) => {
          served.prepareAsks.push({ branch, base, setupCommand });
          const events: ReadonlyArray<WorktreePrepEvent> = served.streamEvents ?? [
            {
              _tag: 'Step',
              step: {
                id: 'createWorktree',
                title: 'Create worktree',
                detail: branch,
                status: 'done',
              },
            },
            {
              _tag: 'Step',
              step:
                setupCommand === null
                  ? { id: 'setupProject', title: 'Prepare project', status: 'skipped' }
                  : {
                      id: 'setupProject',
                      title: 'Prepare project',
                      detail: setupCommand ?? undefined,
                      status: 'done',
                    },
            },
            {
              _tag: 'Step',
              step: { id: 'startSession', title: 'Start session in worktree', status: 'done' },
            },
            { _tag: 'Done', result: served.prepare },
          ];
          return Stream.fromIterable(events);
        },
      }),
    ),
  );

const settle = async (fixture: ComponentFixture<ComposerStatus>): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
};

const open = async (
  served: Served,
  options: { running?: boolean } = {},
): Promise<ComponentFixture<ComposerStatus>> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
  });
  const fixture = TestBed.createComponent(ComposerStatus);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.componentRef.setInput('running', options.running ?? false);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
};

const root = (fixture: ComponentFixture<ComposerStatus>): HTMLElement =>
  fixture.nativeElement as HTMLElement;

const text = (fixture: ComponentFixture<ComposerStatus>, testId: string): string =>
  root(fixture).querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';

const chooseMode = async (
  fixture: ComponentFixture<ComposerStatus>,
  mode: 'mode-current' | 'mode-new',
): Promise<void> => {
  root(fixture).querySelector<HTMLElement>('[data-testid="composer-status-branch"]')!.click();
  await settle(fixture);
  document.querySelector<HTMLElement>(`[data-testid="${mode}"]`)!.click();
  await settle(fixture);
};

const newWorktreeControls = (fixture: ComponentFixture<ComposerStatus>): Element | null =>
  root(fixture).querySelector('[data-testid="composer-status-new-worktree"]');

afterEach(() => TestBed.resetTestingModule());

describe('ComposerStatus', () => {
  it('shows the branch and the lines added and removed across the changed files', async () => {
    const fixture = await open(
      make(available([file('a.ts', 14, 9), file('b.ts', 61, 0), file('img.png', null, null)])),
    );

    expect(text(fixture, 'composer-status-branch')).toContain('feat/composer');
    expect(text(fixture, 'composer-status-added')).toBe('+75');
    expect(text(fixture, 'composer-status-removed')).toBe('−9');
    expect(
      root(fixture)
        .querySelector('[data-testid="composer-status-changes"]')!
        .getAttribute('aria-label'),
    ).toBe('Changes: 3 files, 75 added, 9 removed');
  });

  it('says there are no changes when the folder is clean', async () => {
    const fixture = await open(make(available([])));

    expect(text(fixture, 'composer-status-changes')).toBe('No changes');
  });

  it('opens the Changes view when the totals are pressed', async () => {
    const fixture = await open(make(available([file('a.ts', 1, 0)])));
    let opened = 0;
    const sub = fixture.componentInstance.openChanges.subscribe(() => {
      opened += 1;
    });

    root(fixture)
      .querySelector<HTMLButtonElement>('[data-testid="composer-status-changes"]')!
      .click();

    expect(opened).toBe(1);
    sub.unsubscribe();
  });

  it('shows nothing for a folder that is not a Git repository', async () => {
    const fixture = await open(
      make({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not a repository' }),
    );

    expect(root(fixture).querySelector('[data-testid="composer-status"]')).toBeNull();
  });

  it('reads the folder again when a running Turn ends', async () => {
    const served = make(available([file('a.ts', 1, 0)]));
    const fixture = await open(served, { running: true });
    const before = served.asks;
    served.result = available([file('a.ts', 1, 0), file('b.ts', 5, 2)]);

    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
    await settle(fixture);

    expect(served.asks).toBe(before + 1);
    expect(text(fixture, 'composer-status-added')).toBe('+6');
  });
});

describe('ComposerStatus checkout choice', () => {
  it('offers the current checkout or a new worktree before the first message', async () => {
    const fixture = await open(make(available([])));

    root(fixture).querySelector<HTMLElement>('[data-testid="composer-status-branch"]')!.click();
    await settle(fixture);

    expect(document.querySelector('[data-testid="mode-current"]')?.textContent).toContain(
      'feat/composer',
    );
    expect(document.querySelector('[data-testid="mode-new"]')).not.toBeNull();
  });

  it('only shows the checkout, with no menu, once the Session has messages', async () => {
    const fixture = await open(make(available([]), false));

    const chip = root(fixture).querySelector<HTMLElement>(
      '[data-testid="composer-status-branch"]',
    )!;
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toContain('feat/composer');
    expect(newWorktreeControls(fixture)).toBeNull();
  });

  it('asks nothing of the user while the current checkout is chosen', async () => {
    const served = make(available([]));
    const fixture = await open(served);

    expect(await fixture.componentInstance.prepare('hello')).toBe(true);
    expect(served.prepareAsks).toEqual([]);
  });
});

describe('ComposerStatus new worktree', () => {
  it('shows the branch to start from and a name field for the new branch', async () => {
    const fixture = await open(make(available([])));

    await chooseMode(fixture, 'mode-new');

    expect(text(fixture, 'composer-status-branch')).toBe('New worktree');
    const name = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="composer-status-worktree-name"]',
    )!;
    expect(name.value).toBe('');
    expect(name.placeholder).toBe('wt/new-work');
    const from = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="composer-status-from"] input',
    )!;
    expect(from.value).toBe('feat/composer');
    const setup = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="composer-status-setup-command"]',
    )!;
    expect(setup.value).toBe('npm ci');
  });

  it('creates the worktree from the chosen base, named after the message, when it is sent', async () => {
    const served = make(available([]));
    const fixture = await open(served);
    await chooseMode(fixture, 'mode-new');

    const ready = await fixture.componentInstance.prepare('Add a worktree selector');

    expect(ready).toBe(true);
    expect(served.prepareAsks).toEqual([
      {
        branch: 'wt/add-a-worktree-selector',
        base: 'feat/composer',
        setupCommand: 'npm ci',
      },
    ]);
  });

  it('lets the user override or clear the setup command and surfaces setup failure output', async () => {
    const served = make(available([]));
    served.streamEvents = [
      {
        _tag: 'Step',
        step: { id: 'createWorktree', title: 'Create worktree', status: 'done' },
      },
      {
        _tag: 'Step',
        step: {
          id: 'setupProject',
          title: 'Prepare project',
          detail: 'pnpm install',
          status: 'failed',
          output: 'ERR_PNPM_LOCKFILE_MISSING',
        },
      },
      {
        _tag: 'Step',
        step: { id: 'startSession', title: 'Start session in worktree', status: 'done' },
      },
      { _tag: 'Done', result: served.prepare },
    ];
    const fixture = await open(served);
    await chooseMode(fixture, 'mode-new');
    const setup = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="composer-status-setup-command"]',
    )!;
    setup.value = 'pnpm install';
    setup.dispatchEvent(new Event('input'));
    await settle(fixture);

    const ready = await fixture.componentInstance.prepare('Test setup failure');
    fixture.detectChanges();

    expect(ready).toBe(true);
    expect(served.prepareAsks[0]?.setupCommand).toBe('pnpm install');
    const stepsEl = root(fixture).querySelector('[data-testid="worktree-prep-steps"]');
    expect(stepsEl?.textContent).toContain('Prepare project');
    expect(stepsEl?.textContent).toContain('Failed');
  });

  it('uses the name the user typed instead of the one made from the message', async () => {
    const served = make(available([]));
    const fixture = await open(served);
    await chooseMode(fixture, 'mode-new');
    const name = root(fixture).querySelector<HTMLInputElement>(
      '[data-testid="composer-status-worktree-name"]',
    )!;
    name.value = 'wt/my-name';
    name.dispatchEvent(new Event('input'));
    await settle(fixture);

    await fixture.componentInstance.prepare('Something else entirely');

    expect(served.prepareAsks[0]?.branch).toBe('wt/my-name');
  });

  it('stops the message and says why when the worktree cannot be made', async () => {
    const served = make(available([]));
    served.prepare = { _tag: 'Rejected', reason: 'BranchExists', detail: 'taken' };
    const fixture = await open(served);
    await chooseMode(fixture, 'mode-new');

    const ready = await fixture.componentInstance.prepare('Taken name');
    fixture.detectChanges();

    expect(ready).toBe(false);
    expect(text(fixture, 'composer-status-message')).toContain('already exists');
    expect(newWorktreeControls(fixture)).not.toBeNull();
  });

  it('shows the new checkout, with no choice left, after the worktree is made', async () => {
    const served = make(available([]));
    const fixture = await open(served);
    await chooseMode(fixture, 'mode-new');
    served.canSelect = false;
    served.result = available([], 'wt/new');

    await fixture.componentInstance.prepare('Go');
    await settle(fixture);

    expect(text(fixture, 'composer-status-branch')).toContain('wt/new');
    expect(newWorktreeControls(fixture)).toBeNull();
  });
});

describe('branchNameFor', () => {
  it('turns the first line of a text into a short branch name, with a fallback', () => {
    expect(branchNameFor('Fix the flaky e2e baselines!\nand more')).toBe(
      'wt/fix-the-flaky-e2e-baselines',
    );
    expect(branchNameFor('a'.repeat(80))).toBe(`wt/${'a'.repeat(44)}`);
    expect(branchNameFor('  ')).toBe('wt/new-work');
    expect(branchNameFor(null)).toBe('wt/new-work');
  });
});
