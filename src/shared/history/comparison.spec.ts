import { describe, expect, it } from 'vitest';
import { SessionId, TurnId } from '../sessions/sessions.rpc';
import { WorktreeId } from '../worktrees/worktrees.rpc';
import { ComparisonId, findComparisonForTurn } from './comparison';
import type { HistoryComparison } from './comparison';

const legacy: HistoryComparison = {
  id: ComparisonId.make('comparison'),
  sessionId: SessionId.make('session'),
  worktreeId: WorktreeId.make('worktree'),
  recordedAt: 1,
  before: { status: 'Missing', detail: 'absent' },
  after: { status: 'Missing', detail: 'absent' },
};
const first = { ...legacy, turnId: TurnId.make('turn-1') };
const second = { ...legacy, turnId: TurnId.make('turn-2') };

describe('findComparisonForTurn', () => {
  it('finds an exact turn ID', () => {
    expect(findComparisonForTurn([first], TurnId.make('turn-1'))).toBe(first);
  });

  it('does not match legacy records without a turn ID', () => {
    expect(findComparisonForTurn([legacy], TurnId.make('turn-1'))).toBeUndefined();
  });

  it('returns undefined when the turn is absent', () => {
    expect(findComparisonForTurn([first], TurnId.make('turn'))).toBeUndefined();
  });

  it('selects the requested turn among multiple records', () => {
    expect(findComparisonForTurn([legacy, first, second], TurnId.make('turn-2'))).toBe(second);
  });
});
