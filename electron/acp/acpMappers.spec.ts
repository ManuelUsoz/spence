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
  applyTerminalExit,
  cancelSteps,
  failedOutcome,
  foldUpdate,
  markStepStreamed,
  openTurn,
  outcomeOf,
  promptOutcome,
  stepOfToolCall,
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
const foldInProject = (
  updates: ReadonlyArray<SessionUpdate>,
  nowAt: (index: number) => number = (index) => 1_000 + index * 100,
) => {
  const newId = counter();
  let fold = openTurn(turnId, cwd);
  const items = updates.flatMap((update, index) => {
    const [next, mapped] = foldUpdate(fold, update, newId, nowAt(index));
    fold = next;
    return mapped;
  });
  return { fold, items };
};

describe('foldUpdate: Steps', () => {
  it('maps a tool call to a whole Step with files relative to the Project, timing, and structured input', () => {
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read session-view.ts',
        kind: 'read',
        status: 'in_progress',
        locations: [{ path: inProject('src', 'session-view.ts'), line: 4 }],
        rawInput: { path: inProject('src', 'session-view.ts'), line: 4 },
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
        startedAt: 1_000,
        input: JSON.stringify({ path: inProject('src', 'session-view.ts'), line: 4 }, null, 2),
      },
    ]);
  });

  it('merges updates into the Step with the same id, keeping what they leave out and stamping startedAt/endedAt', () => {
    const { items } = foldInProject(
      [
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
          status: 'in_progress',
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
          rawOutput: { output: 'Saved.', exitCode: 0 },
        },
      ],
      (index) => [1_000, 1_250, 2_500][index]!,
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ status: 'pending' });
    expect(items[0]).not.toHaveProperty('startedAt');
    expect(items[1]).toMatchObject({ status: 'running', startedAt: 1_250 });
    expect(items[1]).not.toHaveProperty('endedAt');
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
      startedAt: 1_250,
      endedAt: 2_500,
      exitCode: 0,
    });
  });

  it('records terminalId bindings on TurnFold when tool_call or tool_call_update embeds terminal content', () => {
    const { fold, items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-term',
        title: 'npm test',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'term-42' }],
      },
    ]);
    const step = items[0];
    expect(step?._tag).toBe('Step');
    if (step?._tag === 'Step') {
      expect(fold.stepTerminals.get(step.id)).toEqual(['term-42']);
    }
  });

  it('applies authoritative terminal exitCode and protects streamed output from later tool_call_update rawOutput', () => {
    let fold = openTurn(turnId, '/work/demo');
    const [afterCall, callItems] = foldUpdate(
      fold,
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-term',
        title: 'npm test',
        kind: 'execute',
        status: 'in_progress',
        content: [{ type: 'terminal', terminalId: 'term-99' }],
      },
      () => 'step-term',
      100,
    );
    const created = callItems[0];
    expect(created?._tag).toBe('Step');
    if (created?._tag !== 'Step') return;

    fold = markStepStreamed(afterCall, created.id);
    const [afterExit, exitedStep] = applyTerminalExit(fold, 'term-99', 2);
    expect(exitedStep?.exitCode).toBe(2);

    const [, updatedItems] = foldUpdate(
      afterExit,
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-term',
        status: 'failed',
        content: [
          { type: 'terminal', terminalId: 'term-99' },
          { type: 'content', content: { type: 'text', text: 'SHOULD_NOT_OVERWRITE' } },
        ],
        rawOutput: { output: 'SHOULD_NOT_WIPE', exitCode: 0 },
      },
      () => 'unused',
      200,
    );
    expect(updatedItems[0]).toMatchObject({
      _tag: 'Step',
      status: 'failed',
      output: '',
      exitCode: 2,
    });
  });

  it('captures cwd, command input, rawOutput stdout/stderr, and exitCode for execute Steps', () => {
    const { items } = foldInProject(
      [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'exec-1',
          title: 'Run tests',
          kind: 'execute',
          status: 'in_progress',
          rawInput: {
            command: 'npm',
            args: ['test', '--', '--watch=false'],
            cwd: '/work/demo/app',
          },
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'exec-1',
          status: 'failed',
          rawOutput: { stdout: 'running...', stderr: '1 failing', exit_code: 1 },
        },
      ],
      (index) => [5_000, 17_000][index]!,
    );
    expect(items.at(-1)).toEqual({
      _tag: 'Step',
      id: StepId.make('id-1'),
      turnId,
      title: 'Run tests',
      kind: 'execute',
      status: 'failed',
      files: [],
      diffs: [],
      output: 'running...\n1 failing',
      startedAt: 5_000,
      endedAt: 17_000,
      cwd: '/work/demo/app',
      input: 'npm test -- --watch=false',
      exitCode: 1,
    });
  });

  it('caps output at a 32 KB rolling UTF-8 tail on character boundaries and flags outputTruncated', () => {
    // 4-byte emoji repeated so the 32,768-byte boundary falls inside a multi-byte character.
    const prefix = 'A'.repeat(1_000);
    const tailChunk = '🚀'.repeat(9_000); // 36,000 UTF-8 bytes
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tail-1',
        title: 'cat huge.log',
        kind: 'execute',
        status: 'completed',
        rawOutput: prefix + tailChunk,
      },
    ]);
    const step = items[0];
    expect(step?._tag).toBe('Step');
    if (step?._tag !== 'Step') return;
    expect(step.outputTruncated).toBe(true);
    expect(Buffer.byteLength(step.output, 'utf8')).toBeLessThanOrEqual(32_768);
    expect(step.output.startsWith('🚀')).toBe(true);
    expect(step.output.includes('\uFFFD')).toBe(false);
    expect(step.startedAt).toBe(1_000);
    expect(step.endedAt).toBe(1_000);
  });

  it('omits outputTruncated when output fits within 32 KB', () => {
    const { items } = foldInProject([
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'small-1',
        title: 'echo ok',
        kind: 'execute',
        status: 'completed',
        rawOutput: 'ok',
      },
    ]);
    expect(items[0]).not.toHaveProperty('outputTruncated');
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

describe('stepOfToolCall', () => {
  it('normalizes rawInput old_string/new_string edit payloads, new-file content, cwd, and input before tool_call_update', () => {
    const editStep = stepOfToolCall(
      {
        toolCallId: 'edit-call',
        title: 'Edit src/app.ts',
        kind: 'edit',
        locations: [{ path: inProject('src', 'app.ts') }],
        rawInput: {
          file_path: inProject('src', 'app.ts'),
          old_string: 'const a = 1;',
          new_string: 'const a = 2;',
        },
      },
      turnId,
      StepId.make('step-edit'),
      cwd,
    );
    expect(editStep).toMatchObject({
      _tag: 'Step',
      id: StepId.make('step-edit'),
      turnId,
      kind: 'edit',
      status: 'pending',
      files: ['src/app.ts'],
      diffs: [{ path: 'src/app.ts', before: 'const a = 1;', after: 'const a = 2;' }],
    });
    expect(editStep.input).toContain('old_string');

    const newFileStep = stepOfToolCall(
      {
        toolCallId: 'write-call',
        title: 'Write src/new.ts',
        kind: 'edit',
        rawInput: {
          path: inProject('src', 'new.ts'),
          content: 'export const x = 1;\n',
        },
      },
      turnId,
      StepId.make('step-write'),
      cwd,
    );
    expect(newFileStep).toMatchObject({
      files: ['src/new.ts'],
      diffs: [{ path: 'src/new.ts', after: 'export const x = 1;\n' }],
    });
    expect(newFileStep.diffs[0]).not.toHaveProperty('before');

    const execStep = stepOfToolCall(
      {
        toolCallId: 'exec-call',
        title: 'git push',
        kind: 'execute',
        rawInput: { command: 'git push origin main', cwd: inProject('sub') },
      },
      turnId,
      StepId.make('step-exec'),
      cwd,
    );
    expect(execStep).toMatchObject({
      kind: 'execute',
      cwd: inProject('sub'),
      input: 'git push origin main',
    });
  });
});

describe('cancelSteps', () => {
  it('cancels the Turn’s unfinished Steps with endedAt and leaves finished ones alone', () => {
    const { fold } = foldInProject(
      [
        { sessionUpdate: 'tool_call', toolCallId: 'a', title: 'a', status: 'pending' },
        { sessionUpdate: 'tool_call', toolCallId: 'b', title: 'b', status: 'in_progress' },
        { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'c', status: 'completed' },
        { sessionUpdate: 'tool_call', toolCallId: 'd', title: 'd', status: 'failed' },
      ],
      (index) => 1_000 + index * 100,
    );
    expect(cancelSteps(fold, 2_500)).toEqual([
      expect.objectContaining({
        id: StepId.make('id-1'),
        title: 'a',
        status: 'cancelled',
        startedAt: 2_500,
        endedAt: 2_500,
      }),
      expect.objectContaining({
        id: StepId.make('id-2'),
        title: 'b',
        status: 'cancelled',
        startedAt: 1_100,
        endedAt: 2_500,
      }),
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
