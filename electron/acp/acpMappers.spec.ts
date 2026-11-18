import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';
import path from 'node:path';
import {
  CompactionId,
  MessageId,
  StepId,
  ThoughtId,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import { AcpError } from './acpErrors';
import { Exit } from 'effect';
import {
  cancelSteps,
  failedOutcome,
  foldUpdate,
  openTurn,
  outcomeOf,
  promptOutcome,
  toAcpPrompt,
  toContextUsage,
} from './acpMappers';

const turnId = TurnId.make('turn-1');

/** Ids `id-1`, `id-2`, ... in order. */
const counter = () => {
  let n = 0;
  return () => `id-${++n}`;
};

const agentText = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
});
const thoughtText = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
});

/** Folds the updates in order and returns every item they mapped to. */
const foldAll = (updates: ReadonlyArray<SessionUpdate>) => {
  const newId = counter();
  let fold = openTurn(turnId, '/work');
  return updates.flatMap((update) => {
    const [next, items] = foldUpdate(fold, update, newId);
    fold = next;
    return items;
  });
};

describe('foldUpdate', () => {
  it('starts an agent Message with the first text chunk and appends the rest as deltas', () => {
    expect(foldAll([agentText('Hel'), agentText('lo')])).toEqual([
      {
        _tag: 'Message',
        id: MessageId.make('id-1'),
        turnId,
        role: 'agent',
        parts: [{ _tag: 'text', text: 'Hel' }],
      },
      { _tag: 'MessageDelta', id: MessageId.make('id-1'), text: 'lo' },
    ]);
  });

  it('maps a structured Agent image to its own Message part and closes any open text', () => {
    expect(
      foldAll([
        agentText('Before'),
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        },
        agentText('After'),
      ]),
    ).toEqual([
      {
        _tag: 'Message',
        id: MessageId.make('id-1'),
        turnId,
        role: 'agent',
        parts: [{ _tag: 'text', text: 'Before' }],
      },
      {
        _tag: 'Message',
        id: MessageId.make('id-2'),
        turnId,
        role: 'agent',
        parts: [{ _tag: 'image', mimeType: 'image/png', data: 'AAAA' }],
      },
      { _tag: 'MessageDelta', id: MessageId.make('id-2'), text: 'After' },
    ]);
  });

  it('keeps Thought text apart from the Message, as its own item and deltas', () => {
    expect(foldAll([thoughtText('Let me'), thoughtText(' see'), agentText('Done')])).toEqual([
      { _tag: 'Thought', id: ThoughtId.make('id-1'), turnId, text: 'Let me' },
      { _tag: 'ThoughtDelta', id: ThoughtId.make('id-1'), text: ' see' },
      {
        _tag: 'Message',
        id: MessageId.make('id-2'),
        turnId,
        role: 'agent',
        parts: [{ _tag: 'text', text: 'Done' }],
      },
    ]);
  });

  it('starts a new Message when text follows a Thought that interrupted it', () => {
    const items = foldAll([agentText('a'), thoughtText('hm'), agentText('b')]);
    expect(items.map((item) => item._tag)).toEqual(['Message', 'Thought', 'Message']);
  });

  it('ignores the echo of the user Message and what the thread does not show', () => {
    expect(
      foldAll([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
        { sessionUpdate: 'usage_update', used: 1, size: 2 },
      ]),
    ).toEqual([]);
  });
});

describe('outcomeOf', () => {
  it('maps every ACP stop reason to a Turn outcome', () => {
    expect(outcomeOf('end_turn')).toEqual({ _tag: 'done' });
    expect(outcomeOf('cancelled')).toEqual({ _tag: 'cancelled' });
    expect(outcomeOf('refusal')).toEqual({ _tag: 'refused' });
    expect(outcomeOf('max_tokens')).toEqual({ _tag: 'cutShort', limit: 'maxTokens' });
    expect(outcomeOf('max_turn_requests')).toEqual({ _tag: 'cutShort', limit: 'maxTurnRequests' });
  });
});

describe('failedOutcome', () => {
  it('is agentError for an error the Agent answered with', () => {
    expect(failedOutcome(new AcpError({ reason: 'Refused', detail: 'overloaded' }))).toEqual({
      _tag: 'failed',
      reason: 'agentError',
      detail: 'overloaded',
    });
  });

  it('is agentStopped when the Agent process went away, and needsLogin when it wants a login', () => {
    expect(failedOutcome(new AcpError({ reason: 'Exited', detail: 'exit code 3' }))).toEqual({
      _tag: 'failed',
      reason: 'agentStopped',
      detail: 'exit code 3',
    });
    expect(failedOutcome(new AcpError({ reason: 'AuthRequired', detail: 'log in' }))).toMatchObject(
      { reason: 'needsLogin' },
    );
  });
});

describe('promptOutcome', () => {
  it('is the stop reason of a prompt that ended, and why one failed', () => {
    expect(promptOutcome(Exit.succeed({ stopReason: 'cancelled' }))).toEqual({
      _tag: 'cancelled',
    });
    expect(
      promptOutcome(Exit.fail(new AcpError({ reason: 'Exited', detail: 'exit code 3' }))),
    ).toEqual({ _tag: 'failed', reason: 'agentStopped', detail: 'exit code 3' });
  });

  it('is agentError for a prompt that died', () => {
    expect(promptOutcome(Exit.die('boom'))).toMatchObject({ _tag: 'failed', reason: 'agentError' });
  });
});

describe('toAcpPrompt', () => {
  it('sends text parts as ACP text blocks, in order', () => {
    expect(
      toAcpPrompt([
        { _tag: 'text', text: 'one' },
        { _tag: 'text', text: 'two' },
      ]),
    ).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
  });
});

const cwd = path.resolve('/work/demo');
const inProject = (...segments: ReadonlyArray<string>) => path.join(cwd, ...segments);

/** Folds the updates from a fresh Turn in `cwd`; gives every item and the fold after the last one. */
const foldInProject = (updates: ReadonlyArray<SessionUpdate>) => {
  const newId = counter();
  let fold = openTurn(turnId, cwd);
  const items = updates.flatMap((update) => {
    const [next, mapped] = foldUpdate(fold, update, newId);
    fold = next;
    return mapped;
  });
  return { fold, items };
};

describe('foldUpdate: Steps', () => {
  it('maps a tool call to a whole Step with files relative to the Project', () => {
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read session-view.ts',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: inProject('src', 'session-view.ts'), line: 4 }],
        rawInput: { secret: 'dropped' },
      },
    ]);
    expect(items).toEqual([
      {
        _tag: 'Step',
        id: StepId.make('id-1'),
        turnId,
        title: 'Read session-view.ts',
        kind: 'read',
        status: 'running',
        files: ['src/session-view.ts'],
        diffs: [],
        output: '',
      },
    ]);
  });

  it('merges updates into the Step with the same id, keeping what they leave out', () => {
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Edit a.ts',
        kind: 'edit',
        status: 'pending',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [
          { type: 'diff', path: inProject('a.ts'), oldText: 'one\n', newText: 'one\ntwo\n' },
          { type: 'content', content: { type: 'text', text: 'Saved.' } },
          { type: 'terminal', terminalId: 'term-1' },
        ],
        rawOutput: 'dropped',
      },
    ]);
    expect(items).toHaveLength(2);
    expect(items.at(-1)).toEqual({
      _tag: 'Step',
      id: StepId.make('id-1'),
      turnId,
      title: 'Edit a.ts',
      kind: 'edit',
      status: 'done',
      files: ['a.ts'],
      diffs: [{ path: 'a.ts', before: 'one\n', after: 'one\ntwo\n' }],
      output: 'Saved.',
    });
  });

  it('keeps a file outside the Project as the Agent gave it, and a new file without `before`', () => {
    const outside = path.resolve('/elsewhere/notes.md');
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Write notes',
        kind: 'edit',
        status: 'completed',
        content: [{ type: 'diff', path: outside, newText: 'hi' }],
      },
    ]);
    expect(items).toMatchObject([{ files: [outside], diffs: [{ path: outside, after: 'hi' }] }]);
    expect(items[0]).not.toHaveProperty('diffs.0.before');
  });

  it('maps every ACP kind and status into the contract', () => {
    const { items } = foldInProject([
      { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'a', kind: 'think' },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'b',
        title: 'b',
        kind: 'switch_mode',
        status: 'failed',
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c',
        title: 'c',
        kind: 'execute',
        status: 'completed',
      },
    ]);
    expect(items.map((item) => (item._tag === 'Step' ? [item.kind, item.status] : null))).toEqual([
      ['other', 'pending'],
      ['other', 'failed'],
      ['execute', 'done'],
    ]);
  });

  it('starts a new Message for text after a Step', () => {
    const { items } = foldInProject([
      agentText('Looking.'),
      { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'ls', kind: 'execute' },
      agentText('Found it.'),
    ]);
    expect(items.map((item) => item._tag)).toEqual(['Message', 'Step', 'Message']);
  });
});

describe('cancelSteps', () => {
  it('cancels the Turn’s unfinished Steps and leaves finished ones alone', () => {
    const { fold } = foldInProject([
      { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'a', status: 'pending' },
      { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'b', status: 'in_progress' },
      { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'c', status: 'completed' },
      { sessionUpdate: 'tool_call', toolCallId: 'd', title: 'd', status: 'failed' },
    ]);
    expect(cancelSteps(fold)).toEqual([
      expect.objectContaining({ id: StepId.make('id-1'), title: 'a', status: 'cancelled' }),
      expect.objectContaining({ id: StepId.make('id-2'), title: 'b', status: 'cancelled' }),
    ]);
  });
});

describe('foldUpdate: Plan, Notices and Compactions', () => {
  it('replaces the Plan whole with every update', () => {
    const { items } = foldInProject([
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'in_progress' },
          { content: 'Fix', priority: 'medium', status: 'pending' },
        ],
      },
      {
        sessionUpdate: 'plan',
        entries: [{ content: 'Read', priority: 'high', status: 'completed' }],
      },
    ]);
    expect(items).toEqual([
      {
        _tag: 'Plan',
        entries: [
          { content: 'Read', priority: 'high', status: 'inProgress' },
          { content: 'Fix', priority: 'medium', status: 'pending' },
        ],
      },
      { _tag: 'Plan', entries: [{ content: 'Read', priority: 'high', status: 'completed' }] },
    ]);
  });

  it('maps a notice, with an unknown severity as info', () => {
    const { items } = foldInProject([
      { sessionUpdate: 'notice', severity: 'warning', title: 'Slow', description: 'Rate limited' },
      { sessionUpdate: 'notice', severity: 'shrug', title: 'Hm' },
    ]);
    expect(items).toEqual([
      { _tag: 'Notice', severity: 'warning', title: 'Slow', description: 'Rate limited' },
      { _tag: 'Notice', severity: 'info', title: 'Hm' },
    ]);
  });

  it('folds a Compaction’s summary chunks and status into the whole item', () => {
    const { items } = foldInProject([
      { sessionUpdate: 'compaction_update', compactionId: 'k', status: 'in_progress' },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'k',
        content: { type: 'text', text: 'We fixed ' },
      },
      {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'k',
        content: { type: 'text', text: 'the bug.' },
      },
      { sessionUpdate: 'compaction_update', compactionId: 'k', status: 'completed' },
    ]);
    const id = CompactionId.make('id-1');
    expect(items).toEqual([
      { _tag: 'Compaction', id, status: 'running', summary: '' },
      { _tag: 'Compaction', id, status: 'running', summary: 'We fixed ' },
      { _tag: 'Compaction', id, status: 'running', summary: 'We fixed the bug.' },
      { _tag: 'Compaction', id, status: 'done', summary: 'We fixed the bug.' },
    ]);
  });
});

describe('toContextUsage', () => {
  it('maps finite nonnegative used and finite positive size to reported, preserving >100%', () => {
    expect(toContextUsage({ used: 24_000, size: 200_000 })).toEqual({
      _tag: 'reported',
      used: 24_000,
      capacity: 200_000,
    });
    expect(toContextUsage({ used: 0, size: 200_000 })).toEqual({
      _tag: 'reported',
      used: 0,
      capacity: 200_000,
    });
    expect(toContextUsage({ used: 210_000, size: 200_000 })).toEqual({
      _tag: 'reported',
      used: 210_000,
      capacity: 200_000,
    });
  });

  it('maps missing, zero, negative, or nonfinite size to countOnly when used is valid', () => {
    for (const size of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '200000']) {
      expect(toContextUsage({ used: 24_000, size })).toEqual({
        _tag: 'countOnly',
        used: 24_000,
      });
    }
    expect(toContextUsage({ used: 0, size: 0 })).toEqual({
      _tag: 'countOnly',
      used: 0,
    });
  });

  it('returns undefined when used is negative, nonfinite, or missing', () => {
    for (const used of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
      null,
      '24000',
    ]) {
      expect(toContextUsage({ used, size: 200_000 })).toBeUndefined();
    }
  });
});
