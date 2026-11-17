import { describe, expect, it } from 'vitest';
import { capSessions, groupTodayEarlier } from './session-groups';

const at = (month: number, day: number, hour: number): number =>
  new Date(2026, month, day, hour, 0).getTime();
const NOW = at(10, 12, 15);

describe('groupTodayEarlier', () => {
  it('splits newest-first items at local midnight into Today and Earlier', () => {
    const items = [at(10, 12, 14), at(10, 12, 0), at(10, 11, 23), at(7, 3, 9)];
    const groups = groupTodayEarlier(items, (time) => time, NOW);
    expect(groups.map((group) => [group.label, group.items.length])).toEqual([
      ['Today', 2],
      ['Earlier', 2],
    ]);
  });

  it('leaves out a group with nothing in it', () => {
    expect(
      groupTodayEarlier([at(10, 1, 9)], (time) => time, NOW).map((group) => group.label),
    ).toEqual(['Earlier']);
    expect(groupTodayEarlier([], (time) => time, NOW)).toEqual([]);
  });
});

describe('capSessions', () => {
  const items = [1, 2, 3, 4, 5, 6];

  it('hides what is past the cap, but keeps pinned items visible', () => {
    const result = capSessions(items, { cap: 3, expanded: false, isPinned: (n) => n === 5 });
    expect(result.visible).toEqual([1, 2, 3, 5]);
    expect(result.hiddenCount).toBe(2);
  });

  it('shows everything once expanded', () => {
    const result = capSessions(items, { cap: 3, expanded: true, isPinned: () => false });
    expect(result.visible).toEqual(items);
  });
});
