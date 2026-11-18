import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import {
  WorktreesRpcs,
  type CreateWorktreeResult,
  type SelectWorktreeResult,
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

const primary = entry({ path: '/repo/app', branch: 'main', isPrimary: true, isCurrent: true });
const linked = entry({ path: '/repo/app.worktrees/feature-x', branch: 'feature/x' });

interface Served {
  entries: ReadonlyArray<WorktreeEntry>;
  /** What `Worktrees.select` answers. */
  select: SelectWorktreeResult;
  /** What `Worktrees.create` answers. */
  create: CreateWorktreeResult;
  selectAsks: string[];
  createAsks: string[];
  listAsks: number;
}

const make = (entries: ReadonlyArray<WorktreeEntry>): Served => ({
  entries,
  select: { _tag: 'Selected' },
  create: { _tag: 'Created', entry: linked },
  selectAsks: [],
  createAsks: [],
  listAsks: 0,
});

const serve = (served: Served) =>
  makeDesktopTestLayer(
    WorktreesRpcs.toLayer({
      'Worktrees.list': () => {
        served.listAsks += 1;
        const result: WorktreesResult = { _tag: 'Available', entries: served.entries };
        return Effect.succeed(result);
      },
      'Worktrees.select': ({ path }) => {
        served.selectAsks.push(path);
        return Effect.succeed(served.select);
      },
      'Worktrees.create': ({ branch }) => {
        served.createAsks.push(branch);
        return Effect.succeed(served.create);
      },
    }),
  );

const settle = async (fixture: ComponentFixture<WorktreeBar>): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
  }
};

const open = async (
  served: Served,
  draft: boolean,
): Promise<{ fixture: ComponentFixture<WorktreeBar>; moved: () => number }> => {
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: serve(served) }],
  });
  const fixture = TestBed.createComponent(WorktreeBar);
  fixture.componentRef.setInput('sessionId', sessionId);
  fixture.componentRef.setInput('draft', draft);
  let moved = 0;
  fixture.componentInstance.moved.subscribe(() => (moved += 1));
  fixture.detectChanges();
  await settle(fixture);
  return { fixture, moved: () => moved };
};

const root = (fixture: ComponentFixture<WorktreeBar>): HTMLElement =>
  fixture.nativeElement as HTMLElement;
const byId = <T extends HTMLElement>(
  fixture: ComponentFixture<WorktreeBar>,
  id: string,
): T | null => root(fixture).querySelector<T>(`[data-testid="${id}"]`);

afterEach(() => TestBed.resetTestingModule());

describe('WorktreeBar', () => {
  it('only shows the Worktree of a Session that already ran a Turn', async () => {
    const { fixture } = await open(make([primary, linked]), false);

    expect(byId(fixture, 'worktree-current')?.textContent).toContain('main · app');
    expect(byId(fixture, 'worktree-select')).toBeNull();
    expect(byId(fixture, 'worktree-new')).toBeNull();
  });

  it('shows nothing when the folder has no Worktrees to list', async () => {
    const served = make([]);
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(
            WorktreesRpcs.toLayer({
              'Worktrees.list': () =>
                Effect.succeed<WorktreesResult>({
                  _tag: 'Unavailable',
                  reason: 'NonGit',
                  detail: 'not a repository',
                }),
              'Worktrees.select': () => Effect.succeed(served.select),
              'Worktrees.create': () => Effect.succeed(served.create),
            }),
          ),
        },
      ],
    });
    const fixture = TestBed.createComponent(WorktreeBar);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.detectChanges();
    await settle(fixture);

    expect(byId(fixture, 'worktree-bar')).toBeNull();
  });

  it('moves a draft Session to the Worktree chosen in the list and tells the page', async () => {
    const served = make([primary, linked]);
    const { fixture, moved } = await open(served, true);
    const select = byId(fixture, 'worktree-select')!.querySelector('select')!;
    expect(Array.from(select.options).map((option) => option.textContent?.trim())).toEqual([
      'main · app',
      'feature/x · feature-x',
    ]);

    select.value = linked.path;
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(served.selectAsks).toEqual([linked.path]);
    expect(moved()).toBe(1);
  });

  it('says why a Session that already has messages stays where it is', async () => {
    const served = make([primary, linked]);
    served.select = { _tag: 'Rejected', reason: 'Busy', detail: 'A Turn already ran.' };
    const { fixture, moved } = await open(served, true);
    const select = byId(fixture, 'worktree-select')!.querySelector('select')!;

    select.value = linked.path;
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    expect(byId(fixture, 'worktree-message')?.textContent).toContain('already has messages');
    expect(moved()).toBe(0);
  });

  it('creates a Worktree on a new branch and moves the draft Session into it', async () => {
    const served = make([primary]);
    const { fixture, moved } = await open(served, true);
    byId<HTMLButtonElement>(fixture, 'worktree-new')!.click();
    await settle(fixture);
    const input = byId<HTMLInputElement>(fixture, 'worktree-branch')!;
    input.value = '  feature/x ';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);

    root(fixture)
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);

    expect(served.createAsks).toEqual(['feature/x']);
    expect(served.selectAsks).toEqual([linked.path]);
    expect(moved()).toBe(1);
    expect(byId(fixture, 'worktree-branch')).toBeNull();
  });

  it('keeps the form and explains a branch name that is taken', async () => {
    const served = make([primary]);
    served.create = { _tag: 'Rejected', reason: 'BranchExists', detail: 'taken' };
    const { fixture } = await open(served, true);
    byId<HTMLButtonElement>(fixture, 'worktree-new')!.click();
    await settle(fixture);
    const input = byId<HTMLInputElement>(fixture, 'worktree-branch')!;
    input.value = 'main';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);

    root(fixture)
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);

    expect(byId(fixture, 'worktree-message')?.textContent).toContain('already exists');
    expect(served.selectAsks).toEqual([]);
    expect(byId(fixture, 'worktree-branch')).not.toBeNull();
  });
});
