import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import {
  SourceControlRpcs,
  type ChangedFile,
  type ChangesResult,
} from '../../../shared/source-control/source-control.rpc';
import { ChangesState } from '../../core/changes-view';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { ComposerStatus } from './composer-status';

const sessionId = SessionId.make('session-1');

const file = (path: string): ChangedFile => ({
  path,
  status: 'Modified',
  staged: false,
  unstaged: true,
  kind: 'Regular',
  additions: 1,
  deletions: 0,
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
}

const serve = (served: Served) =>
  makeDesktopTestLayer(
    SourceControlRpcs.toLayer({
      'SourceControl.changes': () => {
        served.asks += 1;
        return Effect.succeed(served.result);
      },
      'SourceControl.diff': () => Effect.die('not served'),
      'SourceControl.commits': () => Effect.die('not served'),
      'SourceControl.commit': () => Effect.die('not served'),
      'SourceControl.prepareDiscard': () => Effect.die('not served'),
      'SourceControl.discard': () => Effect.die('not served'),
      'SourceControl.revert': () => Effect.die('not served'),
      'SourceControl.fetch': () => Effect.die('not served'),
      'SourceControl.pull': () => Effect.die('not served'),
      'SourceControl.push': () => Effect.die('not served'),
    }),
  );

const settle = async (fixture: ComponentFixture<ComposerStatus>): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
};

const open = async (served: Served, running = false): Promise<ComponentFixture<ComposerStatus>> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
  });
  const fixture = TestBed.createComponent(ComposerStatus);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.componentRef.setInput('running', running);
  fixture.detectChanges();
  await settle(fixture);
  return fixture;
};

const text = (fixture: ComponentFixture<ComposerStatus>, testId: string): string =>
  (fixture.nativeElement as HTMLElement)
    .querySelector(`[data-testid="${testId}"]`)
    ?.textContent?.trim() ?? '';

afterEach(() => TestBed.resetTestingModule());

describe('ComposerStatus', () => {
  it('shows the branch and how many files changed', async () => {
    const fixture = await open({ result: available([file('a.ts'), file('b.ts')]), asks: 0 });

    expect(text(fixture, 'composer-status-branch')).toBe('feat/composer');
    expect(text(fixture, 'composer-status-changes')).toBe('2 changes');
  });

  it('says one change, or none, in words', async () => {
    const one = await open({ result: available([file('a.ts')]), asks: 0 });
    expect(text(one, 'composer-status-changes')).toBe('1 change');
    TestBed.resetTestingModule();

    const none = await open({ result: available([]), asks: 0 });
    expect(text(none, 'composer-status-changes')).toBe('No changes');
  });

  it('opens the Changes view when the count is pressed', async () => {
    const fixture = await open({ result: available([file('a.ts')]), asks: 0 });
    const state = TestBed.inject(ChangesState);
    expect(state.open()).toBe(false);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[data-testid="composer-status-changes"]')!
      .click();

    expect(state.open()).toBe(true);
  });

  it('shows nothing for a folder that is not a Git repository', async () => {
    const fixture = await open({
      result: { _tag: 'Unavailable', reason: 'NonGit', detail: 'not a repository' },
      asks: 0,
    });

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="composer-status"]'),
    ).toBeNull();
  });

  it('reads the folder again when a running Turn ends', async () => {
    const served: Served = { result: available([file('a.ts')]), asks: 0 };
    const fixture = await open(served, true);
    const before = served.asks;
    served.result = available([file('a.ts'), file('b.ts'), file('c.ts')]);

    fixture.componentRef.setInput('running', false);
    fixture.detectChanges();
    await settle(fixture);

    expect(served.asks).toBe(before + 1);
    expect(text(fixture, 'composer-status-changes')).toBe('3 changes');
  });
});
