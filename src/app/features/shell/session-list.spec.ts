import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionList } from './session-list';

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
            meta: 'active',
            active: false,
            attention: 'needsAnswer',
            running: true,
          },
          {
            id: SessionId.make('s2'),
            title: 'Errored',
            meta: 'active',
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
            meta: 'active',
            active: false,
            running: true,
          },
        ],
      },
    ]);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="attention-needsAnswer"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="attention-error"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="session-running"]')).toHaveLength(1);
  });
});
