import { describe, expect, it } from '@effect/vitest';
import { AgentId } from '../agents/agents.rpc';
import {
  buildStructuredTranscriptExtract,
  computeHandoffBudget,
  estimateSummaryTokens,
  extractHandoffImages,
} from './handoff';
import { MessageId, StepId, ThoughtId, type TranscriptEvent, TurnId } from './sessions.rpc';

const turn1 = TurnId.make('turn-1');
const turn2 = TurnId.make('turn-2');
const msg1 = MessageId.make('msg-1');
const msg2 = MessageId.make('msg-2');
const msg3 = MessageId.make('msg-3');
const msg4 = MessageId.make('msg-4');
const thought1 = ThoughtId.make('thought-1');
const step1 = StepId.make('step-1');
const step2 = StepId.make('step-2');
const step3 = StepId.make('step-3');

const at = 1_700_000_000_000;

describe('handoff helpers', () => {
  it('computes known-capacity budget as min(10% capacity, 8,000) and detects overflow', () => {
    const smallCap = computeHandoffBudget('hello world', 20_000);
    expect(smallCap.knownCapacity).toBe(true);
    expect(smallCap.capTokens).toBe(2000);
    expect(smallCap.overBudget).toBe(false);

    const largeCap = computeHandoffBudget('hello world', 200_000);
    expect(largeCap.knownCapacity).toBe(true);
    expect(largeCap.capTokens).toBe(8000);
    expect(largeCap.overBudget).toBe(false);

    const overText = 'a'.repeat(8001 * 4);
    const over = computeHandoffBudget(overText, 200_000);
    expect(over.estimatedTokens).toBeGreaterThan(8000);
    expect(over.overBudget).toBe(true);
  });

  it('uses provisional 4,000 token cap when destination capacity is unknown', () => {
    const ok = computeHandoffBudget('short summary');
    expect(ok.knownCapacity).toBe(false);
    expect(ok.capTokens).toBe(4000);
    expect(ok.overBudget).toBe(false);

    const overText = 'x'.repeat(4001 * 4);
    const over = computeHandoffBudget(overText);
    expect(over.knownCapacity).toBe(false);
    expect(over.capTokens).toBe(4000);
    expect(over.estimatedTokens).toBe(estimateSummaryTokens(overText));
    expect(over.overBudget).toBe(true);
  });

  it('builds a deterministic Transcript extract excluding Thoughts, condensing Steps, and describing Images', () => {
    const events: ReadonlyArray<TranscriptEvent> = [
      {
        seq: 1,
        at,
        item: {
          _tag: 'TurnStarted',
          turnId: turn1,
          agentId: AgentId.make('claude'),
          permissionMode: 'auto',
        },
      },
      {
        seq: 2,
        at,
        item: {
          _tag: 'Message',
          id: msg1,
          turnId: turn1,
          role: 'user',
          parts: [
            { _tag: 'text', text: 'Implement the login form and check the screenshot.' },
            { _tag: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          ],
        },
      },
      {
        seq: 3,
        at,
        item: {
          _tag: 'Thought',
          id: thought1,
          turnId: turn1,
          text: 'SECRET_PRIVATE_THOUGHT_MUST_NOT_APPEAR',
        },
      },
      {
        seq: 4,
        at,
        item: {
          _tag: 'Step',
          id: step1,
          turnId: turn1,
          kind: 'edit',
          title: 'Edit src/login.ts',
          status: 'done',
          files: ['src/login.ts'],
          diffs: [],
          output: 'HUGE_RAW_TOOL_OUTPUT_'.repeat(30),
        },
      },
      {
        seq: 5,
        at,
        item: {
          _tag: 'Step',
          id: step2,
          turnId: turn1,
          kind: 'execute',
          title: 'npm test',
          status: 'done',
          files: [],
          diffs: [],
          output: '12 passed',
        },
      },
      {
        seq: 6,
        at,
        item: {
          _tag: 'Message',
          id: msg2,
          turnId: turn1,
          role: 'agent',
          parts: [{ _tag: 'text', text: 'Decided to use reactive forms. Login form implemented.' }],
        },
      },
      {
        seq: 7,
        at,
        item: { _tag: 'TurnEnded', turnId: turn1, outcome: { _tag: 'done' } },
      },
      {
        seq: 8,
        at,
        item: {
          _tag: 'TurnStarted',
          turnId: turn2,
          agentId: AgentId.make('claude'),
          permissionMode: 'auto',
        },
      },
      {
        seq: 9,
        at,
        item: {
          _tag: 'Message',
          id: msg3,
          turnId: turn2,
          role: 'user',
          parts: [{ _tag: 'text', text: 'Also add remember-me checkbox.' }],
        },
      },
      {
        seq: 10,
        at,
        item: {
          _tag: 'Step',
          id: step3,
          turnId: turn2,
          kind: 'execute',
          title: 'npm run verify',
          status: 'failed',
          files: [],
          diffs: [],
          output: '1 test failed',
        },
      },
      {
        seq: 11,
        at,
        item: {
          _tag: 'Message',
          id: msg4,
          turnId: turn2,
          role: 'agent',
          parts: [{ _tag: 'text', text: 'Stopped before finishing remember-me.' }],
        },
      },
      {
        seq: 12,
        at,
        item: { _tag: 'TurnEnded', turnId: turn2, outcome: { _tag: 'cancelled' } },
      },
    ];

    const extract = buildStructuredTranscriptExtract(events);
    expect(extract).toContain('Goal:');
    expect(extract).toContain('Implement the login form');
    expect(extract).toContain('Decisions & constraints:');
    expect(extract).toContain('Relevant files:');
    expect(extract).toContain('src/login.ts');
    expect(extract).toContain('Completed work:');
    expect(extract).toContain('Outstanding / interrupted work:');
    expect(extract).toContain('Verification results:');
    expect(extract).toContain('Images referenced:');
    expect(extract).toContain('Missing information:');
    expect(extract).not.toContain('SECRET_PRIVATE_THOUGHT_MUST_NOT_APPEAR');
    expect(extract).not.toContain('HUGE_RAW_TOOL_OUTPUT_'.repeat(10));

    const images = extractHandoffImages(events);
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe('image/png');
    expect(images[0]?.turnId).toBe(turn1);
    expect(images[0]?.role).toBe('user');
  });
});
