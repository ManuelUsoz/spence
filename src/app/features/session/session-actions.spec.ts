import { describe, expect, it } from 'vitest';
import { contextSummary, sessionActions, type SessionActionsInput } from './session-actions';

const idle: SessionActionsInput = {
  running: false,
  compacting: false,
  clearing: false,
  agentStatus: 'ready',
  supportsCompaction: true,
  agentName: 'Claude',
};

const byId = (input: SessionActionsInput) =>
  Object.fromEntries(sessionActions(input).map((action) => [action.id, action]));

describe('sessionActions', () => {
  it('offers compact, clear, coordinate and switch, never fork, all enabled for an idle ready Session', () => {
    const actions = sessionActions(idle);
    expect(actions.map((action) => action.id)).toEqual([
      'compact',
      'clear',
      'coordinate',
      'divide-and-conquer',
      'switch-agent',
    ]);
    expect(actions.every((action) => !action.disabled)).toBe(true);
    expect(actions.map((action) => action.command)).toEqual([
      '/compact',
      '/clear',
      '/coordinate',
      '/divide-and-conquer',
      undefined,
    ]);
  });

  it('disables everything with the reason while a Turn runs, compaction runs or the context clears', () => {
    for (const busy of [{ running: true }, { compacting: true }, { clearing: true }]) {
      const actions = sessionActions({ ...idle, ...busy });
      expect(actions.every((action) => action.disabled && action.reason !== undefined)).toBe(true);
    }
  });

  it('disables compact, with a reason, for an Agent that cannot compact', () => {
    const { compact, clear } = byId({ ...idle, supportsCompaction: false });
    expect(compact?.disabled).toBe(true);
    expect(compact?.reason).toBe("Claude doesn't offer compaction.");
    expect(compact?.command).toBeUndefined();
    expect(clear?.disabled).toBe(false);
  });

  it('waits for an Agent that is still starting, and for a Session without live state', () => {
    expect(byId({ ...idle, agentStatus: 'starting' })['compact']?.reason).toBe(
      'Wait until Claude finishes starting.',
    );
    const unknown = byId({ ...idle, agentStatus: undefined });
    expect(unknown['clear']?.disabled).toBe(true);
    expect(unknown['switch-agent']?.disabled).toBe(true);
  });
});

describe('contextSummary', () => {
  it('shows used of capacity with the share, and how full it is', () => {
    const summary = contextSummary({ _tag: 'reported', used: 82_000, capacity: 200_000 }, 'en');
    expect(summary.label).toBe('82K of 200K · 41%');
    expect(summary.fraction).toBeCloseTo(0.41);
  });

  it('caps the bar at full when the reading is over capacity', () => {
    expect(
      contextSummary({ _tag: 'reported', used: 250_000, capacity: 200_000 }, 'en').fraction,
    ).toBe(1);
  });

  it('has no bar when capacity is unknown, nothing was reported, or a report is awaited', () => {
    expect(contextSummary({ _tag: 'countOnly', used: 5_000 }, 'en')).toEqual({
      label: '5K used',
      fraction: null,
    });
    expect(contextSummary({ _tag: 'unavailable' }, 'en').fraction).toBeNull();
    expect(contextSummary({ _tag: 'waiting' }, 'en').fraction).toBeNull();
    expect(
      contextSummary({ _tag: 'waiting', prior: { used: 1_000, capacity: 4_000 } }, 'en').fraction,
    ).toBeCloseTo(0.25);
  });
});
