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
import { type AcpError, requireCapability } from './acpErrors';

/** The Agent's id for an ACP session. Never leaves main: the renderer only sees Spence's `SessionId`. */
export const AcpSessionId = Schema.String.pipe(Schema.brand('AcpSessionId')).annotate({
  identifier: 'AcpSessionId',
});
export type AcpSessionId = typeof AcpSessionId.Type;

/** How an ACP session reaches its Agent; built once per connection by the session manager. */
export interface AgentChannel {
  readonly capabilities: AgentCapabilities;
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
  /** `session/cancel`, then answers every pending Permission request `cancelled`. */
  readonly cancel: Effect.Effect<void, AcpError>;
  /** `session/set_config_option`; gives the complete option list back. Only if the session has config options. */
  readonly setConfigOption: (
    configId: string,
    value: string,
  ) => Effect.Effect<ReadonlyArray<SessionConfigOption>, AcpError>;
  /** `session/close` when the Agent offers it; either way Spence stops listening to the session. */
  readonly close: Effect.Effect<void, AcpError>;
}

const needsImage = (prompt: ReadonlyArray<ContentBlock>): boolean =>
  prompt.some((block) => block.type === 'image');

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

  const cancel = request('session/cancel', (agent) =>
    agent.notify('session/cancel', { sessionId }),
  ).pipe(Effect.andThen(dispatcher.cancelPermissions(sessionId)));

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
    cancel,
    setConfigOption,
    close,
  };
};
