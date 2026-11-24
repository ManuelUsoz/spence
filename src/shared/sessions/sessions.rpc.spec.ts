import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { AgentId } from '../agents/agents.rpc';
import { DeviceId } from '../devices/devices.rpc';
import { ProjectId } from '../projects/projects.rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import {
  CompactionId,
  type ContextUsage,
  LiveState,
  MessageId,
  type NotificationCause,
  PermissionRequestId,
  SessionError,
  SessionId,
  SessionNotification,
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
  {
    _tag: 'Message',
    id: MessageId.make('steer-1'),
    turnId,
    role: 'user',
    parts: [{ _tag: 'text', text: 'Redirect' }],
    steer: true,
  },
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
    _tag: 'Step',
    id: StepId.make('step-2'),
    turnId,
    title: 'npm test',
    kind: 'execute',
    status: 'failed',
    files: [],
    diffs: [],
    output: '1 failing',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_012_500,
    cwd: '/work/demo',
    input: 'npm test',
    exitCode: 1,
    outputTruncated: true,
  },
  { _tag: 'StepDelta', id: stepId, output: 'streamed line\n' },
  { _tag: 'StepDelta', id: stepId, output: 'tail line\n', truncated: true },
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
        status: 'working',
        lastTurn: { turnId: TurnId.make('turn-0'), outcome: 'done' },
        cwd: '/repo/demo-project',
        title: { auto: 'Fix the build', autoIsPlaceholder: false },
        options: {
          model: { value: 'opus', choices: [{ id: 'opus', name: 'Opus' }] },
          effort: { value: 'high', choices: ['low', 'medium', 'high'] },
          permissionMode: 'auto',
        },
        commands: [
          {
            id: 'Claude:compact',
            name: 'compact',
            invocation: '/compact',
            owner: { kind: 'agent', name: 'Claude' },
            kind: 'command',
            description: 'Compact',
            hint: 'instructions',
          },
        ],
        commandsLoaded: true,
        queue: [
          {
            id: MessageId.make('queued-1'),
            parts: [
              { _tag: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
              { _tag: 'text', text: 'Later' },
            ],
          },
        ],
        steeringSupported: true,
        canAttachImages: true,
        compacting: true,
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
          crossDeviceTools: true,
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
        activity: { kind: 'execute', target: 'npm test', startedAt: 1_700_000_000_123 },
        blockedTarget: 'git push',
      };
      expect(yield* roundTrip(LiveState, live)).toEqual(live);

      const summary: SessionSummary = {
        id: SessionId.make('session-1'),
        agentId: AgentId.make('claude'),
        title: { user: 'Mine', autoIsPlaceholder: true },
        lastActivityAt: 2,
        archivedAt: 3,
        status: 'blocked',
        activity: { kind: 'thinking', target: '', startedAt: 1_700_000_000_456 },
        blockedTarget: 'git push',
        workers: [
          {
            sessionId: SessionId.make('worker-1'),
            parentSessionId: SessionId.make('session-1'),
            title: 'Test runner',
            state: 'running',
            activity: { kind: 'writing', target: '', startedAt: 1_700_000_000_789 },
            blockedTarget: 'rm -rf dist',
          },
        ],
      };
      expect(yield* roundTrip(SessionSummary, summary)).toEqual(summary);

      for (const status of ['idle', 'working', 'blocked', 'error'] as const) {
        for (const outcome of ['done', 'cancelled', 'refused', 'cutShort', 'failed'] as const) {
          const withStatus: LiveState = {
            agentStatus: 'ready',
            status,
            lastTurn: { turnId: TurnId.make('turn-1'), outcome },
            title: { autoIsPlaceholder: false },
            options: { permissionMode: 'auto' },
            commands: [],
            commandsLoaded: false,
            queue: [],
            canAttachImages: false,
            imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
          };
          expect(yield* roundTrip(LiveState, withStatus)).toEqual(withStatus);
        }
      }

      const error = new SessionError({ reason: 'AgentNeedsLogin', detail: 'Claude needs login' });
      const decoded = yield* roundTrip(SessionError, error);
      expect(decoded).toBeInstanceOf(SessionError);
      expect({ ...decoded }).toEqual({ ...error });
      const unsupported = new SessionError({
        reason: 'Unsupported',
        detail: 'Compaction unsupported',
      });
      expect({ ...(yield* roundTrip(SessionError, unsupported)) }).toEqual({ ...unsupported });
      const notRunning = new SessionError({
        reason: 'NotRunning',
        detail: 'No Turn is running to steer',
      });
      expect({ ...(yield* roundTrip(SessionError, notRunning)) }).toEqual({ ...notRunning });
      // An unavailable Agent always says why: there is no bare `AgentUnavailable`.
      const bare = Schema.decodeUnknownExit(SessionError)({
        _tag: 'SessionError',
        reason: 'AgentUnavailable',
        detail: 'Claude is unavailable',
      });
      expect(Exit.isFailure(bare)).toBe(true);
    }),
  );

  it.effect('round-trips every ContextUsage variant in LiveState', () =>
    Effect.gen(function* () {
      const variants: ReadonlyArray<ContextUsage> = [
        { _tag: 'unavailable' },
        { _tag: 'reported', used: 24_000, capacity: 200_000 },
        { _tag: 'reported', used: 210_000, capacity: 200_000 },
        { _tag: 'countOnly', used: 24_000 },
        { _tag: 'historical', used: 24_000, capacity: 200_000 },
        { _tag: 'historical', used: 24_000 },
        { _tag: 'waiting' },
        { _tag: 'waiting', prior: { used: 24_000, capacity: 200_000 } },
        { _tag: 'waiting', prior: { used: 24_000 } },
      ];
      for (const contextUsage of variants) {
        const live: LiveState = {
          agentStatus: 'ready',
          status: 'idle',
          title: { autoIsPlaceholder: false },
          options: { permissionMode: 'auto' },
          commands: [],
          commandsLoaded: false,
          queue: [],
          canAttachImages: false,
          imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
          contextUsage,
        };
        expect(yield* roundTrip(LiveState, live)).toEqual(live);
      }
    }),
  );

  it.effect('round-trips SessionNotification for all causes and archived LiveState', () =>
    Effect.gen(function* () {
      const causes: ReadonlyArray<NotificationCause> = ['blocked', 'turnFinished', 'error'];
      for (const cause of causes) {
        const notification: SessionNotification = {
          device: DeviceId.make('dev-1'),
          sessionId: SessionId.make('sess-1'),
          projectId: ProjectId.make('proj-1'),
          turnId: TurnId.make('turn-1'),
          cause,
          title: 'Fix auth',
          sessionTitle: { auto: 'Fix auth', autoIsPlaceholder: false },
        };
        expect(yield* roundTrip(SessionNotification, notification)).toEqual(notification);
      }
      const archivedLive: LiveState = {
        agentStatus: 'ready',
        status: 'idle',
        archived: true,
        title: { autoIsPlaceholder: false },
        options: { permissionMode: 'auto' },
        commands: [],
        commandsLoaded: false,
        queue: [],
        canAttachImages: false,
        imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
      };
      expect(yield* roundTrip(LiveState, archivedLive)).toEqual(archivedLive);
    }),
  );
});
