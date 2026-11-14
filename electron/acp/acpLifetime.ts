import { Context, Deferred, Duration, Effect, Fiber, Layer, type Scope, type Stream } from 'effect';
import type { AgentId } from '../../src/shared/agents/agents.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { AgentLaunchError } from '../agents/launch';
import type { AcpError } from './acpErrors';
import type { AcpSession } from './acpSession';
import { AcpClient, type AcpSessionManager, type ProcessKillResult } from './acpSessionManager';

/** How long an Agent process stays up with zero ACP sessions before Spence stops it. */
export const AGENT_IDLE_EXIT = Duration.minutes(5);

/** An open ACP session and the Agent connection it lives on. */
export interface OpenedAcpSession {
  readonly manager: AcpSessionManager;
  readonly session: AcpSession;
}

export type OpenError = AcpError | AgentLaunchError;

/** How a Session gets its ACP session when it has none: new, resumed or loaded, as the Sessions code decides. */
export type OpenAcpSession = Effect.Effect<OpenedAcpSession, OpenError>;

export type ExitGateProcessState = 'stopping' | 'killTimedOut' | 'cancelPending';

export type ExitGateState =
  | { readonly clear: true }
  | {
      readonly clear: false;
      readonly agentId: AgentId;
      readonly pid: number | undefined;
      readonly state: ExitGateProcessState;
      readonly detail: string;
    };

export const formatExitGateDetail = (
  agentId: AgentId,
  pid: number | undefined,
  state: ExitGateProcessState,
): string => {
  const pidLabel = pid === undefined ? 'unknown' : String(pid);
  switch (state) {
    case 'stopping':
      return `Agent ${agentId} (PID ${pidLabel}, state: stopping) is still stopping`;
    case 'killTimedOut':
      return `Agent ${agentId} (PID ${pidLabel}, state: killTimedOut) did not confirm exit within the kill timeout`;
    case 'cancelPending':
      return `Agent ${agentId} (PID ${pidLabel}, state: cancelPending) has an unsettled cancel`;
  }
};

/**
 * When ACP sessions and Agent processes live. The Sessions code reports what its Tabs and Turns do; this decides
 * when an ACP session opens and closes, and when an Agent process stops.
 *
 * - An ACP session stays open while its Session has an open Tab or a running Turn; then it is closed.
 * - An Agent process stops after `AGENT_IDLE_EXIT` with zero ACP sessions.
 * - A crashed Agent is not restarted: its Sessions lose their ACP sessions, and the next `tabActivated` or
 *   `turnStarted` opens them again (which starts the process).
 */
export class AgentLifetime extends Context.Service<
  AgentLifetime,
  {
    /** A Tab for the Session is open but not shown (restored at app start): nothing connects yet. */
    readonly tabOpened: (id: SessionId) => Effect.Effect<void>;
    /** The Session's Tab is shown: opens its ACP session (with `open`) unless it has one. */
    readonly tabActivated: (
      id: SessionId,
      open: OpenAcpSession,
      agentId?: AgentId,
    ) => Effect.Effect<AcpSession, OpenError>;
    readonly tabClosed: (id: SessionId) => Effect.Effect<void>;
    /** A Turn starts: opens the ACP session (with `open`) unless it has one, and holds it open until the Turn ends. */
    readonly turnStarted: (
      id: SessionId,
      open: OpenAcpSession,
      agentId?: AgentId,
    ) => Effect.Effect<AcpSession, OpenError>;
    readonly turnEnded: (id: SessionId) => Effect.Effect<void>;
    /**
     * Swaps the Session's ACP session for a fresh one (Clear): closes the one it has, if any, and opens another with
     * `open`. What holds it open stays as it was.
     */
    readonly replace: (id: SessionId, open: OpenAcpSession) => Effect.Effect<AcpSession, OpenError>;
    /** Other Sessions on the same Agent process that currently have a running Turn. */
    readonly otherWorking: (
      id: SessionId,
      agentId?: AgentId,
    ) => Effect.Effect<ReadonlyArray<SessionId>>;
    /** Force-kills the Agent process tree and drops its open ACP sessions cleanly. */
    readonly killAgent: (id: AgentId) => Effect.Effect<ProcessKillResult>;
    /** Marks that `session/cancel` was sent for `id` and is awaiting `PromptEnded` or process `'exit'`. */
    readonly markCancelPending: (id: SessionId, agentId: AgentId) => Effect.Effect<void>;
    /** Clears cancel-pending state for `id` after clean `PromptEnded` or Turn settlement. */
    readonly markCancelSettled: (id: SessionId) => Effect.Effect<void>;
    /** Reusable observed-exit / clean-cancel gate check for handoffs, switches, Forks, and retries. */
    readonly exitGateState: (target: {
      readonly agentId?: AgentId;
      readonly sessionId?: SessionId;
    }) => Effect.Effect<ExitGateState>;
    /** Emits an `AgentId` whenever a previously unconfirmed Agent process finally emits `'exit'`. */
    readonly subscribeExitConfirmed: Effect.Effect<Stream.Stream<AgentId>, never, Scope.Scope>;
    /** How many Sessions have a running Turn (also one waiting on a Permission request): what quitting would stop. */
    readonly working: Effect.Effect<number>;
    /**
     * Before the app quits: `session/cancel` every running Turn, then stop every Agent (close stdin, kill the tree
     * after a short grace). Completes once the processes are gone.
     */
    readonly quit: Effect.Effect<void>;
  }
>()('acp/AgentLifetime') {}

// `Entry` and `Agent` are mutable on purpose: they are the live bookkeeping of running processes and ACP sessions,
// changed only inside this layer.

/** What holds a Session's ACP session open, and that session. */
interface Entry {
  tab: boolean;
  turn: boolean;
  agentId: AgentId | undefined;
  /** The ACP session, once opening started; `undefined` while it has none. */
  opened: Deferred.Deferred<OpenedAcpSession, OpenError> | undefined;
  /** The ACP session once it is open. */
  live: OpenedAcpSession | undefined;
}

/** A running Agent process. */
interface Agent {
  readonly manager: AcpSessionManager;
  /** Counts down to stopping the process while it has zero ACP sessions. */
  idle: Fiber.Fiber<void> | undefined;
}

export const layerAgentLifetime = Layer.effect(
  AgentLifetime,
  Effect.gen(function* () {
    const client = yield* AcpClient;
    const layerScope = yield* Effect.scope;
    const entries = new Map<SessionId, Entry>();
    const agents = new Map<AgentId, Agent>();
    const stoppingAgents = new Map<AgentId, number | undefined>();
    const cancelPending = new Map<SessionId, AgentId>();

    const entry = (id: SessionId): Entry => {
      const existing = entries.get(id);
      if (existing !== undefined) return existing;
      const created: Entry = {
        tab: false,
        turn: false,
        agentId: undefined,
        opened: undefined,
        live: undefined,
      };
      entries.set(id, created);
      return created;
    };

    const sessionsOn = (manager: AcpSessionManager): number =>
      [...entries.values()].filter((current) => current.live?.manager === manager).length;

    const stopIdleTimer = (agent: Agent) =>
      Effect.suspend(() => {
        const idle = agent.idle;
        agent.idle = undefined;
        return idle === undefined ? Effect.void : Fiber.interrupt(idle);
      });

    /** Starts counting down to stopping the Agent when it has no ACP session left. */
    const startIdleTimer = Effect.fnUntraced(function* (manager: AcpSessionManager) {
      const agent = agents.get(manager.agentId);
      if (agent?.manager !== manager || agent.idle !== undefined) return;
      if (sessionsOn(manager) > 0) return;
      agent.idle = yield* Effect.sleep(AGENT_IDLE_EXIT).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            agent.idle = undefined;
            return client.disconnect(manager.agentId);
          }).pipe(Effect.uninterruptible),
        ),
        Effect.forkIn(layerScope),
      );
    });

    /** The Agent is gone: its Sessions lose their ACP sessions, and open them again when next needed. */
    const agentExited = (manager: AcpSessionManager) =>
      Effect.suspend(() => {
        for (const current of entries.values()) {
          if (current.live?.manager !== manager) continue;
          current.live = undefined;
          current.opened = undefined;
        }
        for (const [sessionId, pendingAgentId] of cancelPending.entries()) {
          if (pendingAgentId === manager.agentId) cancelPending.delete(sessionId);
        }
        const agent = agents.get(manager.agentId);
        if (agent?.manager !== manager) return Effect.void;
        agents.delete(manager.agentId);
        return stopIdleTimer(agent);
      });

    /** Records that an ACP session opened on `manager`: the Agent is not idle, and its exit is watched. */
    const sessionOpened = Effect.fnUntraced(function* (manager: AcpSessionManager) {
      const known = agents.get(manager.agentId);
      if (known?.manager === manager) return yield* stopIdleTimer(known);
      agents.set(manager.agentId, { manager, idle: undefined });
      yield* manager.exited.pipe(Effect.andThen(agentExited(manager)), Effect.forkIn(layerScope));
    });

    /** Closes the Session's ACP session once nothing holds it open any more. */
    const settle = (id: SessionId) =>
      Effect.suspend(() => {
        const current = entries.get(id);
        if (current === undefined || current.tab || current.turn) return Effect.void;
        entries.delete(id);
        const opened = current.opened;
        if (opened === undefined) return Effect.void;
        return Deferred.await(opened).pipe(
          Effect.flatMap(({ manager, session }) =>
            session.close.pipe(Effect.ignore, Effect.andThen(startIdleTimer(manager))),
          ),
          Effect.ignore,
        );
      });

    const ensureOpen = (id: SessionId, open: OpenAcpSession) =>
      Effect.suspend(() => {
        const current = entry(id);
        if (current.opened !== undefined) return Deferred.await(current.opened);
        const opened = Deferred.makeUnsafe<OpenedAcpSession, OpenError>();
        current.opened = opened;
        return open.pipe(
          Effect.tap((live) =>
            Effect.suspend(() => {
              if (current.opened === opened) {
                current.live = live;
                current.agentId = live.manager.agentId;
              }
              return sessionOpened(live.manager);
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              if (current.opened === opened) current.opened = undefined;
            }),
          ),
          Effect.onExit((exit) => Deferred.done(opened, exit)),
          Effect.uninterruptible,
        );
      }).pipe(Effect.map(({ session }) => session));

    const turnEnded = (id: SessionId) =>
      Effect.suspend(() => {
        const current = entries.get(id);
        if (current !== undefined) current.turn = false;
        return settle(id);
      });

    const otherWorking = (id: SessionId, explicitAgentId?: AgentId) =>
      Effect.sync((): ReadonlyArray<SessionId> => {
        const self = entries.get(id);
        const manager = self?.live?.manager;
        const targetAgentId = explicitAgentId ?? manager?.agentId ?? self?.agentId;
        if (targetAgentId === undefined && manager === undefined) return [];
        const others: Array<SessionId> = [];
        for (const [otherId, current] of entries.entries()) {
          if (otherId === id || !current.turn) continue;
          const matchesManager = manager !== undefined && current.live?.manager === manager;
          const matchesAgent =
            targetAgentId !== undefined &&
            (current.live?.manager.agentId === targetAgentId || current.agentId === targetAgentId);
          if (matchesManager || matchesAgent) others.push(otherId);
        }
        return others;
      });

    const killAgent = Effect.fn('AgentLifetime.killAgent')(function* (id: AgentId) {
      const active = agents.get(id);
      stoppingAgents.set(id, active?.manager.pid);
      return yield* Effect.gen(function* () {
        if (active !== undefined) {
          yield* stopIdleTimer(active);
          agents.delete(id);
        }
        for (const current of entries.values()) {
          if (current.live?.manager.agentId === id || current.agentId === id) {
            current.live = undefined;
            current.opened = undefined;
          }
        }
        const result = yield* client.kill(id);
        for (const [sessionId, pendingAgentId] of cancelPending.entries()) {
          if (pendingAgentId === id) cancelPending.delete(sessionId);
        }
        return result;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stoppingAgents.delete(id);
          }),
        ),
      );
    });

    const markCancelPending = (id: SessionId, agentId: AgentId) =>
      Effect.sync(() => {
        cancelPending.set(id, agentId);
      });

    const markCancelSettled = (id: SessionId) =>
      Effect.sync(() => {
        cancelPending.delete(id);
      });

    const exitGateState = Effect.fnUntraced(function* (target: {
      readonly agentId?: AgentId;
      readonly sessionId?: SessionId;
    }): Effect.fn.Return<ExitGateState> {
      const sessionEntry =
        target.sessionId === undefined ? undefined : entries.get(target.sessionId);
      const pendingAgent =
        target.sessionId === undefined ? undefined : cancelPending.get(target.sessionId);
      const agentId = target.agentId ?? sessionEntry?.agentId ?? pendingAgent;
      if (agentId !== undefined) {
        if (stoppingAgents.has(agentId)) {
          const pid = stoppingAgents.get(agentId);
          return {
            clear: false,
            agentId,
            pid,
            state: 'stopping',
            detail: formatExitGateDetail(agentId, pid, 'stopping'),
          };
        }
        const unconfirmed = yield* client.unconfirmedExit(agentId);
        if (unconfirmed !== undefined) {
          return {
            clear: false,
            agentId,
            pid: unconfirmed.pid,
            state: unconfirmed.state,
            detail: formatExitGateDetail(agentId, unconfirmed.pid, unconfirmed.state),
          };
        }
      }
      if (pendingAgent !== undefined) {
        const pid = agents.get(pendingAgent)?.manager.pid;
        return {
          clear: false,
          agentId: pendingAgent,
          pid,
          state: 'cancelPending',
          detail: formatExitGateDetail(pendingAgent, pid, 'cancelPending'),
        };
      }
      return { clear: true };
    });

    const working = Effect.sync(
      () => [...entries.values()].filter((current) => current.turn).length,
    );

    const quit = Effect.gen(function* () {
      const running = [...entries.values()].flatMap((current) =>
        current.turn && current.live !== undefined ? [current.live.session] : [],
      );
      yield* Effect.forEach(running, (session) => Effect.ignore(session.cancel), {
        concurrency: 'unbounded',
        discard: true,
      });
      yield* Effect.forEach(
        [...agents.values()],
        (agent) =>
          stopIdleTimer(agent).pipe(Effect.andThen(client.disconnect(agent.manager.agentId))),
        { concurrency: 'unbounded', discard: true },
      );
    });

    return {
      working,
      quit,
      otherWorking,
      killAgent,
      markCancelPending,
      markCancelSettled,
      exitGateState,
      subscribeExitConfirmed: client.subscribeExitConfirmed,
      tabOpened: (id) =>
        Effect.sync(() => {
          entry(id).tab = true;
        }),
      tabActivated: (id, open, agentId) =>
        Effect.suspend(() => {
          const current = entry(id);
          current.tab = true;
          if (agentId !== undefined) current.agentId = agentId;
          return ensureOpen(id, open);
        }),
      tabClosed: (id) =>
        Effect.suspend(() => {
          const current = entries.get(id);
          if (current !== undefined) current.tab = false;
          return settle(id);
        }),
      turnStarted: (id, open, agentId) =>
        Effect.suspend(() => {
          const current = entry(id);
          current.turn = true;
          if (agentId !== undefined) current.agentId = agentId;
          return ensureOpen(id, open);
        }).pipe(Effect.tapError(() => turnEnded(id))),
      turnEnded,
      replace: (id, open) =>
        Effect.suspend(() => {
          const current = entry(id);
          const previous = current.opened;
          current.opened = undefined;
          current.live = undefined;
          // Its Agent keeps running: the fresh session opens on it at once, so no idle countdown starts.
          const close =
            previous === undefined
              ? Effect.void
              : Deferred.await(previous).pipe(
                  Effect.flatMap(({ session }) => session.close),
                  Effect.ignore,
                );
          return close.pipe(Effect.andThen(ensureOpen(id, open)));
        }),
    };
  }),
);
