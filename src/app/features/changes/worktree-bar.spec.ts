import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import {
  WorktreesRpcs,
  type WorktreeEntry,
  type WorktreesResult,
} from '../../../shared/worktrees/worktrees.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { WorktreeBar } from './worktree-bar';

const sessionId = SessionId.make('session-1');

const entry = (over: Partial<WorktreeEntry> & Pick<WorktreeEntry, 'path'>): WorktreeEntry => ({
  folderName: over.path.split('/').pop() ?? over.path,
  branch: 'main',
  detached: false,
  isPrimary: false,
  isCurrent: false,
  missing: false,
  locked: false,
  ...over,
});

const serve = (result: WorktreesResult) =>
  makeDesktopTestLayer(
    WorktreesRpcs.toLayer({
      'Worktrees.list': () => Effect.succeed(result),
      'Worktrees.prepareDraft': () => Effect.die('not served'),
    }),
  );

const open = async (result: WorktreesResult): Promise<ComponentFixture<WorktreeBar>> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(result) }],
  });
  const fixture = TestBed.createComponent(WorktreeBar);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.detectChanges();
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
  return fixture;
};

const byId = (fixture: ComponentFixture<WorktreeBar>, id: string): HTMLElement | null =>
  (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(`[data-testid="${id}"]`);

afterEach(() => TestBed.resetTestingModule());

describe('WorktreeBar', () => {
  it('shows the Worktree the Session works in, with its branch', async () => {
    const fixture = await open({
      _tag: 'Available',
      canSelect: false,
      entries: [
        entry({ path: '/repo/app', isPrimary: true }),
        entry({ path: '/repo/app.worktrees/side', branch: 'wt/side', isCurrent: true }),
      ],
    });

    expect(byId(fixture, 'worktree-current')?.textContent).toContain('wt/side · side');
  });

  it('shows nothing when the folder has no Worktrees to list', async () => {
    const fixture = await open({
      _tag: 'Unavailable',
      reason: 'NonGit',
      detail: 'not a repository',
    });

    expect(byId(fixture, 'worktree-bar')).toBeNull();
  });
});
