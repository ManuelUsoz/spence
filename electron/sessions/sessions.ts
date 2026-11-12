import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Semaphore,
  Stream,
} from 'effect';
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
import {
  failedOutcome,
  foldUpdate,
  openTurn,
  outcomeOf,
  toAcpPrompt,
  type TurnFold,
} from '../acp/acpMappers';
import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { AcpSession } from '../acp/acpSession';
import { AcpClient } from '../acp/acpSessionManager';
import type { CatalogEntry } from '../agents/catalog';
import type { AgentLaunchError } from '../agents/launch';
import { Projects } from '../projects/projects';
import { Settings } from '../settings/settings';
import { SessionStore, type SessionMeta } from './session-store';

/** The Agent new Sessions run with: Claude in v1, the fake Agent under e2e. */
export class SessionAgent extends Context.Service<SessionAgent, CatalogEntry>()(
  'sessions/SessionAgent',
) {}

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

type Started = Deferred.Deferred<AcpSession, SessionError>;

/** A Session open in this run. */
interface Open {
  readonly meta: SessionMeta;
  /** Non-blocking: publishing never waits for a subscriber, so a stuck renderer never stalls the Agent. */
  readonly hub: PubSub.PubSub<SessionStreamItem>;
  /** Appends and publishes one batch at a time, so subscribers see events in `seq` order. */
  readonly lock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  state: LiveState;
  /** The ACP session, once started; unset before the first start and after the Agent stopped or never came up. */
  acp: Started | undefined;
  /** The ACP session has been replaced since the first one: the Agent's memory starts over. */
  restarted: boolean;
  running: TurnFold | undefined;
}

const notFound = (id: SessionId) =>
  new SessionError({ reason: 'NotFound', detail: `no open Session ${id}` });

const unavailable = (error: AcpError | AgentLaunchError) => {
  if (error._tag === 'AgentLaunchError' && error.reason === 'NotInstalled') {
    return { status: 'notInstalled', reason: 'AgentNotInstalled' } as const;
  }
  if (error._tag === 'AcpError' && error.reason === 'AuthRequired') {
    return { status: 'needsLogin', reason: 'AgentNeedsLogin' } as const;
  }
  return { status: 'cantStart', reason: 'AgentCantStart' } as const;
};

/** How a prompt ended, as a Turn outcome. */
const endOf = (result: Exit.Exit<PromptResponse, AcpError>): TurnOutcome =>
  Exit.isSuccess(result)
    ? outcomeOf(result.value.stopReason)
    : Option.match(Cause.findErrorOption(result.cause), {
        onSome: failedOutcome,
        onNone: () => ({
          _tag: 'failed' as const,
          reason: 'agentError' as const,
          detail: Cause.pretty(result.cause),
        }),
      });

export const layerSessions = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const acpClient = yield* AcpClient;
    const store = yield* SessionStore;
    const projects = yield* Projects;
    const settings = yield* Settings;
    const agent = yield* SessionAgent;
    const open = new Map<SessionId, Open>();

    const lookup = (id: SessionId) =>
      Effect.suspend(() => {
        const session = open.get(id);
        return session === undefined ? Effect.fail(notFound(id)) : Effect.succeed(session);
      });

    const setState = (session: Open, patch: Partial<LiveState>) =>
      Effect.suspend(() => {
        session.state = { ...session.state, ...patch };
        return PubSub.publish(session.hub, { _tag: 'Live', state: session.state });
      });

    /** Numbers the items as the Session's next Transcript events and publishes them. */
    const append = (session: Open, items: ReadonlyArray<TranscriptItem>) =>
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

    const endTurn = Effect.fnUntraced(function* (session: Open, outcome: TurnOutcome) {
      const running = session.running;
      if (running === undefined) return;
      session.running = undefined;
      yield* append(session, [{ _tag: 'TurnEnded', turnId: running.turnId, outcome }]);
      yield* store.flush(session.meta.id).pipe(Effect.orDie);
    });

    const onEvent = Effect.fnUntraced(function* (session: Open, event: AcpSessionEvent) {
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
          return yield* endTurn(session, endOf(event.result));
      }
    });

    /** Reads the ACP session's events for as long as it lives; a dead Agent fails the running Turn. */
    const read = (session: Open, acp: AcpSession) =>
      acp.events.pipe(
        Stream.runForEach((event) => onEvent(session, event)),
        Effect.catch(
          Effect.fnUntraced(function* (error: AcpError) {
            session.acp = undefined;
            session.restarted = true;
            yield* setState(session, { agentStatus: 'stopped' });
            yield* endTurn(session, {
              _tag: 'failed',
              reason: 'agentStopped',
              detail: error.detail,
            });
          }),
        ),
      );

    /** Starts the Agent (memoized per Agent) and a fresh ACP session in the Session's folder. */
    const launch = Effect.fnUntraced(function* (session: Open, started: Started) {
      yield* setState(session, { agentStatus: 'starting' });
      const exit = yield* acpClient.connect(agent).pipe(
        Effect.flatMap((manager) =>
          manager.newSession(session.meta.cwd).pipe(
            Effect.map((acp) => ({
              acp,
              canAttachImages: manager.agentCapabilities.promptCapabilities?.image === true,
            })),
          ),
        ),
        Effect.exit,
      );
      if (Exit.isFailure(exit)) {
        session.acp = undefined;
        const error = Cause.findErrorOption(exit.cause);
        const why = Option.match(error, {
          onSome: unavailable,
          onNone: () => ({ status: 'cantStart', reason: 'AgentCantStart' }) as const,
        });
        yield* setState(session, { agentStatus: why.status });
        const detail = Option.match(error, {
          onSome: (e) => e.detail,
          onNone: () => Cause.pretty(exit.cause),
        });
        yield* Deferred.fail(started, new SessionError({ reason: why.reason, detail }));
        return;
      }
      const { acp, canAttachImages } = exit.value;
      if (session.restarted) {
        // TODO(reopen ticket): record the new ACP session id in session.json too.
        yield* append(session, [{ _tag: 'ContextCleared', reason: 'lost' }]);
      } else {
        yield* store.createDraft({ ...session.meta, acpSessionIds: [acp.sessionId] });
      }
      yield* Effect.forkIn(read(session, acp), scope);
      yield* setState(session, { agentStatus: 'ready', canAttachImages });
      yield* Deferred.succeed(started, acp);
    });

    /** Marks the Session as starting at once (so nothing starts it twice) and launches in the background. */
    const start = Effect.fnUntraced(function* (session: Open) {
      const started: Started = yield* Deferred.make<AcpSession, SessionError>();
      session.acp = started;
      yield* Effect.forkIn(launch(session, started), scope);
      return started;
    });

    /** The Session's ACP session, starting the Agent when it is not running. */
    const ready = (session: Open) =>
      Effect.suspend(() =>
        session.acp === undefined ? start(session) : Effect.succeed(session.acp),
      ).pipe(Effect.flatMap(Deferred.await));

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
      const session: Open = {
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
        },
        acp: undefined,
        restarted: false,
        running: undefined,
      };
      open.set(id, session);
      // The Agent starts now, so the Composer is ready by the time the user has typed.
      yield* start(session);
      return id;
    });

    const prompt = Effect.fn('Sessions.prompt')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
    ) {
      const session = yield* lookup(id);
      const acp = yield* ready(session);
      const turnId = TurnId.make(randomUUID());
      const busy = yield* Effect.sync(() => {
        if (session.running !== undefined) return true;
        session.running = openTurn(turnId);
        return false;
      });
      if (busy) return yield* new SessionError({ reason: 'Busy', detail: 'a Turn is running' });
      yield* append(session, [
        { _tag: 'TurnStarted', turnId, permissionMode: session.state.options.permissionMode },
        { _tag: 'Message', id: MessageId.make(randomUUID()), turnId, role: 'user', parts },
      ]);
      yield* projects.touch(session.meta.projectId);
      // How it ends arrives on the ACP session's events, behind the Turn's updates.
      yield* Effect.forkIn(acp.prompt(toAcpPrompt(parts)).pipe(Effect.ignore), scope);
      return turnId;
    });

    const cancel = Effect.fn('Sessions.cancel')(function* (id: SessionId) {
      const session = yield* lookup(id);
      if (session.running === undefined || session.acp === undefined) return;
      if (!(yield* Deferred.isDone(session.acp))) return;
      const acp = yield* Deferred.await(session.acp).pipe(Effect.option);
      if (Option.isNone(acp)) return;
      // A failed cancel means the Agent is gone; its events report that.
      yield* acp.value.cancel.pipe(Effect.ignore);
    });

    const events = (id: SessionId, afterSeq = 0) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* lookup(id);
          // Subscribed before the replay is read: nothing appended in between is missed, only seen twice.
          const live = yield* PubSub.subscribe(session.hub);
          const state = session.state;
          const replayed = yield* store.replay(id, afterSeq);
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
