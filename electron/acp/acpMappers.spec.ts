import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { MessageId, ThoughtId, TurnId } from '../../src/shared/sessions/sessions.rpc';
import { AcpError } from './acpErrors';
import { Exit } from 'effect';
import {
  failedOutcome,
  foldUpdate,
  openTurn,
  outcomeOf,
  promptOutcome,
  toAcpPrompt,
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
  let fold = openTurn(turnId);
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

  it('ignores the echo of the user Message and what this slice does not show yet', () => {
    expect(
      foldAll([
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } },
        { sessionUpdate: 'plan', entries: [] },
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
