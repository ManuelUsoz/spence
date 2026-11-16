import { TestBed } from '@angular/core/testing';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ComparisonId } from '../../../shared/history/comparison';
import { HistoryRpcs } from '../../../shared/history/history.rpc';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { WorktreeId } from '../../../shared/worktrees/worktrees.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { SessionInspector } from './session-inspector';

describe('SessionInspector comparisons', () => {
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
