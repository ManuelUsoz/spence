import { Clock, Context, Effect, Layer, PubSub, Semaphore, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import {
  type LiveState,
  type MessagePart,
  MessageId,
  SessionError,
  SessionId,
  type SessionStreamItem,
  type TranscriptItem,
  TurnId,
  type TurnOutcome,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpSessionEvent } from '../acp/acpClientDispatcher';
import type { AcpError } from '../acp/acpErrors';
import { foldUpdate, openTurn, promptOutcome, toAcpPrompt, type TurnFold } from '../acp/acpMappers';
import {
  AgentLifetime,
  type OpenAcpSession,
  type OpenedAcpSession,
  type OpenError,
} from '../acp/acpLifetime';
import type { AcpSession } from '../acp/acpSession';
import { AcpClient } from '../acp/acpSessionManager';
import { Projects } from '../projects/projects';
import { Settings } from '../settings/settings';
import { SessionAgent } from './session-agent';
import { SessionStore, type SessionMeta } from './session-store';

export interface SessionsShape {
  /** Starts a draft Session in the Project and, at once, its Agent and ACP session. Nothing is kept until a prompt. */
  readonly create: (projectId: ProjectId) => Effect.Effect<SessionId, SessionError>;
  /** Starts a Turn with the user's Message once the Agent is ready; `Busy` while a Turn runs. */
  readonly prompt: (
    id: SessionId,
    parts: ReadonlyArray<MessagePart>,
  ) => Effect.Effect<TurnId, SessionError>;
  /** Asks the Agent to stop the running Turn; nothing when none runs. */
  readonly cancel: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** The live state, then the Transcript after `afterSeq`, then everything live; no `seq` twice. */
  readonly events: (
    id: SessionId,
    afterSeq?: number,
  ) => Stream.Stream<SessionStreamItem, SessionError>;
}

/** The Sessions this run has open: ACP stack, Transcript store and Projects joined. */
export class Sessions extends Context.Service<Sessions, SessionsShape>()('sessions/Sessions') {}

/**
 * A Session open in this run. The fields below `lock` are mutable on purpose: they are the live state of a running
 * Session (its ACP session, its Turn), changed only by this module's fibers.
 */
interface LiveSession {
  readonly meta: SessionMeta;
  /** Non-blocking: publishing never waits for a subscriber, so a stuck renderer never stalls the Agent. */
  readonly hub: PubSub.PubSub<SessionStreamItem>;
  /** Appends and publishes one batch at a time, so subscribers see events in `seq` order. */
  readonly lock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  state: LiveState;
  /** The ACP session whose events are read; unset while the Session has none (`AgentLifetime` decides). */
  acp: AcpSession | undefined;
  /** A Turn has started: the Session is kept, and the Agent's memory holds it, so a later ACP session loses it. */
  prompted: boolean;
  running: TurnFold | undefined;
  /** The ACP session the running Turn's prompt went to; unset while the Turn still waits for its Agent. */
  prompting: AcpSession | undefined;
  /** The user stopped the running Turn before its prompt went out: it ends cancelled instead. */
  stopRequested: boolean;
}

const notFound = (id: SessionId) =>
  new SessionError({ reason: 'NotFound', detail: `no open Session ${id}` });

/** Why the Agent could not open an ACP session, as an Agent status and a `SessionError`. */
const unavailable = (error: OpenError) => {
  const why = (() => {
    if (error._tag === 'AgentLaunchError' && error.reason === 'NotInstalled') {
      return { status: 'notInstalled', reason: 'AgentNotInstalled' } as const;
    }
    if (error._tag === 'AcpError' && error.reason === 'AuthRequired') {
      return { status: 'needsLogin', reason: 'AgentNeedsLogin' } as const;
    }
    return { status: 'cantStart', reason: 'AgentCantStart' } as const;
  })();
  return {
    status: why.status,
    error: new SessionError({ reason: why.reason, detail: error.detail }),
  };
};

export const layerSessions = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const acpClient = yield* AcpClient;
    const lifetime = yield* AgentLifetime;
    const store = yield* SessionStore;
    const projects = yield* Projects;
    const settings = yield* Settings;
    const agent = yield* SessionAgent;
    const open = new Map<SessionId, LiveSession>();

    const lookup = (id: SessionId) =>
      Effect.suspend(() => {
        const session = open.get(id);
        return session === undefined ? Effect.fail(notFound(id)) : Effect.succeed(session);
      });

    const setState = (session: LiveSession, patch: Partial<LiveState>) =>
      Effect.suspend(() => {
        session.state = { ...session.state, ...patch };
        return PubSub.publish(session.hub, { _tag: 'Live', state: session.state });
      });

    /** Numbers the items as the Session's next Transcript events and publishes them. */
    const append = (session: LiveSession, items: ReadonlyArray<TranscriptItem>) =>
      session.lock(
        store.append(session.meta.id, items).pipe(
          Effect.flatMap((events) =>
            PubSub.publishAll(
              session.hub,
              events.map((event) => ({ _tag: 'Transcript', event }) as const),
            ),
          ),
          Effect.orDie,
        ),
      );

    const endTurn = Effect.fnUntraced(function* (session: LiveSession, outcome: TurnOutcome) {
      const running = session.running;
      if (running === undefined) return;
      session.running = undefined;
      session.prompting = undefined;
      session.stopRequested = false;
      // Released before the end is published: whoever sees it sees the Turn no longer working.
      yield* lifetime.turnEnded(session.meta.id);
      yield* append(session, [{ _tag: 'TurnEnded', turnId: running.turnId, outcome }]);
      yield* store.flush(session.meta.id).pipe(Effect.orDie);
    });

    const onEvent = Effect.fnUntraced(function* (session: LiveSession, event: AcpSessionEvent) {
      switch (event._tag) {
        case 'Update': {
          if (session.running === undefined) return;
          const [fold, items] = foldUpdate(session.running, event.update, randomUUID);
          session.running = fold;
          return yield* append(session, items);
        }
        case 'PermissionRequest':
          // Not shown yet: it stays pending until the user stops the Turn, which answers it `cancelled`.
          return;
        case 'PromptEnded':
          return yield* endTurn(session, promptOutcome(event.result));
      }
    });

    /** The ACP session is gone (closed, or its Agent stopped): the next Turn opens another. */
    const detach = (session: LiveSession, acp: AcpSession) =>
      Effect.sync(() => {
        if (session.acp === acp) session.acp = undefined;
      });

    /** Reads the ACP session's events for as long as it lives; a dead Agent fails the running Turn. */
    const read = (session: LiveSession, acp: AcpSession) =>
      acp.events.pipe(
        Stream.runForEach((event) => onEvent(session, event)),
        Effect.andThen(detach(session, acp)),
        Effect.catch(
          Effect.fnUntraced(function* (error: AcpError) {
            yield* detach(session, acp);
            yield* setState(session, { agentStatus: 'stopped' });
            yield* endTurn(session, {
              _tag: 'failed',
              reason: 'agentStopped',
              detail: error.detail,
            });
          }),
        ),
      );

    /**
     * Starts reading a newly opened ACP session. Until its first Turn the Session is a draft: the store holds it in
     * memory with this ACP session, and nothing is written. After that, a new ACP session means the Agent's memory
     * of the Session is lost, which the Transcript marks.
     */
    const attach = Effect.fnUntraced(function* (session: LiveSession, opened: OpenedAcpSession) {
      if (session.prompted) {
        // TODO(reopen ticket): record the new ACP session id in session.json too.
        yield* append(session, [{ _tag: 'ContextCleared', reason: 'lost' }]);
      } else {
        yield* store.createDraft({ ...session.meta, acpSessionIds: [opened.session.sessionId] });
      }
      session.acp = opened.session;
      yield* Effect.forkIn(read(session, opened.session), scope);
      yield* setState(session, {
        agentStatus: 'ready',
        canAttachImages: opened.manager.agentCapabilities.promptCapabilities?.image === true,
      });
    });

    /**
     * How `AgentLifetime` opens the Session's ACP session: starts the Agent (memoized per Agent) and runs `session/new`
     * in the Session's folder.
     */
    const openAcp = (session: LiveSession): OpenAcpSession =>
      setState(session, { agentStatus: 'starting' }).pipe(
        Effect.andThen(acpClient.connect(agent)),
        Effect.flatMap((manager) =>
          manager
            .newSession(session.meta.cwd)
            .pipe(Effect.map((acp) => ({ manager, session: acp }))),
        ),
        Effect.tap((opened) => attach(session, opened)),
        Effect.tapError((error) => setState(session, { agentStatus: unavailable(error).status })),
      );

    const create = Effect.fn('Sessions.create')(function* (projectId: ProjectId) {
      const project = yield* projects
        .check(projectId)
        .pipe(
          Effect.mapError(
            (error) => new SessionError({ reason: 'NotFound', detail: error.detail }),
          ),
        );
      const { defaultPermissionMode } = yield* settings.get;
      const permissionMode = project.settings.defaultPermissionMode ?? defaultPermissionMode;
      const now = yield* Clock.currentTimeMillis;
      const id = SessionId.make(randomUUID());
      const session: LiveSession = {
        meta: {
          id,
          projectId,
          cwd: project.path,
          agentId: agent.id,
          autoTitleIsPlaceholder: false,
          createdAt: now,
          lastActivityAt: now,
          acpSessionIds: [],
          permissionMode,
        },
        hub: yield* PubSub.unbounded<SessionStreamItem>(),
        lock: (yield* Semaphore.make(1)).withPermit,
        state: {
          agentStatus: 'starting',
          title: { autoIsPlaceholder: false },
          options: { permissionMode },
          commands: [],
          canAttachImages: false,
          imageLimits: agent.imageLimits,
          agentName: agent.name,
        },
        acp: undefined,
        prompted: false,
        running: undefined,
        prompting: undefined,
        stopRequested: false,
      };
      open.set(id, session);
      // A new Session is shown in a Tab at once (spec 4.1): the Agent and its ACP session start now, so the Composer
      // is ready by the time the user has typed. The Tabs issue reports closing it.
      yield* lifetime.tabActivated(id, openAcp(session)).pipe(Effect.ignore, Effect.forkIn(scope));
      return id;
    });

    const prompt = Effect.fn('Sessions.prompt')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
    ) {
      const session = yield* lookup(id);
      const turnId = TurnId.make(randomUUID());
      const busy = yield* Effect.sync(() => {
        if (session.running !== undefined) return true;
        session.running = openTurn(turnId);
        return false;
      });
      if (busy) return yield* new SessionError({ reason: 'Busy', detail: 'a Turn is running' });
      // Opens the ACP session (starting the Agent) if the Session has none, and holds it open until the Turn ends.
      const acp = yield* lifetime.turnStarted(id, openAcp(session)).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            session.running = undefined;
            session.stopRequested = false;
          }),
        ),
        Effect.mapError((error) => unavailable(error).error),
      );
      // Set before the first event is published, so a subscriber from now on replays it from the store.
      session.prompted = true;
      yield* append(session, [
        { _tag: 'TurnStarted', turnId, permissionMode: session.state.options.permissionMode },
        { _tag: 'Message', id: MessageId.make(randomUUID()), turnId, role: 'user', parts },
      ]);
      yield* projects.touch(session.meta.projectId);
      // Stopped while the Agent was starting: the prompt never goes out.
      const stopped = yield* Effect.sync(() => {
        if (session.stopRequested) return true;
        session.prompting = acp;
        return false;
      });
      if (stopped) {
        yield* endTurn(session, { _tag: 'cancelled' });
        return turnId;
      }
      // How it ends arrives on the ACP session's events, behind the Turn's updates.
      yield* Effect.forkIn(acp.prompt(toAcpPrompt(parts)).pipe(Effect.ignore), scope);
      return turnId;
    });

    const cancel = Effect.fn('Sessions.cancel')(function* (id: SessionId) {
      const session = yield* lookup(id);
      const prompting = yield* Effect.sync(() => {
        if (session.running === undefined) return undefined;
        if (session.prompting === undefined) session.stopRequested = true;
        return session.prompting;
      });
      // A failed cancel means the Agent is gone; its events report that.
      if (prompting !== undefined) yield* prompting.cancel.pipe(Effect.ignore);
    });

    const events = (id: SessionId, afterSeq = 0) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* lookup(id);
          // Subscribed before the replay is read: nothing appended in between is missed, only seen twice.
          const live = yield* PubSub.subscribe(session.hub);
          const state = session.state;
          // Before its first Turn a draft has no events (and may not be in the store yet).
          const replayed = session.prompted ? yield* store.replay(id, afterSeq) : [];
          let lastSeq = replayed.at(-1)?.seq ?? afterSeq;
          return Stream.concat(
            Stream.fromIterable<SessionStreamItem>([
              { _tag: 'Live', state },
              ...replayed.map((event) => ({ _tag: 'Transcript', event }) as const),
            ]),
            Stream.fromSubscription(live).pipe(
              Stream.filter((item) => {
                if (item._tag === 'Live') return true;
                if (item.event.seq <= lastSeq) return false;
                lastSeq = item.event.seq;
                return true;
              }),
            ),
          );
        }),
      );

    return Sessions.of({ create, prompt, cancel, events });
  }),
);
