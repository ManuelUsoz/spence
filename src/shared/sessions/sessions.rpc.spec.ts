import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { AgentId } from '../agents/agents.rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import {
  CompactionId,
  LiveState,
  MessageId,
  PermissionRequestId,
  SessionError,
  SessionId,
  SessionSummary,
  StepId,
  ThoughtId,
  TranscriptEvent,
  TurnId,
  type TranscriptItem,
} from './sessions.rpc';

/** Encodes and decodes a value the way the wire does (`layerSchemaBinary`). */
const roundTrip = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  schema: S,
  value: S['Type'],
) =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const codec = serialization.codecFor(schema);
    const encoded = yield* Schema.encodeEffect(codec)(value);
    return yield* Schema.decodeUnknownEffect(codec)(encoded);
  }).pipe(Effect.provide(layerPortSerialization));

const turnId = TurnId.make('turn-1');
const messageId = MessageId.make('message-1');
const thoughtId = ThoughtId.make('thought-1');
const stepId = StepId.make('step-1');

/** One of every Transcript item kind and variant (spec 4.3). */
const items: ReadonlyArray<TranscriptItem> = [
  { _tag: 'TurnStarted', turnId, model: 'opus', effort: 'high', permissionMode: 'auto' },
  { _tag: 'TurnStarted', turnId, permissionMode: 'ask' },
  { _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } },
  { _tag: 'TurnEnded', turnId, outcome: { _tag: 'cancelled' } },
  { _tag: 'TurnEnded', turnId, outcome: { _tag: 'refused' } },
  { _tag: 'TurnEnded', turnId, outcome: { _tag: 'cutShort', limit: 'maxTokens' } },
  ...(['agentError', 'agentStopped', 'needsLogin', 'interrupted'] as const).map(
    (reason): TranscriptItem => ({
      _tag: 'TurnEnded',
      turnId,
      outcome: { _tag: 'failed', reason, detail: 'it broke' },
    }),
  ),
  {
    _tag: 'Message',
    id: messageId,
    turnId,
    role: 'user',
    parts: [
      { _tag: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { _tag: 'text', text: 'Look at this' },
      {
        _tag: 'link',
        uri: 'file:///a.ts',
        name: 'a.ts',
        title: 'A',
        mimeType: 'text/plain',
        size: 12,
      },
      { _tag: 'link', uri: 'file:///b.ts', name: 'b.ts' },
      { _tag: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' },
      { _tag: 'resource', uri: 'file:///c.md', contents: { _tag: 'text', text: '# C' } },
      {
        _tag: 'resource',
        uri: 'file:///d.bin',
        mimeType: 'application/octet-stream',
        contents: { _tag: 'blob', blob: 'AAEC' },
      },
    ],
  },
  { _tag: 'Message', id: messageId, turnId, role: 'agent', parts: [] },
  { _tag: 'MessageDelta', id: messageId, text: 'more' },
  { _tag: 'Thought', id: thoughtId, turnId, text: 'Hmm' },
  { _tag: 'ThoughtDelta', id: thoughtId, text: ', right' },
  {
    _tag: 'Step',
    id: stepId,
    turnId,
    title: 'Edit a.ts',
    kind: 'edit',
    status: 'done',
    files: ['a.ts'],
    diffs: [
      { path: 'a.ts', before: 'x', after: 'y' },
      { path: 'new.ts', after: 'z' },
    ],
    output: '',
  },
  {
    _tag: 'Plan',
    entries: [{ content: 'Read', priority: 'high', status: 'inProgress' }],
  },
  ...(
    [
      { _tag: 'pending' },
      { _tag: 'answered', optionId: 'allow', by: 'user' },
      { _tag: 'answered', optionId: 'allow', by: 'policy' },
      { _tag: 'cancelled' },
    ] as const
  ).map((state): TranscriptItem => ({
    _tag: 'PermissionRequest',
    id: PermissionRequestId.make('request-1'),
    turnId,
    stepId,
    options: [
      { id: 'allow', label: 'Allow', kind: 'allowOnce' },
      { id: 'always', label: 'Always', kind: 'allowAlways' },
      { id: 'reject', label: 'Reject', kind: 'rejectOnce' },
      { id: 'never', label: 'Never', kind: 'rejectAlways' },
    ],
    state,
  })),
  { _tag: 'Compaction', id: CompactionId.make('compaction-1'), status: 'done', summary: 'S' },
  { _tag: 'Notice', severity: 'warning', title: 'Careful', description: 'Really' },
  { _tag: 'Notice', severity: 'info', title: 'FYI' },
  { _tag: 'ContextCleared', reason: 'cleared' },
  { _tag: 'ContextCleared', reason: 'lost' },
];

describe('sessions contract over layerSchemaBinary', () => {
  it.effect('round-trips every Transcript item kind as an event', () =>
    Effect.gen(function* () {
      for (const [index, item] of items.entries()) {
        const event: TranscriptEvent = { seq: index + 1, at: 1_700_000_000_000 + index, item };
        expect(yield* roundTrip(TranscriptEvent, event)).toEqual(event);
      }
    }),
  );

  it.effect('round-trips the live state, a summary and the error', () =>
    Effect.gen(function* () {
      const live: LiveState = {
        agentStatus: 'ready',
        title: { auto: 'Fix the build', autoIsPlaceholder: false },
        options: {
          model: { value: 'opus', choices: [{ id: 'opus', name: 'Opus' }] },
          effort: { value: 'high', choices: ['low', 'medium', 'high'] },
          permissionMode: 'auto',
        },
        commands: [{ name: 'compact', description: 'Compact', hint: 'instructions' }],
        canAttachImages: true,
        imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 2, maxPerMessage: 3 },
        agentName: 'Claude',
        agentId: AgentId.make('claude'),
        agentPackage: '@anthropic-ai/claude-agent-acp',
        installKind: 'npm',
        capabilities: {
          models: true,
          effort: true,
          images: true,
          askMode: true,
          resume: true,
          contextUsage: true,
          supportsCompaction: true,
          supportsIsolatedSummary: true,
          modelChangePreservesContext: true,
        },
        isDraft: true,
        installedVersion: '0.105.0',
        versionQualification: 'unverified',
        upgradeCommand: 'npm install -g @agentclientprotocol/claude-agent-acp@0.106.0',
        modelsLimitation: 'Some models are unavailable',
        cantStartReason: 'unsupported',
        cantStartDetail: 'Auto mode is not supported',
        authMethods: [
          {
            id: 'claudeai',
            name: 'Log in with Claude',
            description: 'Open browser',
            command: 'claude auth login --claudeai',
          },
        ],
      };
      expect(yield* roundTrip(LiveState, live)).toEqual(live);

      const summary: SessionSummary = {
        id: SessionId.make('session-1'),
        agentId: AgentId.make('claude'),
        title: { user: 'Mine', autoIsPlaceholder: true },
        lastActivityAt: 2,
        archivedAt: 3,
      };
      expect(yield* roundTrip(SessionSummary, summary)).toEqual(summary);

      const error = new SessionError({ reason: 'AgentNeedsLogin', detail: 'Claude needs login' });
      const decoded = yield* roundTrip(SessionError, error);
      expect(decoded).toBeInstanceOf(SessionError);
      expect({ ...decoded }).toEqual({ ...error });
      // An unavailable Agent always says why: there is no bare `AgentUnavailable`.
      const bare = Schema.decodeUnknownExit(SessionError)({
        _tag: 'SessionError',
        reason: 'AgentUnavailable',
        detail: 'Claude is unavailable',
      });
      expect(Exit.isFailure(bare)).toBe(true);
    }),
  );
});
