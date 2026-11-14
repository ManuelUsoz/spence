import { describe, expect, it } from '@effect/vitest';
import { AgentId } from '../agents/agents.rpc';
import {
  buildStructuredTranscriptExtract,
  checkImageCompatibility,
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

  it('enforces maxDimensionPx, maxBase64Bytes, and maxPerMessage in checkImageCompatibility', () => {
    const pngBase64 = (width: number, height: number): string => {
      const bytes = new Uint8Array(24);
      bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
      const view = new DataView(bytes.buffer);
      view.setUint32(16, width, false);
      view.setUint32(20, height, false);
      return Buffer.from(bytes).toString('base64');
    };
    const jpegBase64 = (width: number, height: number): string => {
      const bytes = new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xc0,
        0x00,
        0x07,
        0x08,
        (height >> 8) & 0xff,
        height & 0xff,
        (width >> 8) & 0xff,
        width & 0xff,
        0xff,
        0xd9,
      ]);
      return Buffer.from(bytes).toString('base64');
    };

    const capabilities = {
      models: true,
      effort: true,
      images: true,
      askMode: true,
      resume: true,
      contextUsage: true,
      supportsCompaction: true,
      supportsIsolatedSummary: true,
      modelChangePreservesContext: true,
    };
    const limits = { maxBase64Bytes: 1000, maxDimensionPx: 100, maxPerMessage: 2 };

    const blocked = checkImageCompatibility(
      [
        {
          id: 'ok-png',
          mimeType: 'image/png',
          data: pngBase64(100, 80),
          turnId: turn1,
          role: 'user',
          seq: 1,
        },
        {
          id: 'wide-png',
          mimeType: 'image/png',
          data: pngBase64(101, 20),
          turnId: turn1,
          role: 'user',
          seq: 2,
        },
        {
          id: 'tall-jpeg',
          mimeType: 'image/jpeg',
          data: jpegBase64(50, 120),
          turnId: turn1,
          role: 'user',
          seq: 3,
        },
      ],
      capabilities,
      limits,
    );

    expect(blocked.map((entry) => entry.imageId)).toEqual(['wide-png', 'tall-jpeg']);
    expect(blocked[0]?.reason).toContain('100');
    expect(blocked[1]?.reason).toContain('100');
  });
});
