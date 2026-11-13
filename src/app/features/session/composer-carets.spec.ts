import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { ComposerCarets } from './composer-carets';

describe('ComposerCarets', () => {
  it('stores, consumes once, and clears per-Session Composer caret positions', () => {
    const carets = TestBed.inject(ComposerCarets);
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');

    expect(carets.consume(s1)).toBeNull();

    carets.save(s1, { start: 4, end: 9 });
    expect(carets.consume(s1)).toEqual({ start: 4, end: 9 });
    expect(carets.consume(s1)).toBeNull();

    carets.save(s2, { start: 1, end: 1 });
    carets.clear(s2);
    expect(carets.consume(s2)).toBeNull();
  });
});
