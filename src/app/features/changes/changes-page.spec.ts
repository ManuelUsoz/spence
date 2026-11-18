import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import {
  SourceControlRpcs,
  type ChangedFile,
  type ChangesResult,
  type CommitsResult,
  type DiffResult,
} from '../../../shared/source-control/source-control.rpc';
import { WorktreesRpcs } from '../../../shared/worktrees/worktrees.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { ChangesPage } from './changes-page';

const sessionId = SessionId.make('session-1');

const available = (files: ReadonlyArray<ChangedFile>): ChangesResult => ({
  _tag: 'Available',
  head: { _tag: 'Branch', branch: 'feat/changes' },
  upstream: { name: 'origin/feat/changes', ahead: 2, behind: 0 },
  integration: 'None',
  files,
  excludedCount: 0,
});

const modified = {
  path: 'src/app/session-view.ts',
  status: 'Modified' as const,
  staged: false,
  unstaged: true,
  kind: 'Regular' as const,
  additions: 14,
  deletions: 9,
};
const added = {
  ...modified,
  path: 'src/app/new-file.ts',
  status: 'Added' as const,
  additions: 61,
  deletions: 0,
};

const patch: DiffResult = {
  _tag: 'Patch',
  additions: 1,
  deletions: 1,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'one' },
        { kind: 'delete', oldLine: 2, text: 'two' },
        { kind: 'add', newLine: 2, text: 'TWO' },
      ],
    },
  ],
};

const history: CommitsResult = {
  _tag: 'History',
  hasMore: false,
  commits: [
    {
      sha: 'a'.repeat(40),
      shortSha: 'aaaaaaa',
      subject: 'Add worktree selector',
      authorName: 'Manuel',
      authoredAtSeconds: 1,
      isMerge: false,
      refs: [],
    },
  ],
};

interface Served {
  /** What `SourceControl.changes` answers, per Session; `never` is a read that does not finish. */
  changes: ChangesResult | 'die' | 'never';
  changesBySession: Map<string, ChangesResult | 'never'>;
  /** Answers handed out first, in order, each after its delay: lets an older read finish last. */
  changesQueue: Array<{ delayMs: number; result: ChangesResult }>;
  diffs: Map<string, DiffResult>;
  /** The page of history starting at `offset`. */
  commits: (offset: number) => CommitsResult;
  diffAsks: string[];
  previousPathAsks: Array<string | undefined>;
  changesAsks: number;
}

const serve = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      WorktreesRpcs.toLayer({
        'Worktrees.list': () =>
          Effect.succeed({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not a repository' }),
        'Worktrees.create': () => Effect.die('not served'),
        'Worktrees.select': () => Effect.die('not served'),
      }),
      SourceControlRpcs.toLayer({
        'SourceControl.changes': ({ sessionId }) => {
          served.changesAsks += 1;
          const queued = served.changesQueue.shift();
          if (queued !== undefined) {
            return Effect.succeed(queued.result).pipe(Effect.delay(`${queued.delayMs} millis`));
          }
          const answer = served.changesBySession.get(sessionId) ?? served.changes;
          if (answer === 'die') return Effect.die('git exploded');
          if (answer === 'never') return Effect.never;
          return Effect.succeed(answer);
        },
        'SourceControl.diff': ({ path, previousPath }) => {
          served.diffAsks.push(path);
          served.previousPathAsks.push(previousPath);
          return Effect.succeed(served.diffs.get(path) ?? patch);
        },
        'SourceControl.commits': ({ offset }) => Effect.succeed(served.commits(offset)),
      }),
    ),
  );

const settle = async (fixture: ComponentFixture<ChangesPage>): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
};

const open = async (served: Served): Promise<ComponentFixture<ChangesPage>> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
  });
  const fixture = TestBed.createComponent(ChangesPage);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
};

const make = (changes: Served['changes']): Served => ({
  changes,
  changesBySession: new Map(),
  changesQueue: [],
  diffs: new Map(),
  commits: () => history,
  diffAsks: [],
  previousPathAsks: [],
  changesAsks: 0,
});

const text = (fixture: ComponentFixture<ChangesPage>, testId: string): string =>
  (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${testId}"]`)?.textContent ??
  '';

const cells = (element: Element): string[] =>
  Array.from(element.querySelectorAll('span')).map((span) => span.textContent?.trim() ?? '');

const rows = (fixture: ComponentFixture<ChangesPage>): HTMLElement[] =>
  Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="change-row"]'));

afterEach(() => TestBed.resetTestingModule());

describe('ChangesPage', () => {
  it('lists each changed file with its status and line counts, and the branch with what is unpushed', async () => {
    const fixture = await open(make(available([modified, added])));

    expect(rows(fixture).map(cells)).toEqual([
      ['M', 'src/app/session-view.ts', '+14', '−9'],
      ['A', 'src/app/new-file.ts', '+61', '−0'],
    ]);
    expect(text(fixture, 'changes-head')).toContain('feat/changes');
    expect(text(fixture, 'changes-head')).toContain('↑2');
    expect(text(fixture, 'changes-tab')).toContain('2');
  });

  it('shows a file diff only after its row is opened, and hides it when closed', async () => {
    const served = make(available([modified]));
    const fixture = await open(served);
    expect(served.diffAsks).toEqual([]);

    const button = rows(fixture)[0]!.querySelector('button')!;
    button.click();
    await settle(fixture);

    const lines = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="diff-line"]'),
    ).map((line) => line.textContent?.replace(/\s+/g, ' ').trim());
    expect(lines).toEqual(['1one', '2−two', '2+TWO']);
    expect(served.diffAsks).toEqual(['src/app/session-view.ts']);

    button.click();
    await settle(fixture);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="change-diff"]'),
    ).toBeNull();
  });

  it('says so when a file has no diff to show', async () => {
    const served = make(available([{ ...modified, kind: 'Binary' as const }]));
    served.diffs.set(modified.path, {
      _tag: 'NoPreview',
      reason: 'Binary',
      detail: 'Binary file; no text diff.',
    });
    const fixture = await open(served);

    rows(fixture)[0]!.querySelector('button')!.click();
    await settle(fixture);

    expect(text(fixture, 'diff-nopreview')).toContain('This file is binary');
  });

  it('asks for a renamed file diff with its old path, so git can pair the two', async () => {
    const served = make(
      available([
        { ...modified, path: 'src/new.ts', previousPath: 'src/old.ts', status: 'Renamed' },
      ]),
    );
    const fixture = await open(served);

    rows(fixture)[0]!.querySelector('button')!.click();
    await settle(fixture);

    expect(served.diffAsks).toEqual(['src/new.ts']);
    expect(served.previousPathAsks).toEqual(['src/old.ts']);
  });

  it('drops the previous Session from view while the next Session loads', async () => {
    const served = make(available([modified]));
    served.changesBySession.set('session-2', 'never');
    const fixture = await open(served);
    expect(rows(fixture)).toHaveLength(1);

    fixture.componentRef.setInput('sessionId', SessionId.make('session-2'));
    fixture.detectChanges();
    await settle(fixture);

    expect(rows(fixture)).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Loading');
  });

  it('keeps the newest read when an older one answers last', async () => {
    const served = make(available([modified]));
    const fixture = await open(served);
    served.changesQueue.push(
      { delayMs: 60, result: available([modified]) },
      { delayMs: 0, result: available([added]) },
    );

    fixture.componentRef.instance['refresh']();
    fixture.componentRef.instance['refresh']();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await settle(fixture);

    expect(rows(fixture).map(cells)).toEqual([['A', 'src/app/new-file.ts', '+61', '−0']]);
  });

  it('shows the next page of history when asked and hides the button at the end', async () => {
    const served = make(available([modified]));
    const commit = (n: number) => ({
      ...history.commits[0]!,
      sha: String(n).repeat(40),
      shortSha: `c${n}`,
      subject: `Commit ${n}`,
    });
    served.commits = (offset) => ({
      _tag: 'History',
      hasMore: offset === 0,
      commits: offset === 0 ? [commit(1), commit(2)] : [commit(3)],
    });
    const fixture = await open(served);
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="history-tab"]')!
      .click();
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('[data-testid="commit-row"]')).toHaveLength(2);

    root.querySelector<HTMLButtonElement>('[data-testid="history-more"]')!.click();
    await settle(fixture);

    expect(root.querySelectorAll('[data-testid="commit-row"]')).toHaveLength(3);
    expect(root.querySelector('[data-testid="history-more"]')).toBeNull();
  });

  it('tells a passing Git failure apart from an unsupported repository', async () => {
    const fixture = await open(
      make({ _tag: 'Unavailable', reason: 'GitFailed', detail: 'index.lock exists' }),
    );

    expect(text(fixture, 'changes-unavailable')).toContain('Try Refresh');
  });

  it('says there is nothing to commit for a clean folder', async () => {
    const fixture = await open(make(available([])));

    expect(text(fixture, 'changes-empty')).toContain('No changes');
    expect(rows(fixture)).toEqual([]);
  });

  it('explains a folder that is not a Git repository', async () => {
    const fixture = await open(
      make({ _tag: 'Unavailable', reason: 'NonGit', detail: 'not a repository' }),
    );

    expect(text(fixture, 'changes-unavailable')).toContain('not a Git repository');
  });

  it('reports a failed read instead of an empty list', async () => {
    const fixture = await open(make('die'));

    expect(text(fixture, 'changes-error')).toContain('Could not load changes');
    expect(rows(fixture)).toEqual([]);
  });

  it('switches to the history tab and lists commits', async () => {
    const fixture = await open(make(available([modified])));

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="history-tab"]')!
      .click();
    await settle(fixture);

    const commits = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('[data-testid="commit-row"]'),
    ).map(cells);
    expect(commits).toEqual([['aaaaaaa', 'Add worktree selector', 'Manuel']]);
  });

  it('reads the folder again when a running Turn ends', async () => {
    const served = make(available([modified]));
    TestBed.configureTestingModule({
      providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
    });
    const fixture = TestBed.createComponent(ChangesPage);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('running', true);
    fixture.detectChanges();
    await settle(fixture);
    const before = served.changesAsks;

    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
    await settle(fixture);

    expect(served.changesAsks).toBe(before + 1);
  });
});
