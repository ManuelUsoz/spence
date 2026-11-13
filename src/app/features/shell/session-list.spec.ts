import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { SessionList } from './session-list';

describe('SessionList', () => {
  it('shows the cause when a Session needs attention', () => {
    const fixture = TestBed.createComponent(SessionList);
    fixture.componentRef.setInput('groups', [{ label: 'Needs you', items: [{
      id: SessionId.make('session'), title: 'A Session', meta: 'active', active: false,
      attention: 'needsAnswer',
    }] }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="attention-needsAnswer"]')).not.toBeNull();
  });
});
