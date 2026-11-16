import type {
  AgentCapabilities,
  ClientContext,
  ContentBlock,
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
} from '@agentclientprotocol/sdk';
import { Effect, Queue, Schema, Stream } from 'effect';
import type { AcpSessionEvent, AcpSessionQueue, ClientDispatcher } from './acpClientDispatcher';
import { AcpError, requireCapability } from './acpErrors';

/** The Agent's id for an ACP session. Never leaves main: the renderer only sees Spence's `SessionId`. */
export const AcpSessionId = Schema.String.pipe(Schema.brand('AcpSessionId')).annotate({
  identifier: 'AcpSessionId',
});
export type AcpSessionId = typeof AcpSessionId.Type;

/** How a Session's Agent accepts mid-Turn input, if at all. */
export type SteeringMode = 'extension' | 'native';

/** What `_session/steering` reported: the Message joined the Turn, or no Turn was running. */
export type SteerOutcome = 'injected' | 'notRunning';

/** How an ACP session reaches its Agent; built once per connection by the session manager. */
export interface AgentChannel {
  readonly capabilities: AgentCapabilities;
  /** The pre-standard `_session/steering` extension, native mid-Turn prompts, or neither. */
  readonly steering: SteeringMode | undefined;
  readonly dispatcher: ClientDispatcher;
  /** Sends a request; fails `Exited` when the Agent process goes away first. */
  readonly request: <A>(
    method: string,
    send: (agent: ClientContext, signal: AbortSignal) => Promise<A>,
  ) => Effect.Effect<A, AcpError>;
}

/** What the Agent said about a session when it was opened (`session/new`, `load` or `resume`). */
export interface OpenedSession {
  readonly sessionId: AcpSessionId;
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  readonly modes?: SessionModeState | null;
}

/** One live ACP session on an Agent connection. */
export interface AcpSession {
  readonly sessionId: AcpSessionId;
  /** The config options (Model, Effort, ...) as the Agent reported them when the session opened. */
  readonly configOptions: ReadonlyArray<SessionConfigOption>;
  readonly modes: SessionModeState | null;
  /**
   * `session/update` notifications and Permission requests, in arrival order, for one consumer. Ends when the session
   * closes; fails `Exited` when the Agent dies.
   */
  readonly events: Stream.Stream<AcpSessionEvent, AcpError>;
  /**
   * Runs one prompt turn; succeeds with its stop reason, also when it was cancelled. How it ended is also posted on
   * `events` as `PromptEnded`, after the turn's updates.
   */
  readonly prompt: (prompt: ReadonlyArray<ContentBlock>) => Effect.Effect<PromptResponse, AcpError>;
  /**
   * Triggers manual context compaction (`session/compact`). Fails `Unsupported` unless advertised; posts
   * `CompactionEnded` on `events` after every update the Agent emitted for it.
   */
  readonly compact: Effect.Effect<void, AcpError>;
  /** `session/cancel`, then answers every pending Permission request `cancelled`. */
  readonly cancel: Effect.Effect<void, AcpError>;
  /** How the Agent accepts mid-Turn input, if at all. */
  readonly steering: SteeringMode | undefined;
  /**
   * `_session/steering`: injects a follow-up into the running Turn without cancelling it. `notRunning` means no Turn
   * ran and the input was not consumed. Fails `Unsupported` when the extension is not advertised.
   */
  readonly steer: (prompt: ReadonlyArray<ContentBlock>) => Effect.Effect<SteerOutcome, AcpError>;
  /**
   * Native Steering: a normal `session/prompt` sent mid-Turn, whose response is the running Turn's own end and so is
   * ignored here. Only for Agents that steer a mid-Turn prompt instead of starting a new Turn.
   */
  readonly steerNative: (prompt: ReadonlyArray<ContentBlock>) => Effect.Effect<void, AcpError>;
  /** `session/set_config_option`; gives the complete option list back. Only if the session has config options. */
  readonly setConfigOption: (
    configId: string,
    value: string,
  ) => Effect.Effect<ReadonlyArray<SessionConfigOption>, AcpError>;
  /** `session/set_mode`. Only if the session has modes. */
  readonly setMode: (modeId: string) => Effect.Effect<void, AcpError>;
  /** `session/close` when the Agent offers it; either way Spence stops listening to the session. */
  readonly close: Effect.Effect<void, AcpError>;
}

const needsImage = (prompt: ReadonlyArray<ContentBlock>): boolean =>
  prompt.some((block) => block.type === 'image');

/** Whether the Agent advertised `session/compact` support during `initialize`. */
export const supportsAcpCompaction = (capabilities: AgentCapabilities): boolean => {
  const metaCompaction = capabilities._meta?.['compaction'];
  if (typeof metaCompaction === 'boolean') return metaCompaction;
  return (
    typeof capabilities.sessionCapabilities === 'object' &&
    capabilities.sessionCapabilities !== null &&
    'compaction' in capabilities.sessionCapabilities
  );
};

export const makeAcpSession = (
  channel: AgentChannel,
  opened: OpenedSession,
  queue: AcpSessionQueue,
): AcpSession => {
  const { sessionId } = opened;
  const configOptions = opened.configOptions ?? [];
  const { capabilities, dispatcher, request } = channel;

  const runPrompt = Effect.fn('AcpSession.prompt')(function* (blocks: ReadonlyArray<ContentBlock>) {
    if (needsImage(blocks)) {
      yield* requireCapability(
        capabilities.promptCapabilities?.image === true,
        'Images in a prompt',
      );
    }
    // No cancellation signal: a turn is stopped with `cancel`, which lets the Agent end it `cancelled`.
    return yield* request('session/prompt', (agent) =>
      agent.request('session/prompt', { sessionId, prompt: [...blocks] }),
    );
  });

  const prompt = (blocks: ReadonlyArray<ContentBlock>) =>
    runPrompt(blocks).pipe(
      Effect.onExit((result) => Queue.offer(queue, { _tag: 'PromptEnded', result })),
    );

  const runCompact = Effect.fn('AcpSession.compact')(function* () {
    yield* requireCapability(supportsAcpCompaction(capabilities), 'session/compact');
    // No abort signal: cancelled via `session/cancel`, matching `session/prompt`.
    yield* request('session/compact', (agent) => agent.request('session/compact', { sessionId }));
  });

  const compact = runCompact().pipe(
    Effect.onExit((result) => Queue.offer(queue, { _tag: 'CompactionEnded', result })),
  );

  const cancel = request('session/cancel', (agent) =>
    agent.notify('session/cancel', { sessionId }),
  ).pipe(Effect.andThen(dispatcher.cancelPermissions(sessionId)));

  const steer = Effect.fn('AcpSession.steer')(function* (blocks: ReadonlyArray<ContentBlock>) {
    if (needsImage(blocks)) {
      yield* requireCapability(
        capabilities.promptCapabilities?.image === true,
        'Images in a prompt',
      );
    }
    yield* requireCapability(channel.steering === 'extension', '_session/steering');
    const response: unknown = yield* request('_session/steering', (agent, signal) =>
      agent.request(
        '_session/steering',
        {
          sessionId,
          prompt: [...blocks],
          // Do not consume a Message when the Turn ended just before this request arrived.
          _meta: { steering: { idleBehavior: 'promptRequired' } },
        },
        { cancellationSignal: signal },
      ),
    );
    const result =
      typeof response === 'object' && response !== null
        ? (response as { readonly outcome?: unknown; readonly reason?: unknown })
        : {};
    if (result.outcome === 'injected') return 'injected' as const;
    if (result.outcome === 'promptRequired') return 'notRunning' as const;
    // `startedNewTurn` should not happen with `promptRequired`, but the input was consumed either way.
    if (result.outcome === 'startedNewTurn') return 'injected' as const;
    const reason = typeof result.reason === 'string' ? `: ${result.reason}` : '';
    return yield* new AcpError({
      reason: 'Refused',
      detail: `_session/steering did not inject the Message${reason}`,
    });
  });

  const steerNative = (blocks: ReadonlyArray<ContentBlock>) =>
    runPrompt(blocks).pipe(Effect.asVoid);

  const setConfigOption = Effect.fn('AcpSession.setConfigOption')(function* (
    configId: string,
    value: string,
  ) {
    yield* requireCapability(configOptions.length > 0, 'session/set_config_option');
    const response = yield* request('session/set_config_option', (agent, signal) =>
      agent.request(
        'session/set_config_option',
        { sessionId, configId, value },
        { cancellationSignal: signal },
      ),
    );
    return response.configOptions;
  });

  const setMode = Effect.fn('AcpSession.setMode')(function* (modeId: string) {
    yield* requireCapability(
      opened.modes !== undefined && opened.modes !== null,
      'session/set_mode',
    );
    yield* request('session/set_mode', (agent, signal) =>
      agent.request('session/set_mode', { sessionId, modeId }, { cancellationSignal: signal }),
    );
  });

  const close = Effect.gen(function* () {
    if (capabilities.sessionCapabilities?.close) {
      yield* request('session/close', (agent, signal) =>
        agent.request('session/close', { sessionId }, { cancellationSignal: signal }),
      );
    }
  }).pipe(Effect.ensuring(dispatcher.detach(sessionId)));

  return {
    sessionId,
    configOptions,
    modes: opened.modes ?? null,
    events: Stream.fromQueue(queue),
    prompt,
    compact,
    cancel,
    steering: channel.steering,
    steer,
    steerNative,
    setConfigOption,
    setMode,
    close,
  };
};
