import { Context, Deferred, Effect, Layer } from 'effect';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import type { AgentLaunchError } from '../agents/launch';
import type { AcpError } from './acpErrors';
import type { AcpSession } from './acpSession';
import type { AcpSessionManager } from './acpSessionManager';

/** An open ACP session and the Agent connection it lives on. */
export interface OpenedAcpSession {
  readonly manager: AcpSessionManager;
  readonly session: AcpSession;
}

export type OpenError = AcpError | AgentLaunchError;

/** How a Session gets its ACP session when it has none: new, resumed or loaded, as the Sessions code decides. */
export type OpenAcpSession = Effect.Effect<OpenedAcpSession, OpenError>;

/**
 * When ACP sessions and Agent processes live. The Sessions code reports what its Tabs and Turns do; this decides
 * when an ACP session opens and closes. An ACP session stays open while its Session has an open Tab or a running Turn.
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
    ) => Effect.Effect<AcpSession, OpenError>;
    readonly tabClosed: (id: SessionId) => Effect.Effect<void>;
    /** A Turn starts: opens the ACP session (with `open`) unless it has one, and holds it open until the Turn ends. */
    readonly turnStarted: (
      id: SessionId,
      open: OpenAcpSession,
    ) => Effect.Effect<AcpSession, OpenError>;
    readonly turnEnded: (id: SessionId) => Effect.Effect<void>;
  }
>()('acp/AgentLifetime') {}

interface Entry {
  tab: boolean;
  turn: boolean;
  /** The ACP session, once opening started; `undefined` while it has none. */
  opened: Deferred.Deferred<OpenedAcpSession, OpenError> | undefined;
}

export const layerAgentLifetime = Layer.effect(
  AgentLifetime,
  Effect.gen(function* () {
    const entries = new Map<SessionId, Entry>();

    const entry = (id: SessionId): Entry => {
      const existing = entries.get(id);
      if (existing !== undefined) return existing;
      const created: Entry = { tab: false, turn: false, opened: undefined };
      entries.set(id, created);
      return created;
    };

    /** Closes the Session's ACP session once nothing holds it open any more. */
    const settle = (id: SessionId) =>
      Effect.suspend(() => {
        const current = entries.get(id);
        if (current === undefined || current.tab || current.turn) return Effect.void;
        entries.delete(id);
        const opened = current.opened;
        if (opened === undefined) return Effect.void;
        return Deferred.await(opened).pipe(
          Effect.flatMap(({ session }) => session.close),
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
          Effect.onExit((exit) => Deferred.done(opened, exit)),
          Effect.tapError(() =>
            Effect.sync(() => {
              if (current.opened === opened) current.opened = undefined;
            }),
          ),
          Effect.uninterruptible,
        );
      }).pipe(Effect.map(({ session }) => session));

    const turnEnded = (id: SessionId) =>
      Effect.suspend(() => {
        const current = entries.get(id);
        if (current !== undefined) current.turn = false;
        return settle(id);
      });

    return {
      tabOpened: (id) =>
        Effect.sync(() => {
          entry(id).tab = true;
        }),
      tabActivated: (id, open) =>
        Effect.suspend(() => {
          entry(id).tab = true;
          return ensureOpen(id, open);
        }),
      tabClosed: (id) =>
        Effect.suspend(() => {
          const current = entries.get(id);
          if (current !== undefined) current.tab = false;
          return settle(id);
        }),
      turnStarted: (id, open) =>
        Effect.suspend(() => {
          entry(id).turn = true;
          return ensureOpen(id, open);
        }).pipe(Effect.tapError(() => turnEnded(id))),
      turnEnded,
    };
  }),
);
