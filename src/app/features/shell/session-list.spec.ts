import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionList } from './session-list';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SessionList', () => {
  it('shows the cause when a Session needs attention, or a static running mark', () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', [
      {
        label: 'Needs you',
        items: [
          {
            id: SessionId.make('s1'),
            title: 'Needs answer',
            age: '5h',
            reason: 'Waiting',
            active: false,
            attention: 'needsAnswer',
            running: true,
          },
          {
            id: SessionId.make('s2'),
            title: 'Errored',
            age: '5h',
            reason: 'Error',
            active: false,
            attention: 'error',
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
            running: true,
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const needsAnswerMark = el.querySelector('[data-testid="attention-needsAnswer"]');
    const errorMark = el.querySelector('[data-testid="attention-error"]');
    const runningMark = el.querySelector('[data-testid="session-running"]');
    expect(needsAnswerMark?.getAttribute('class')).toContain('text-[var(--attention)]');
    expect(errorMark?.getAttribute('class')).toContain('text-[var(--destructive)]');
    expect(runningMark?.getAttribute('class')).toContain('text-[var(--working)]');
    expect(runningMark?.getAttribute('class')).not.toContain('text-muted-foreground');
    expect(
      [...el.querySelectorAll('[data-testid="session-meta"]')].map((n) => n.textContent?.trim()),
    ).toEqual(['Waiting', 'Error']);
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
            reason: 'Waiting',
            active: false,
            attention: 'needsAnswer',
            running: true,
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
            reason: 'Error',
            active: false,
            attention: 'error',
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
            running: true,
            activity: { kind: 'execute', target: 'npm test', startedAt: baseNow - 14_000 },
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    // Working session row has no running-command prose line (no session-meta on s3).
    expect(el.querySelectorAll('[data-testid="session-meta"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="session-row"]')[2]?.textContent).not.toContain(
      'npm test',
    );

    const rows = el.querySelectorAll<HTMLElement>('[data-testid="session-row"]');
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
