import {
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type Implementation,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { Context, Deferred, Effect, Exit, Fiber, Layer, Queue, Scope } from 'effect';
import { version } from '../../package.json';
import type { AgentId } from '../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../agents/catalog';
import type { AgentLaunchError } from '../agents/launch';
import type { MergedPath, PathSources } from '../agents/merged-path';
import type { AgentLogs } from './acpAgentLog';
import { makeClientDispatcher } from './acpClientDispatcher';
import { AcpError, acpRequest, requireCapability } from './acpErrors';
import {
  type AcpSession,
  AcpSessionId,
  type AgentChannel,
  makeAcpSession,
  type OpenedSession,
} from './acpSession';
import { describeExit, openStdioTransport } from './acpStdioTransport';

/**
 * What Spence offers an Agent: no file system and no terminal; terminal login, and the Compaction and Notice updates
 * it shows in the thread.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {
  auth: { terminal: true },
  session: { compaction: {}, notices: {} },
};

const CLIENT_INFO: Implementation = { name: 'spence', title: 'Spence', version };

/** One initialized connection to an Agent process: opens, resumes and deletes its ACP sessions. */
export interface AcpSessionManager {
  readonly agentId: AgentId;
  /** What the Agent offers (Images, load, resume, close, delete, ...), as it answered `initialize`. */
  readonly agentCapabilities: AgentCapabilities;
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
  /** Completes once this Agent process is gone: it exited or crashed, or Spence stopped it. */
  readonly exited: Effect.Effect<void>;
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
    Effect.map(
      (exit) =>
        new AcpError({
          reason: 'Exited',
          detail: `${entry.name} ended with ${describeExit(exit)}`,
        }),
    ),
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
  const sessionCapabilities = capabilities.sessionCapabilities ?? {};
  const channel: AgentChannel = { capabilities, dispatcher, request };

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

  return {
    manager: {
      agentId: entry.id,
      agentCapabilities: capabilities,
      authMethods: init.authMethods ?? [],
      agentInfo: init.agentInfo ?? null,
      newSession,
      loadSession,
      resumeSession,
      deleteSession,
      exited,
    } satisfies AcpSessionManager,
    gone: Deferred.await(gone),
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

    const forget = (id: AgentId, connection: Connection) =>
      Effect.sync(() => {
        if (connections.get(id) !== connection) return;
        connections.delete(id);
        stops.delete(id);
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
        const { manager, gone } = exit.value;
        let stopping = false;
        /** Forgets the Agent and closes its scope, once; a second caller waits for the same end. */
        const release = Effect.suspend(() => {
          if (stopping) return Deferred.await(stopped);
          stopping = true;
          return forget(entry.id, connection).pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
            Effect.andThen(Deferred.succeed(stopped, undefined)),
            Effect.asVoid,
          );
        }).pipe(Effect.uninterruptible);
        // A dead Agent is forgotten and cleaned up; the next `connect` starts a new process.
        const watcher = yield* gone.pipe(Effect.andThen(release), Effect.forkIn(layerScope));
        stops.set(entry.id, Fiber.interrupt(watcher).pipe(Effect.andThen(release)));
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

    return { connect, disconnect };
  }),
);
