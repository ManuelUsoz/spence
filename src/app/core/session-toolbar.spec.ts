import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../shared/sessions/sessions.rpc';
import { SessionToolbar, type SessionToolbarEntry } from './session-toolbar';

const makeEntry = (
  sessionId: ReturnType<typeof signal<string>>,
  label: string,
): SessionToolbarEntry => ({
  sessionId,
  context: signal({ label, fraction: null }),
  actions: signal([]),
  run: () => undefined,
});

describe('SessionToolbar', () => {
  it('tracks independent entries per SessionId and resolves null for missing or null ids', () => {
    const toolbar = TestBed.inject(SessionToolbar);
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const s3 = SessionId.make('s3');

    const entry1 = makeEntry(signal<string>(s1), '10k of 200k');
    const entry2 = makeEntry(signal<string>(s2), '50k of 200k');

    const withdraw1 = toolbar.publish(entry1);
    const withdraw2 = toolbar.publish(entry2);

    expect(toolbar.entryFor(null)).toBeNull();
    expect(toolbar.entryFor(s3)).toBeNull();
    expect(toolbar.entryFor(s1)).toBe(entry1);
    expect(toolbar.entryFor(s2)).toBe(entry2);

    withdraw1();
    expect(toolbar.entryFor(s1)).toBeNull();
    expect(toolbar.entryFor(s2)).toBe(entry2);

    withdraw2();
    expect(toolbar.entryFor(s2)).toBeNull();
  });

  it('re-keys reactively when entry.sessionId() changes and preserves newer replacements on withdraw', () => {
    const toolbar = TestBed.inject(SessionToolbar);
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');

    const dynamicId = signal<string>(s1);
    const first = makeEntry(dynamicId, 'first');
    const readS1 = computed(() => toolbar.entryFor(s1)?.context().label ?? null);
    const readS2 = computed(() => toolbar.entryFor(s2)?.context().label ?? null);

    const withdrawFirst = toolbar.publish(first);
    expect(readS1()).toBe('first');
    expect(readS2()).toBeNull();

    dynamicId.set(s2);
    expect(readS1()).toBeNull();
    expect(readS2()).toBe('first');

    const replacement = makeEntry(signal<string>(s2), 'replacement');
    const withdrawReplacement = toolbar.publish(replacement);
    expect(readS2()).toBe('replacement');

    // Withdrawing the older entry must not remove the newer replacement for the same SessionId.
    withdrawFirst();
    expect(readS2()).toBe('replacement');

    withdrawReplacement();
    expect(readS2()).toBeNull();
  });
});
