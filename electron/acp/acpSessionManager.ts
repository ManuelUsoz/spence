import {
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type Implementation,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Queue,
  Scope,
  Stream,
} from 'effect';
import { version } from '../../package.json';
import type { AgentId } from '../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../agents/catalog';
import type { AgentLaunchError } from '../agents/launch';
import type { MergedPath, PathSources } from '../agents/merged-path';
import { runAgentCommand } from '../agents/spawn';
import { AgentLogs } from './acpAgentLog';
import { makeClientDispatcher } from './acpClientDispatcher';
import { AcpError, acpRequest, requireCapability } from './acpErrors';
import {
  type AcpSession,
  AcpSessionId,
  type AgentChannel,
  makeAcpSession,
  type OpenedSession,
  type SteeringMode,
} from './acpSession';
import { describeExit, openStdioTransport, type AgentExit } from './acpStdioTransport';

/**
 * What Spence offers an Agent: no file system and no terminal; terminal login, and the Compaction and Notice updates
 * it shows in the thread.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  auth: { terminal: true },
  session: { compaction: {}, notices: {} },
};

const CLIENT_INFO: Implementation = { name: 'spence', title: 'Spence', version };

/**
 * The pre-standard `_session/steering` flag: `InitializeResponse._meta.steering.supported`. It lives on the response's
 * own `_meta`, not inside `agentCapabilities._meta`.
 */
const advertisedSteering = (initMeta: unknown): boolean => {
  if (typeof initMeta !== 'object' || initMeta === null || !('steering' in initMeta)) return false;
  const steering = initMeta.steering;
  return (
    typeof steering === 'object' &&
    steering !== null &&
    'supported' in steering &&
    steering.supported === true
  );
};

/** One initialized connection to an Agent process: opens, resumes and deletes its ACP sessions. */
export interface AcpSessionManager {
  readonly agentId: AgentId;
  readonly pid: number | undefined;
  /** What the Agent offers (Images, load, resume, close, delete, ...), as it answered `initialize`. */
  readonly agentCapabilities: AgentCapabilities;
  /** Whether the Agent can redirect a running Turn without cancelling it (extension or native). */
  readonly steeringSupported: boolean;
  readonly authMethods: ReadonlyArray<AuthMethod>;
  readonly agentInfo: Implementation | null;
  readonly newSession: (cwd: string) => Effect.Effect<AcpSession, AcpError>;
  /** `session/load`: the Agent replays the conversation first; the replay is dropped, never in the events. */
  readonly loadSession: (
    sessionId: AcpSessionId,
    cwd: string,
  ) => Effect.Effect<AcpSession, AcpError>;
  /** `session/resume`: restores the Agent's context without a replay. */
  readonly resumeSession: (
    sessionId: AcpSessionId,
    cwd: string,
  ) => Effect.Effect<AcpSession, AcpError>;
  readonly deleteSession: (sessionId: AcpSessionId) => Effect.Effect<void, AcpError>;
  readonly authenticate: (methodId: string) => Effect.Effect<void, AcpError>;
  /** Completes once this Agent process is gone: it exited or crashed, or Spence stopped it. */
  readonly exited: Effect.Effect<void>;
  /** Completes only when the OS process `'exit'` event is observed. */
  readonly processExited: Effect.Effect<AgentExit>;
}

export interface ProcessKillResult {
  readonly pid: number | undefined;
  readonly exitConfirmed: boolean;
}

export interface UnconfirmedAgentExit {
  readonly pid: number | undefined;
  readonly state: 'killTimedOut';
}

type ManagerRequirements = AgentLogs | PathSources | MergedPath;

/**
 * Spawns the Agent, connects our client, and runs `initialize`. Everything lives in the surrounding scope; closing it
 * closes the connection, then stdin, then kills the process tree.
 */
const makeAcpSessionManager = Effect.fn('Acp.connect')(function* (
  entry: CatalogEntry,
  exited: Effect.Effect<void>,
) {
  const transport = yield* openStdioTransport(entry);
  const dispatcher = yield* makeClientDispatcher();
  // Stopped by Spence: whoever still reads a session's events learns the Agent is gone.
  yield* Effect.addFinalizer(() =>
    dispatcher.failAll(new AcpError({ reason: 'Exited', detail: `${entry.name} was stopped` })),
  );
  const connection = dispatcher.app.connect(transport.stream);
  yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));

  const exitError = transport.exited.pipe(
    Effect.map((exit) => {
      const summary = `${entry.name} ended with ${describeExit(exit)}`;
      return new AcpError({
        reason: 'Exited',
        detail: exit.stderrTail ? `${summary}\n${exit.stderrTail}` : summary,
      });
    }),
  );
  /** Completes once the Agent exited and every open session's events failed with it. */
  const gone = yield* Deferred.make<void>();
  yield* exitError.pipe(
    Effect.flatMap(dispatcher.failAll),
    Effect.andThen(Deferred.succeed(gone, undefined)),
    Effect.forkScoped,
  );

  const request: AgentChannel['request'] = (method, send) =>
    acpRequest(method, (signal) => send(connection.agent, signal)).pipe(
      Effect.raceFirst(Effect.flatMap(exitError, Effect.fail)),
      Effect.catchIf(
        (error) => error.reason === 'Exited',
        (error) =>
          exitError.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(200),
              orElse: () => Effect.succeed(error),
            }),
            Effect.flatMap(Effect.fail),
          ),
      ),
    );

  const init = yield* request('initialize', (agent, signal) =>
    agent.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: CLIENT_INFO,
      },
      { cancellationSignal: signal },
    ),
  );
  if (init.protocolVersion !== PROTOCOL_VERSION) {
    return yield* new AcpError({
      reason: 'ProtocolVersion',
      detail: `${entry.name} speaks ACP ${init.protocolVersion}; Spence speaks ${PROTOCOL_VERSION}`,
    });
  }
  const capabilities = init.agentCapabilities ?? {};
  const admissionMeta =
    typeof capabilities._meta === 'object' &&
    capabilities._meta !== null &&
    'spence' in capabilities._meta &&
    typeof capabilities._meta['spence'] === 'object' &&
    capabilities._meta['spence'] !== null
      ? (capabilities._meta['spence'] as {
          readonly supportsAuto?: unknown;
          readonly supportsCancel?: unknown;
          readonly supportsAuthDetection?: unknown;
        })
      : undefined;
  const requiredGates: ReadonlyArray<readonly [boolean, string]> = [
    [
      entry.admission?.supportsAuto !== false && admissionMeta?.supportsAuto !== false,
      `${entry.name} does not support Auto permission mode`,
    ],
    [
      entry.admission?.supportsCancel !== false && admissionMeta?.supportsCancel !== false,
      `${entry.name} does not support turn cancellation`,
    ],
    [
      entry.admission?.supportsAuthDetection !== false &&
        admissionMeta?.supportsAuthDetection !== false,
      `${entry.name} does not report authentication errors (-32000)`,
    ],
  ];
  const failedGate = requiredGates.find(([supported]) => !supported);
  if (failedGate !== undefined) {
    return yield* new AcpError({ reason: 'Unsupported', detail: failedGate[1] });
  }
  const sessionCapabilities = capabilities.sessionCapabilities ?? {};
  const steering: SteeringMode | undefined =
    entry.nativeSteering === true
      ? 'native'
      : advertisedSteering(init._meta)
        ? 'extension'
        : undefined;
  const channel: AgentChannel = { capabilities, steering, dispatcher, request };

  const newSession = Effect.fn('Acp.newSession')(function* (cwd: string) {
    const opened = yield* request('session/new', (agent, signal) =>
      agent.request('session/new', { cwd, mcpServers: [] }, { cancellationSignal: signal }),
    );
    const sessionId = AcpSessionId.make(opened.sessionId);
    const queue = yield* dispatcher.attach(sessionId);
    return makeAcpSession(channel, { ...opened, sessionId }, queue);
  });

  /**
   * Reopens a session the Agent knows: `session/load` and `session/resume` take the same request. The session's events
   * are attached before the request, so a replay or early update is never lost.
   */
  const reopen = (method: 'session/load' | 'session/resume', supported: boolean) =>
    Effect.fn(`Acp.${method}`)(function* (sessionId: AcpSessionId, cwd: string) {
      yield* requireCapability(supported, method);
      const queue = yield* dispatcher.attach(sessionId);
      const opened: Omit<OpenedSession, 'sessionId'> = yield* request(method, (agent, signal) =>
        agent.request(method, { sessionId, cwd, mcpServers: [] }, { cancellationSignal: signal }),
      ).pipe(Effect.tapError(() => dispatcher.detach(sessionId)));
      // The Agent replays the conversation before it answers `session/load`; Spence keeps its own Transcript, so
      // the replay is dropped (spec 4.3) and the events start with what happens next.
      if (method === 'session/load') yield* Queue.clear(queue);
      return makeAcpSession(channel, { ...opened, sessionId }, queue);
    });

  const loadSession = reopen('session/load', capabilities.loadSession === true);
  const resumeSession = reopen('session/resume', Boolean(sessionCapabilities.resume));

  const deleteSession = Effect.fn('Acp.deleteSession')(function* (sessionId: AcpSessionId) {
    yield* requireCapability(Boolean(sessionCapabilities.delete), 'session/delete');
    yield* request('session/delete', (agent, signal) =>
      agent.request('session/delete', { sessionId }, { cancellationSignal: signal }),
    );
    yield* dispatcher.detach(sessionId);
  });

  const authenticate = Effect.fn('Acp.authenticate')(function* (methodId: string) {
    yield* request('authenticate', (agent, signal) =>
      agent.request('authenticate', { methodId }, { cancellationSignal: signal }),
    );
  });

  return {
    manager: {
      agentId: entry.id,
      pid: transport.pid,
      agentCapabilities: capabilities,
      steeringSupported: steering !== undefined,
      authMethods: init.authMethods ?? [],
      agentInfo: init.agentInfo ?? null,
      newSession,
      loadSession,
      resumeSession,
      deleteSession,
      authenticate,
      exited,
      processExited: transport.exited,
    } satisfies AcpSessionManager,
    gone: Deferred.await(gone),
    transport,
  };
});

type Connection = Deferred.Deferred<AcpSessionManager, AcpError | AgentLaunchError>;

/** The ACP client stack: one connection per Agent, started on first use and shared by all its sessions. */
export class AcpClient extends Context.Service<
  AcpClient,
  {
    /**
     * The Agent's initialized connection, spawning the process if it is not running. Memoized per Agent; an Agent
     * that exits (or never came up) is started again on the next call.
     */
    readonly connect: (
      entry: CatalogEntry,
    ) => Effect.Effect<AcpSessionManager, AcpError | AgentLaunchError>;
    /**
     * Stops the Agent's process if it runs: closes the connection and stdin, then kills its tree after a short grace.
     * Completes once the process is gone.
     */
    readonly disconnect: (id: AgentId) => Effect.Effect<void>;
    /**
     * Force-kills the Agent's process tree immediately (skipping stdin close grace) and reports whether OS `'exit'`
     * was observed within the kill timeout.
     */
    readonly kill: (id: AgentId) => Effect.Effect<ProcessKillResult>;
    /** Returns the unconfirmed exit state if a killed Agent process has not emitted `'exit'` yet. */
    readonly unconfirmedExit: (id: AgentId) => Effect.Effect<UnconfirmedAgentExit | undefined>;
    /** Emits an `AgentId` whenever a previously unconfirmed process finally emits `'exit'`. */
    readonly subscribeExitConfirmed: Effect.Effect<Stream.Stream<AgentId>, never, Scope.Scope>;
    /** Runs an advertised login method (`terminal` CLI flow or ACP `authenticate`). */
    readonly login: (
      entry: CatalogEntry,
      method: AuthMethod,
    ) => Effect.Effect<void, AcpError | AgentLaunchError>;
    /** The Agent's already-running initialized connection, if any. Never starts an Agent. */
    readonly connected: (id: AgentId) => Effect.Effect<AcpSessionManager | undefined>;
    /** Emits each `AcpSessionManager` as soon as its `initialize` handshake completes. */
    readonly subscribeInitialized: Effect.Effect<
      Stream.Stream<AcpSessionManager>,
      never,
      Scope.Scope
    >;
  }
>()('acp/AcpClient') {}

export const layerAcpClient = Layer.effect(
  AcpClient,
  Effect.gen(function* () {
    const layerScope = yield* Effect.scope;
    const context = yield* Effect.context<ManagerRequirements>();
    const connections = new Map<AgentId, Connection>();
    /** How to stop each running Agent; set once its connection is up. */
    const stops = new Map<AgentId, Effect.Effect<void>>();
    const kills = new Map<AgentId, Effect.Effect<ProcessKillResult>>();
    const running = new Map<AgentId, AcpSessionManager>();
    const unconfirmed = new Map<
      AgentId,
      { readonly pid: number | undefined; readonly token: symbol }
    >();
    const initializedHub = yield* PubSub.unbounded<AcpSessionManager>();
    const exitConfirmedHub = yield* PubSub.unbounded<AgentId>();

    const forget = (id: AgentId, connection: Connection) =>
      Effect.sync(() => {
        if (connections.get(id) !== connection) return;
        connections.delete(id);
        stops.delete(id);
        kills.delete(id);
        running.delete(id);
      });

    const recordUnconfirmed = Effect.fnUntraced(function* (
      id: AgentId,
      pid: number | undefined,
      exited: Effect.Effect<AgentExit>,
    ) {
      const token = Symbol(id);
      unconfirmed.set(id, { pid, token });
      yield* exited.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (unconfirmed.get(id)?.token !== token) return Effect.void;
            unconfirmed.delete(id);
            return PubSub.publish(exitConfirmedHub, id);
          }),
        ),
        Effect.forkIn(layerScope),
      );
    });

    const start = (entry: CatalogEntry, connection: Connection) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(layerScope);
        const stopped = yield* Deferred.make<void>();
        const exit = yield* makeAcpSessionManager(entry, Deferred.await(stopped)).pipe(
          Scope.provide(scope),
          Effect.provideContext(context),
          Effect.exit,
        );
        if (Exit.isFailure(exit)) {
          yield* forget(entry.id, connection);
          yield* Scope.close(scope, exit);
          return yield* Deferred.failCause(connection, exit.cause);
        }
        const { manager, gone, transport } = exit.value;
        let stopping = false;
        /** Forgets the Agent and closes its scope, once; a second caller waits for the same end. */
        const release = Effect.suspend(() => {
          if (stopping) return Deferred.await(stopped);
          stopping = true;
          return forget(entry.id, connection).pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
            Effect.andThen(transport.isExited),
            Effect.flatMap((exited) =>
              exited ? Effect.void : recordUnconfirmed(entry.id, transport.pid, transport.exited),
            ),
            Effect.andThen(Deferred.succeed(stopped, undefined)),
            Effect.asVoid,
          );
        }).pipe(Effect.uninterruptible);
        // A dead Agent is forgotten and cleaned up; the next `connect` starts a new process.
        const watcher = yield* gone.pipe(Effect.andThen(release), Effect.forkIn(layerScope));
        const stop = Fiber.interrupt(watcher).pipe(Effect.andThen(release));
        stops.set(entry.id, stop);
        kills.set(
          entry.id,
          Effect.gen(function* () {
            transport.skipStdinGrace();
            yield* stop;
            const exited = yield* transport.isExited;
            return { pid: transport.pid, exitConfirmed: exited };
          }),
        );
        running.set(entry.id, manager);
        yield* PubSub.publish(initializedHub, manager);
        return yield* Deferred.succeed(connection, manager);
      }).pipe(Effect.uninterruptible);

    const connect = (entry: CatalogEntry) =>
      Effect.suspend(() => {
        const existing = connections.get(entry.id);
        if (existing !== undefined) return Deferred.await(existing);
        const connection: Connection = Deferred.makeUnsafe();
        connections.set(entry.id, connection);
        return start(entry, connection).pipe(Effect.andThen(Deferred.await(connection)));
      });

    const disconnect = (id: AgentId) => Effect.suspend(() => stops.get(id) ?? Effect.void);
    const kill = (id: AgentId): Effect.Effect<ProcessKillResult> =>
      Effect.suspend(() => {
        const active = kills.get(id);
        if (active !== undefined) return active;
        const pending = unconfirmed.get(id);
        return Effect.succeed({
          pid: pending?.pid,
          exitConfirmed: pending === undefined,
        });
      });
    const unconfirmedExit = (id: AgentId): Effect.Effect<UnconfirmedAgentExit | undefined> =>
      Effect.sync(() => {
        const entry = unconfirmed.get(id);
        return entry === undefined ? undefined : { pid: entry.pid, state: 'killTimedOut' };
      });
    const connected = (id: AgentId) => Effect.sync(() => running.get(id));
    const subscribeInitialized = PubSub.subscribe(initializedHub).pipe(
      Effect.map(Stream.fromSubscription),
    );
    const subscribeExitConfirmed = PubSub.subscribe(exitConfirmedHub).pipe(
      Effect.map(Stream.fromSubscription),
    );

    const login = Effect.fn('Acp.login')(function* (entry: CatalogEntry, method: AuthMethod) {
      if ('type' in method && method.type === 'terminal') {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const log = yield* AgentLogs.use((logs) => logs.open(entry.id));
            const args = [...entry.args, ...(method.args ?? [])];
            log.write(`login ${entry.binary} ${args.join(' ')}`);
            yield* runAgentCommand(
              { binary: entry.binary, args },
              {
                ...(method.env === undefined ? {} : { env: method.env }),
                onLine: (line) => log.write(`login: ${line}`),
              },
            );
          }),
        ).pipe(
          Effect.provide(context),
          Effect.mapError((error: AgentLaunchError): AcpError | AgentLaunchError =>
            error.reason === 'NotInstalled'
              ? error
              : new AcpError({ reason: 'AuthRequired', detail: error.detail }),
          ),
        );
        return;
      }
      const manager = yield* connect(entry);
      yield* manager.authenticate(method.id);
    });

    return {
      connect,
      disconnect,
      kill,
      unconfirmedExit,
      subscribeExitConfirmed,
      login,
      connected,
      subscribeInitialized,
    };
  }),
);
