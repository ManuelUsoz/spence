import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionList } from './session-list';

describe('SessionList', () => {
  it('shows monochrome explanatory status icons for blocked, error, and working, and none for idle', () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', [
      {
        label: 'Needs you',
        items: [
          {
            id: SessionId.make('s1'),
            title: 'Needs answer',
            age: '5h',
            reason: 'Waiting for your answer',
            active: false,
            archived: false,
            selected: false,
            status: 'blocked',
          },
          {
            id: SessionId.make('s2'),
            title: 'Errored',
            age: '5h',
            reason: 'Stopped with an error',
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
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="status-blocked"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="status-error"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="status-working"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="session-age"]')).toHaveLength(1);
    const meta = el.querySelectorAll('[data-testid="session-meta"]');
    expect(meta).toHaveLength(2);
    for (const m of Array.from(meta)) {
      expect(m.className).not.toContain('var(--attention)');
      expect(m.className).not.toContain('text-destructive');
    }
    for (const testid of ['status-blocked', 'status-error', 'status-working']) {
      const icon = el.querySelector(`[data-testid="${testid}"]`);
      expect(icon?.getAttribute('class') ?? '').not.toContain('var(--attention)');
      expect(icon?.getAttribute('class') ?? '').not.toContain('text-destructive');
    }
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
});
