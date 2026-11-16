import { TestBed } from '@angular/core/testing';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ComparisonId } from '../../../shared/history/comparison';
import { HistoryError, HistoryRpcs } from '../../../shared/history/history.rpc';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { WorktreeId } from '../../../shared/worktrees/worktrees.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SessionInspector } from './session-inspector';

describe('SessionInspector comparisons', () => {
  it('ignores an earlier response after switching session and worktree', async () => {
    const firstSession = SessionId.make('first');
    const firstWorktree = WorktreeId.make('first');
    const secondSession = SessionId.make('second');
    const secondWorktree = WorktreeId.make('second');
    const comparison = (sessionId: SessionId, worktreeId: WorktreeId, detail: string) => ({
      id: ComparisonId.make(detail),
      sessionId,
      worktreeId,
      recordedAt: 1,
      before: { status: 'Missing' as const, detail },
      after: { status: 'Missing' as const, detail },
    });
    const pending: Array<(value: readonly ReturnType<typeof comparison>[]) => void> = [];
    const list = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<readonly ReturnType<typeof comparison>[]>((resolve) => pending.push(resolve)),
      ),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(HistoryRpcs.toLayer({ 'History.list': list })),
        },
      ],
    });
    const fixture = TestBed.createComponent(SessionInspector);
    fixture.componentRef.setInput('sessionId', firstSession);
    fixture.componentRef.setInput('target', {
      projectId: ProjectId.make('project'),
      worktreeId: firstWorktree,
    });
    fixture.componentRef.setInput('initialTab', 'comparisons');
    fixture.detectChanges();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    fixture.componentRef.setInput('sessionId', secondSession);
    fixture.componentRef.setInput('target', {
      projectId: ProjectId.make('project'),
      worktreeId: secondWorktree,
    });
    fixture.detectChanges();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.([comparison(secondSession, secondWorktree, 'Current result')]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Current result');
    });
    pending[0]?.([comparison(firstSession, firstWorktree, 'Stale result')]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Current result');
    expect(fixture.nativeElement.textContent).not.toContain('Stale result');
    expect(list).toHaveBeenLastCalledWith(
      { sessionId: secondSession, worktreeId: secondWorktree },
      expect.anything(),
    );
  });
  it('shows a failed load and does not load a missing worktree', async () => {
    const list = vi.fn(() =>
      Effect.fail(new HistoryError({ reason: 'StoreError', detail: 'failed' })),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(HistoryRpcs.toLayer({ 'History.list': list })),
        },
      ],
    });
    const fixture = TestBed.createComponent(SessionInspector);
    fixture.componentRef.setInput('sessionId', SessionId.make('session'));
    fixture.componentRef.setInput('target', {
      projectId: ProjectId.make('project'),
      worktreeId: WorktreeId.make('worktree'),
    });
    fixture.componentRef.setInput('initialTab', 'comparisons');
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Could not load comparisons.');
    });
    fixture.componentRef.setInput('worktreeMissing', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Comparisons require a worktree.');
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('loads the selected worktree and shows incomplete endpoints', async () => {
    const sessionId = SessionId.make('session');
    const worktreeId = WorktreeId.make('worktree');
    const list = vi.fn((_payload: { sessionId: SessionId; worktreeId: WorktreeId }) =>
      Effect.succeed([
        {
          id: ComparisonId.make('comparison'),
          sessionId,
          worktreeId,
          recordedAt: 1,
          before: { status: 'Missing' as const, detail: 'Not captured' },
          after: { status: 'Incomplete' as const, detail: 'Capture interrupted' },
        },
      ]),
    );
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(HistoryRpcs.toLayer({ 'History.list': list })),
        },
      ],
    });
    const fixture = TestBed.createComponent(SessionInspector);
    fixture.componentRef.setInput('sessionId', sessionId);
    fixture.componentRef.setInput('target', { projectId: ProjectId.make('project'), worktreeId });
    fixture.componentRef.setInput('initialTab', 'comparisons');
    fixture.detectChanges();
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain('Not captured');
      expect(fixture.nativeElement.textContent).toContain('Capture interrupted');
    });
    expect(list.mock.calls[0]?.[0]).toEqual({ sessionId, worktreeId });
  });
});
