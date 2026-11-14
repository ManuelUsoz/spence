import { describe, expect, it } from 'vitest';
import {
  CompactionId,
  MessageId,
  StepId,
  ThoughtId,
  TurnId,
  type SessionStreamItem,
  type TranscriptItem,
  type TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';
import {
  changedFiles,
  completedPlanCount,
  currentPlanEntry,
  diffStats,
  emptyThread,
  foldThread,
  formatElapsed,
  isLastMessageOfTurn,
  runningWork,
  stepTarget,
  threadRows,
  type Thread,
} from './thread';

const turnId = TurnId.make('turn-1');
const userId = MessageId.make('user-1');
const agentId = MessageId.make('agent-1');
const stepId = StepId.make('step-1');
const thoughtId = ThoughtId.make('thought-1');

let seq = 0;
const event = (item: TranscriptItem, at = ++seq): SessionStreamItem => ({
  _tag: 'Transcript',
  event: { seq, at, item },
});

const started = () => event({ _tag: 'TurnStarted', turnId, permissionMode: 'auto' });
const userMessage = (text: string) =>
  event({ _tag: 'Message', id: userId, turnId, role: 'user', parts: [{ _tag: 'text', text }] });
const agentMessage = (text: string) =>
  event({ _tag: 'Message', id: agentId, turnId, role: 'agent', parts: [{ _tag: 'text', text }] });
const agentDelta = (text: string) => event({ _tag: 'MessageDelta', id: agentId, text });
const thought = (text: string) => event({ _tag: 'Thought', id: thoughtId, turnId, text });
const step = (patch?: Partial<Extract<TranscriptItem, { _tag: 'Step' }>>) =>
  event({
    _tag: 'Step',
    id: stepId,
    turnId,
    title: 'Read src/view.ts',
    kind: 'read',
    status: 'running',
    files: ['src/view.ts'],
    diffs: [],
    output: '',
    ...patch,
  });
const plan = () =>
  event({
    _tag: 'Plan',
    entries: [
      { content: 'Read', priority: 'high', status: 'completed' },
      { content: 'Fix', priority: 'medium', status: 'inProgress' },
    ],
  });
const notice = () =>
  event({ _tag: 'Notice', severity: 'warning', title: 'Slow', description: 'Rate limited' });
const compaction = () =>
  event({ _tag: 'Compaction', id: CompactionId.make('c-1'), status: 'running', summary: '' });
const ended = (outcome: TurnOutcome = { _tag: 'done' }) =>
  event({ _tag: 'TurnEnded', turnId, outcome });

const foldAll = (items: ReadonlyArray<SessionStreamItem>): Thread =>
  items.reduce((thread, item) => foldThread(thread, item), emptyThread);

describe('foldThread', () => {
  it('builds Turn work from Steps, Thought and Plan', () => {
    const thread = foldAll([started(), thought('Let me see'), plan(), step()]);
    const work = thread.work.get(turnId);
    expect(work).toMatchObject({
      activity: 'step',
      thought: 'Let me see',
      plan: {
        entries: [
          { content: 'Read', status: 'completed' },
          { content: 'Fix', status: 'inProgress' },
        ],
      },
      steps: [{ id: stepId, kind: 'read', status: 'running' }],
    });
  });

  it('keeps Notices and Compactions in order, attached to the last Message', () => {
    const thread = foldAll([
      started(),
      userMessage('Hi'),
      notice(),
      compaction(),
      agentMessage('Done'),
      ended(),
    ]);
    expect(thread.asides).toHaveLength(2);
    expect(thread.asides[0]).toMatchObject({ afterMessage: userId, item: { _tag: 'Notice' } });
    expect(thread.asides[1]).toMatchObject({ afterMessage: userId, item: { _tag: 'Compaction' } });
  });

  it('records the Turn outcome and clears the running id', () => {
    const thread = foldAll([
      started(),
      userMessage('Hi'),
      agentMessage('Done'),
      ended({ _tag: 'cancelled' }),
    ]);
    expect(thread.running).toBeNull();
    expect(thread.outcomes.get(turnId)).toEqual({ _tag: 'cancelled' });
  });

  it('replaces a Compaction in place when its id is seen again', () => {
    const thread = foldAll([
      started(),
      userMessage('Hi'),
      compaction(),
      event({
        _tag: 'Compaction',
        id: CompactionId.make('c-1'),
        status: 'done',
        summary: 'All good',
      }),
    ]);
    expect(thread.asides).toHaveLength(1);
    expect(thread.asides[0]?.item).toMatchObject({ status: 'done', summary: 'All good' });
  });
});

describe('threadRows', () => {
  it('places the Ticker after the last Message of a running Turn', () => {
    const thread = foldAll([started(), userMessage('Hi'), step()]);
    const rows = threadRows(thread);
    expect(rows.map((row) => row.type)).toEqual(['message', 'ticker']);
  });

  it('places the Receipt and outcome after the last Message of an ended Turn', () => {
    const thread = foldAll([
      started(),
      userMessage('Hi'),
      agentMessage('Done'),
      ended({ _tag: 'cancelled' }),
    ]);
    const rows = threadRows(thread);
    expect(rows.map((row) => row.type)).toEqual(['message', 'message', 'outcome', 'receipt']);
  });

  it('places asides after the Message they follow', () => {
    const thread = foldAll([started(), userMessage('Hi'), notice(), agentMessage('Done'), ended()]);
    const rows = threadRows(thread);
    expect(rows.map((row) => row.type)).toEqual(['message', 'aside', 'message', 'receipt']);
  });
});

describe('isLastMessageOfTurn', () => {
  it('is true only for the final Message of a Turn', () => {
    const thread = foldAll([
      started(),
      userMessage('Hi'),
      agentMessage('One'),
      agentDelta(' two'),
      ended(),
    ]);
    expect(isLastMessageOfTurn(thread, 0)).toBe(false);
    expect(isLastMessageOfTurn(thread, 1)).toBe(true);
  });
});

describe('runningWork', () => {
  it('returns the work of the running Turn', () => {
    const thread = foldAll([started(), step()]);
    expect(runningWork(thread)?.activity).toBe('step');
  });

  it('returns null when no Turn runs', () => {
    expect(runningWork(emptyThread)).toBeNull();
  });
});

describe('formatElapsed', () => {
  it('formats as mm:ss under an hour', () => {
    expect(formatElapsed(65_000)).toBe('01:05');
  });

  it('formats as h:mm:ss from an hour up', () => {
    expect(formatElapsed(3_661_000)).toBe('1:01:01');
  });
});

describe('stepTarget', () => {
  it('returns the first file for file Step kinds', () => {
    expect(
      stepTarget({
        _tag: 'Step',
        id: stepId,
        turnId,
        title: 'Read src/view.ts',
        kind: 'read',
        status: 'running',
        files: ['src/view.ts'],
        diffs: [],
        output: '',
      }),
    ).toBe('src/view.ts');
  });

  it('returns the title for execute Steps', () => {
    expect(
      stepTarget({
        _tag: 'Step',
        id: stepId,
        turnId,
        title: 'npm test',
        kind: 'execute',
        status: 'running',
        files: [],
        diffs: [],
        output: '',
      }),
    ).toBe('npm test');
  });
});

describe('diffStats', () => {
  it('counts added and removed lines', () => {
    expect(diffStats('one\ntwo\n', 'one\ntwo\nthree\n')).toEqual({ added: 1, removed: 0 });
  });

  it('treats a missing before as a new file', () => {
    expect(diffStats(undefined, 'one\ntwo\n')).toEqual({ added: 3, removed: 0 });
  });
});

describe('changedFiles', () => {
  it('collects the unique changed files of a Turn', () => {
    const work = foldAll([
      started(),
      step({
        diffs: [
          { path: 'a.ts', before: 'one\n', after: 'one\ntwo\n' },
          { path: 'b.ts', after: 'new\n' },
        ],
      }),
    ]).work.get(turnId);
    expect(work).toBeDefined();
    const files = changedFiles(work!);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });
});

describe('Plan helpers', () => {
  const plan = {
    _tag: 'Plan' as const,
    entries: [
      { content: 'One', priority: 'medium' as const, status: 'completed' as const },
      { content: 'Two', priority: 'medium' as const, status: 'inProgress' as const },
      { content: 'Three', priority: 'medium' as const, status: 'pending' as const },
    ],
  };

  it('counts completed entries', () => {
    expect(completedPlanCount(plan)).toBe(1);
  });

  it('picks the first non-completed entry as current', () => {
    expect(currentPlanEntry(plan)?.content).toBe('Two');
  });

  it('falls back to the last entry when all are completed', () => {
    const allDone = {
      ...plan,
      entries: plan.entries.map((entry) => ({ ...entry, status: 'completed' as const })),
    };
    expect(currentPlanEntry(allDone)?.content).toBe('Three');
  });
});

describe('agentError duplicate message removal', () => {
  it('drops the Turn last agent Message when its text equals the agentError detail', () => {
    const result = foldAll([
      started(),
      userMessage('hello'),
      agentMessage('API Error: overloaded'),
      event({
        _tag: 'TurnEnded',
        turnId,
        outcome: { _tag: 'failed', reason: 'agentError', detail: 'API Error: overloaded' },
      }),
    ]);
    expect(result.messages.map((m) => m.text)).toEqual(['hello']);
    expect(result.outcomes.get(turnId)).toEqual({
      _tag: 'failed',
      reason: 'agentError',
      detail: 'API Error: overloaded',
    });
  });

  it('keeps an earlier agent Message whose text differs from the agentError detail', () => {
    const result = foldAll([
      started(),
      userMessage('hello'),
      agentMessage('Partial answer'),
      event({
        _tag: 'TurnEnded',
        turnId,
        outcome: { _tag: 'failed', reason: 'agentError', detail: 'API Error: overloaded' },
      }),
    ]);
    expect(result.messages.map((m) => m.text)).toEqual(['hello', 'Partial answer']);
  });
});

describe('threadRows asides before messages', () => {
  it('emits a Compaction aside with afterMessage null even when there are no messages yet', () => {
    const thread = foldAll([
      event({
        _tag: 'Compaction',
        id: CompactionId.make('comp-1'),
        status: 'running',
        summary: 'Working',
      }),
    ]);
    const rows = threadRows(thread);
    expect(rows.some((row) => row.type === 'aside' && row.aside.item._tag === 'Compaction')).toBe(
      true,
    );
  });
});
