import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionList } from './session-list';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SessionList', () => {
  it('shows color-coded status marks (with spinning working and gray idle) and removes sidebar status texts', () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', [
      {
        label: 'Needs you',
        items: [
          {
            id: SessionId.make('s1'),
            title: 'Needs answer',
            age: '5h',
            active: false,
            archived: false,
            selected: false,
            status: 'blocked',
          },
          {
            id: SessionId.make('s2'),
            title: 'Errored',
            age: '5h',
            active: false,
            archived: false,
            selected: false,
            status: 'error',
          },
        ],
      },
      {
        label: 'Today',
        items: [
          {
            id: SessionId.make('s3'),
            title: 'Working',
            age: '5h',
            active: false,
            archived: false,
            selected: false,
            status: 'working',
          },
          {
            id: SessionId.make('s4'),
            title: 'Idle',
            age: '1m',
            active: false,
            archived: false,
            selected: false,
            status: 'idle',
            workers: [
              {
                id: SessionId.make('w-idle'),
                ancestors: [SessionId.make('s4')],
                canOpenInSplit: false,
                title: 'Done worker',
                status: 'Idle',
                needsPermission: false,
                running: false,
                active: false,
                workers: [],
              },
              {
                id: SessionId.make('w-run'),
                ancestors: [SessionId.make('s4')],
                canOpenInSplit: true,
                title: 'Active worker',
                status: 'Working',
                needsPermission: false,
                running: true,
                active: false,
                workers: [],
              },
            ],
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const blockedMark = el.querySelector('[data-testid="status-blocked"]');
    const errorMark = el.querySelector('[data-testid="status-error"]');
    const workingMarks = el.querySelectorAll('[data-testid="status-working"]');
    const idleMarks = el.querySelectorAll('[data-testid="status-idle"]');
    expect(blockedMark?.getAttribute('class')).toContain('text-[var(--attention)]');
    expect(errorMark?.getAttribute('class')).toContain('text-[var(--destructive)]');
    expect(workingMarks).toHaveLength(2);
    for (const mark of workingMarks) {
      expect(mark.getAttribute('class')).toContain('text-[var(--working)]');
      expect(mark.getAttribute('class')).toContain('motion-safe:animate-spin');
    }
    expect(idleMarks).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('[data-testid="sidebar-workers-toggle"]')?.click();
    fixture.detectChanges();
    const expandedIdleMarks = el.querySelectorAll('[data-testid="status-idle"]');
    expect(expandedIdleMarks).toHaveLength(2);
    for (const mark of expandedIdleMarks) {
      expect(mark.getAttribute('class')).toContain('text-muted-foreground');
    }
    expect(el.querySelectorAll('[data-testid="session-age"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="session-meta"]')).toHaveLength(0);
    expect(el.querySelectorAll('[data-testid="sidebar-worker-status"]')).toHaveLength(0);
  });

  it('offers "Show N more" when the list is capped and reports the click', () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', []);
    fixture.componentRef.setInput('hiddenCount', 3);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = el.querySelector<HTMLButtonElement>('[data-testid="show-more"]');
    expect(button?.textContent?.trim()).toBe('Show 3 more');
    let shown = 0;
    fixture.componentInstance.showMore.subscribe(() => (shown += 1));
    button?.click();
    expect(shown).toBe(1);
  });

  it('shows hover tooltips on Session and Worker rows with full title, live micro-status, and local elapsed ticking', async () => {
    const hoverIn = (el: HTMLElement) => {
      el.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerenter', { pointerType: 'mouse' })
          : Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }),
      );
    };
    const hoverOut = (el: HTMLElement) => {
      el.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerleave', { pointerType: 'mouse' })
          : Object.assign(new Event('pointerleave'), { pointerType: 'mouse' }),
      );
    };
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const baseNow = 1_700_000_020_000;
    vi.setSystemTime(baseNow);

    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', [
      {
        label: 'Needs you',
        items: [
          {
            id: SessionId.make('s1'),
            title: 'Deploy production build',
            age: 'now',
            active: false,
            archived: false,
            selected: false,
            status: 'blocked',
            blockedTarget: 'git push',
            workers: [
              {
                id: SessionId.make('w1'),
                ancestors: [SessionId.make('s1')],
                canOpenInSplit: true,
                title: 'Run integration suite',
                status: 'Working',
                needsPermission: false,
                running: true,
                active: false,
                activity: { kind: 'thinking', target: '', startedAt: baseNow - 8_000 },
                workers: [],
              },
            ],
          },
          {
            id: SessionId.make('s2'),
            title: 'Broken migration',
            age: '1m',
            active: false,
            archived: false,
            selected: false,
            status: 'error',
            errorSummary: 'Agent exited with status 1',
          },
        ],
      },
      {
        label: 'Today',
        items: [
          {
            id: SessionId.make('s3'),
            title: 'Verify tests',
            age: 'now',
            active: false,
            archived: false,
            selected: false,
            status: 'working',
            activity: { kind: 'execute', target: 'npm test', startedAt: baseNow - 14_000 },
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // Sidebar rows show colored status marks without inline status prose lines.
    expect(el.querySelectorAll('[data-testid="session-meta"]')).toHaveLength(0);
    expect(el.querySelectorAll('[data-testid="session-row"]')[2]?.textContent).not.toContain(
      'npm test',
    );

    const rows = el.querySelectorAll<HTMLElement>('[data-testid="session-row"]');
    el.querySelector<HTMLButtonElement>('[data-testid="sidebar-workers-toggle"]')?.click();
    fixture.detectChanges();
    const workerRow = el.querySelector<HTMLElement>('[data-testid="sidebar-worker-row"]')!;

    // Hovering working Session row shows full title + running <target> · <elapsed> and ticks locally.
    hoverIn(rows[2]!);
    fixture.detectChanges();
    await vi.waitFor(() => {
      const tip = document.querySelector('[role="tooltip"]');
      expect(tip?.textContent).toContain('Verify tests');
      expect(tip?.textContent).toContain('running npm test · 14s');
    });

    vi.advanceTimersByTime(1000);
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
      'running npm test · 15s',
    );

    hoverOut(rows[2]!);
    fixture.detectChanges();

    // Hovering waiting Session row shows waiting for permission: <target>.
    hoverIn(rows[0]!);
    fixture.detectChanges();
    await vi.waitFor(() => {
      const tip = document.querySelector('[role="tooltip"]');
      expect(tip?.textContent).toContain('Deploy production build');
      expect(tip?.textContent).toContain('waiting for permission: git push');
    });
    hoverOut(rows[0]!);
    fixture.detectChanges();

    // Hovering errored Session row shows error summary.
    hoverIn(rows[1]!);
    fixture.detectChanges();
    await vi.waitFor(() => {
      const tip = document.querySelector('[role="tooltip"]');
      expect(tip?.textContent).toContain('Broken migration');
      expect(tip?.textContent).toContain('Agent exited with status 1');
    });
    hoverOut(rows[1]!);
    fixture.detectChanges();

    // Hovering nested Worker row shows full title + thinking · 9s (since 1s already elapsed).
    hoverIn(workerRow);
    fixture.detectChanges();
    await vi.waitFor(() => {
      const tip = document.querySelector('[role="tooltip"]');
      expect(tip?.textContent).toContain('Run integration suite');
      expect(tip?.textContent).toContain('thinking · 9s');
    });
  });
});
