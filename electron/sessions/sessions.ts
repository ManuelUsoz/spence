import type {
  AgentCapabilities as AcpAgentCapabilities,
  AuthMethod,
  RequestPermissionOutcome,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import {
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import { randomUUID } from 'node:crypto';
import { type AgentCapabilities, AgentId, Effort } from '../../src/shared/agents/agents.rpc';
import { type ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  type AuthMethodInfo,
  type CancelGrace,
  type CantStartReason,
  type Compaction,
  CompactionId,
  type ContextCleared,
  type ContextUsage,
  type ContextUsageReading,
  type Attention,
  type LiveState,
  type MessagePart,
  MessageId,
  type OptionName,
  type PermissionRequest,
  PermissionRequestId,
  SessionError,
  SessionId,
  type SessionOptionChange,
  type SessionStreamItem,
  type SessionChange,
  type SessionOptions,
  type SessionSummary,
  type SessionTitle,
  STOP_AGENT_INTERRUPTED_DETAIL,
  type StopAgentResult,
  StepId,
  type ComposerDraft,
  type TranscriptEvent,
  type TranscriptItem,
  TurnId,
  type TurnOutcome,
  type UnconfirmedExit,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpSessionEvent, PendingPermission } from '../acp/acpClientDispatcher';
import { AcpError } from '../acp/acpErrors';
import {
  applyCompactionUpdate,
  cancelSteps,
  cancelledOutcome,
  foldUpdate,
  openTurn,
  promptOutcome,
  selectedOutcome,
  stepOfToolCall,
  toAcpPrompt,
  toContextUsage,
  toPermissionRequest,
  type TurnFold,
} from '../acp/acpMappers';
import { Agents } from '../agents/agents';
import type { CatalogEntry } from '../agents/catalog';
import { claude } from '../agents/claude/claude';
import { policyAnswer, resolvePermissionMapping } from '../agents/permission-modes';
import { normalizeVersion, qualifyVersion } from '../agents/version';
import {
  AgentLifetime,
  type OpenAcpSession,
  type OpenedAcpSession,
  type OpenError,
} from '../acp/acpLifetime';
import { type AcpSession, supportsAcpCompaction } from '../acp/acpSession';
import { AcpClient } from '../acp/acpSessionManager';
import { Projects } from '../projects/projects';
import { Remembered } from '../settings/remembered';
import { Settings } from '../settings/settings';
import type { RestoredTab, RestoredTabs } from '../../src/shared/tabs/tabs.rpc';
import { DeleteQueue } from './delete-queue';
import { closeInterrupted, reopenAcpSession, type Reopened } from './reopen';
import { AgentCatalog } from './session-agent';
import { agentValue, chooseStart, foldOptions, toCommands } from './session-options';
import { SessionStore, type SessionMeta } from './session-store';

/** How long after `Session.cancel` before the UI offers `Stop Agent`. */
export const CANCEL_GRACE = Duration.seconds(5);

export interface SessionsShape {
  readonly changes: Stream.Stream<SessionChange>;
  readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<SessionSummary>>;
  /** Starts a draft Session in the Project and, at once, its Agent and ACP session. Nothing is kept until a prompt. */
  readonly create: (
    projectId: ProjectId,
    agentId?: AgentId,
  ) => Effect.Effect<SessionId, SessionError>;
  /** Changes the Agent on an unsent draft Session and starts a fresh ACP session for it. */
  readonly setAgent: (id: SessionId, agentId: AgentId) => Effect.Effect<void, SessionError>;
  /** Returns the Agent currently assigned to the Session. */
  readonly agentOf: (id: SessionId) => Effect.Effect<AgentId, SessionError>;
  /** Starts a Turn with the user's Message once the Agent is ready; `Busy` while a Turn runs. */
  readonly prompt: (
    id: SessionId,
    parts: ReadonlyArray<MessagePart>,
  ) => Effect.Effect<TurnId, SessionError>;
  /** Asks the Agent to stop the running Turn; nothing when none runs. */
  readonly cancel: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Force-stops the shared Agent process tree; requires `force: true` when other active Sessions share it. */
  readonly stopAgent: (
    id: SessionId,
    force?: boolean,
  ) => Effect.Effect<StopAgentResult, SessionError>;
  /** Fails with `ExitUnconfirmed` when the Session's Agent has an unconfirmed exit or pending stop. */
  readonly checkExitGate: (id: SessionId) => Effect.Effect<void, SessionError>;
  readonly rename: (id: SessionId, title: string) => Effect.Effect<void, SessionError>;
  readonly retryAgent: (id: SessionId) => Effect.Effect<void, SessionError>;
  readonly loginAgent: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Cancels any running Turns belonging to `projectId` (used when removing a Project). */
  readonly cancelProject: (projectId: ProjectId) => Effect.Effect<void>;
  /** A fresh ACP session with the same options, and `ContextCleared` in the Transcript; `Busy` while a Turn runs. */
  readonly clearContext: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Triggers manual Context compaction on the live ACP session; `Busy` while running, `Unsupported` when absent. */
  readonly compact: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Answers a pending Permission request with one of its options; nothing when it is no longer pending. */
  readonly answerPermission: (
    id: SessionId,
    requestId: PermissionRequestId,
    optionId: string,
  ) => Effect.Effect<void, SessionError>;
  /** Changes one of the Session's options; the new live state is published. */
  readonly setOption: (change: SessionOptionChange) => Effect.Effect<void, SessionError>;
  /** The live state, then the Transcript after `afterSeq`, then everything live; no `seq` twice. */
  readonly events: (
    id: SessionId,
    afterSeq?: number,
  ) => Stream.Stream<SessionStreamItem, SessionError>;
  /**
   * The window's Tabs changed: the Sessions open in Tabs, in strip order, and the active one. A shown Tab connects
   * its Session (reopening a kept one); a closed Tab lets its ACP session go. Remembered for the next launch.
   */
  readonly setTabs: (
    open: ReadonlyArray<SessionId>,
    active: SessionId | undefined,
  ) => Effect.Effect<void>;
  /** Sets `archivedAt`, cancels any running Turn (pending Permission requests become `cancelled`), and closes its Tab. */
  readonly archive: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Clears `archivedAt` on a Session. */
  readonly unarchive: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Permanently removes a Session from Spence and sends or queues ACP `session/delete`. */
  readonly remove: (id: SessionId) => Effect.Effect<void, SessionError>;
  /** Sessions that auto-archive must skip: open Tabs, running Turns, or pending Permission requests. */
  readonly protectedFromAutoArchive: Effect.Effect<ReadonlySet<SessionId>>;
  /** The Tabs remembered from the last run that can still open: kept Sessions of listed Projects. */
  readonly restoreTabs: Effect.Effect<RestoredTabs>;
  /** Returns unsent Composer text and images remembered in main for an open Session. */
  readonly getComposer: (id: SessionId) => Effect.Effect<ComposerDraft>;
  /** Stores unsent Composer text and images in main across window reloads. */
  readonly setComposer: (id: SessionId, draft: ComposerDraft) => Effect.Effect<void>;
}

/** The Sessions this run has open: ACP stack, Transcript store and Projects joined. */
export class Sessions extends Context.Service<Sessions, SessionsShape>()('sessions/Sessions') {}

/**
 * A Session open in this run. The fields below `lock` are mutable on purpose: they are the live state of a running
 * Session (its ACP session, its Turn), changed only by this module's fibers.
 */
interface LiveSession {
  meta: SessionMeta;
  agent: CatalogEntry;
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
  /** The ACP session's config options as the Agent last reported them. */
  config: ReadonlyArray<SessionConfigOption>;
  /** What the next ACP session starts on: the Settings for a new Session, then what the Session ran with. */
  wanted: Wanted;
  /** The ACP session's advertised capabilities once connected. */
  acpCapabilities: AcpAgentCapabilities | undefined;
  /** A Clear is swapping the ACP session: prompts wait for it (`Busy`). */
  clearing: boolean;
  /** Standalone `Session.compact` currently running (outside a Turn). */
  compacting:
    | {
        acp: AcpSession | undefined;
        cancelled: boolean;
        compactions: ReadonlyMap<string, Compaction>;
      }
    | undefined;
  /** A fresh `usage_update` arrived during the current Turn's compaction. */
  compactionReported: boolean;
  /** The Session is deleted: late async events and appends are dropped. */
  deleted: boolean;
  /** Permission requests waiting for the user, with the Agent's side waiting on `answer`. */
  readonly permissions: Map<PermissionRequestId, PendingRequest>;
  /** Cancel grace phase while waiting on a stalled cancel (`waiting` -> `ready` at `CANCEL_GRACE`). */
  cancelGracePhase: 'waiting' | 'ready' | undefined;
  /** Forked timer advancing `cancelGracePhase` from `waiting` to `ready`. */
  cancelGraceFiber: Fiber.Fiber<void> | undefined;
}

/** A Permission request shown pending: answering it completes `answer`, which replies to the Agent. */
interface PendingRequest {
  readonly item: PermissionRequest;
  readonly answer: Deferred.Deferred<RequestPermissionOutcome>;
}

/** A start value: the pinned one, else the last used; one the Agent does not offer leaves the Agent's default. */
interface Start<A extends string> {
  readonly pinned?: A;
  readonly last?: A;
}

interface Wanted {
  readonly model: Start<string>;
  readonly effort: Start<Effort>;
}

const isEffort = Schema.is(Effort);

/** A Turn's start, with a snapshot of the options it runs with. */
const turnStarted = (turnId: TurnId, options: LiveState['options']): TranscriptItem => ({
  _tag: 'TurnStarted',
  turnId,
  ...(options.model === undefined ? {} : { model: options.model.value }),
  ...(options.effort === undefined ? {} : { effort: options.effort.value }),
  permissionMode: options.permissionMode,
});

/** The Session file with the Model and Effort the Session runs with. */
const withOptions = (meta: SessionMeta, options: LiveState['options']): SessionMeta => {
  const { model: _model, effort: _effort, ...rest } = meta;
  return {
    ...rest,
    ...(options.model === undefined ? {} : { model: options.model.value }),
    ...(options.effort === undefined ? {} : { effort: options.effort.value }),
  };
};

const readingOf = (usage: ContextUsage | undefined): ContextUsageReading | undefined => {
  if (usage === undefined) return undefined;
  switch (usage._tag) {
    case 'reported':
      return { used: usage.used, capacity: usage.capacity };
    case 'countOnly':
      return { used: usage.used };
    case 'historical':
      return {
        used: usage.used,
        ...(usage.capacity === undefined ? {} : { capacity: usage.capacity }),
      };
    case 'waiting':
      return usage.prior;
    case 'unavailable':
      return undefined;
  }
};

const historicalOf = (usage: ContextUsage | undefined): ContextUsage => {
  const prior = readingOf(usage);
  return prior === undefined ? { _tag: 'unavailable' } : { _tag: 'historical', ...prior };
};

const waitingOf = (usage: ContextUsage | undefined): ContextUsage => {
  const prior = readingOf(usage);
  return prior === undefined ? { _tag: 'waiting' } : { _tag: 'waiting', prior };
};

const withSavedContextUsage = (
  meta: SessionMeta,
  reading: ContextUsageReading | undefined,
): SessionMeta => {
  const { contextUsage: _drop, ...rest } = meta;
  return reading === undefined ? rest : { ...rest, contextUsage: reading };
};

/** A Setting's value as a pin: `lastUsed` pins nothing. */
const pin = <A extends string>(value: A | 'lastUsed' | undefined): A | undefined =>
  value === 'lastUsed' ? undefined : value;

const titleOf = (meta: SessionMeta): SessionTitle => ({
  ...(meta.userTitle === undefined ? {} : { user: meta.userTitle }),
  ...(meta.autoTitle === undefined ? {} : { auto: meta.autoTitle }),
  ...(meta.autoTitleImageCount === undefined ? {} : { autoImageCount: meta.autoTitleImageCount }),
  autoIsPlaceholder: meta.autoTitleIsPlaceholder,
});

const isTerminalAuth = (
  method: AuthMethod,
): method is Extract<AuthMethod, { readonly type: 'terminal' }> =>
  'type' in method && method.type === 'terminal';

const toAuthMethodInfos = (
  agent: Pick<CatalogEntry, 'binary' | 'args'>,
  methods: ReadonlyArray<AuthMethod>,
): ReadonlyArray<AuthMethodInfo> =>
  methods.map((method) => ({
    id: method.id,
    name: method.name,
    ...(typeof method.description === 'string' && method.description.length > 0
      ? { description: method.description }
      : {}),
    ...(isTerminalAuth(method)
      ? { command: [agent.binary, ...agent.args, ...(method.args ?? [])].join(' ') }
      : {}),
  }));

/** Why the Agent could not open an ACP session, as an Agent status, cause and `SessionError`. */
const unavailable = (error: OpenError) => {
  const why = (() => {
    if (error._tag === 'AgentLaunchError' && error.reason === 'NotInstalled') {
      return { status: 'notInstalled', reason: 'AgentNotInstalled' } as const;
    }
    if (error._tag === 'AcpError' && error.reason === 'AuthRequired') {
      return { status: 'needsLogin', reason: 'AgentNeedsLogin' } as const;
    }
    const cantStartReason: CantStartReason =
      error._tag === 'AcpError' && error.reason === 'ProtocolVersion'
        ? 'protocolVersion'
        : error._tag === 'AcpError' && error.reason === 'Unsupported'
          ? 'unsupported'
          : 'spawn';
    return { status: 'cantStart', reason: 'AgentCantStart', cantStartReason } as const;
  })();
  return {
    status: why.status,
    cantStartReason: 'cantStartReason' in why ? why.cantStartReason : undefined,
    cantStartDetail: why.status === 'cantStart' ? error.detail : undefined,
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
    const agents = yield* Agents;
    const catalog = yield* AgentCatalog;
    const remembered = yield* Remembered;
    const deleteQueue = yield* DeleteQueue;
    const open = new Map<SessionId, LiveSession>();
    const agentAuthMethods = new Map<AgentId, ReadonlyArray<AuthMethod>>();
    const agentsNeedingLogin = new Set<AgentId>();
    const deleting = new Set<SessionId>();
    const changesHub = yield* PubSub.unbounded<SessionChange>();
    const changes = Stream.unwrap(
      PubSub.subscribe(changesHub).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    );
    /** One kept Session is brought into this run at a time, so two callers never load it twice. */
    const loading = (yield* Semaphore.make(1)).withPermit;
    /** The window's Tabs as last reported. */
    let tabs: { readonly open: ReadonlySet<SessionId>; readonly active: SessionId | undefined } = {
      open: new Set(),
      active: undefined,
    };

    const resolveCatalogAgent = (id: AgentId): CatalogEntry =>
      catalog.get(id) ?? catalog.get(catalog.fallbackId) ?? catalog.entries[0] ?? claude;

    const resolveDefaultAgent = Effect.gen(function* () {
      const { defaultAgent } = yield* settings.get;
      if (defaultAgent === 'lastUsed') {
        const last = yield* remembered.lastAgent;
        const matched = last === undefined ? undefined : catalog.get(last);
        if (matched !== undefined) return matched;
      } else {
        const matched = catalog.get(AgentId.make(defaultAgent));
        if (matched !== undefined) return matched;
      }
      return resolveCatalogAgent(catalog.fallbackId);
    });

    const wantedForAgent = Effect.fnUntraced(function* (entry: CatalogEntry) {
      const { agents } = yield* settings.get;
      const pins = agents[entry.id];
      const memory = yield* remembered.get(entry.id);
      const pinnedModel = pin(pins?.model);
      const pinnedEffort = pin(pins?.effort);
      const wanted: Wanted = {
        model: {
          ...(pinnedModel === undefined ? {} : { pinned: pinnedModel }),
          ...(memory.lastModel === undefined ? {} : { last: memory.lastModel }),
        },
        effort: {
          ...(pinnedEffort === undefined ? {} : { pinned: pinnedEffort }),
          ...(memory.lastEffort === undefined ? {} : { last: memory.lastEffort }),
        },
      };
      return wanted;
    });

    /** The Session's options folded from its ACP config options, applying catalog eligibility filters. */
    const foldedOptions = (
      session: LiveSession,
    ): { readonly options: SessionOptions; readonly modelsLimitation: string | undefined } => {
      const raw = foldOptions(
        session.config,
        session.agent.effort,
        session.state.options.permissionMode,
      );
      if (session.agent.filterModels === undefined || raw.model === undefined) {
        return { options: raw, modelsLimitation: undefined };
      }
      const filtered = session.agent.filterModels(raw.model.choices);
      const modelsLimitation = filtered.excludedNote;
      const firstEligible = filtered.models[0];
      if (firstEligible === undefined) {
        const { model: _drop, ...rest } = raw;
        return { options: rest, modelsLimitation };
      }
      const value = filtered.models.some((choice) => choice.id === raw.model?.value)
        ? raw.model.value
        : firstEligible.id;
      return {
        options: {
          ...raw,
          model: { value, choices: filtered.models },
        },
        modelsLimitation,
      };
    };

    const optionsOf = (session: LiveSession) => foldedOptions(session).options;

    const effectivePermissionMode = (
      entry: CatalogEntry,
      mode: LiveState['options']['permissionMode'],
    ) => (!entry.capabilities.askMode && mode === 'ask' ? ('auto' as const) : mode);

    const agentLiveFields = (entry: CatalogEntry): Partial<LiveState> => ({
      imageLimits: entry.imageLimits,
      agentName: entry.name,
      agentId: entry.id,
      agentPackage: entry.package,
      capabilities: entry.capabilities,
      installKind: entry.installKind,
      ...(entry.installInstructions === undefined
        ? {}
        : { installInstructions: entry.installInstructions }),
      ...(entry.loginInstructions === undefined
        ? {}
        : { loginInstructions: entry.loginInstructions }),
      ...(entry.upgradeCommand === undefined ? {} : { upgradeCommand: entry.upgradeCommand }),
    });

    const makeLive = Effect.fnUntraced(function* (
      meta: SessionMeta,
      prompted: boolean,
      agentStatus: LiveState['agentStatus'],
    ) {
      const agent = resolveCatalogAgent(meta.agentId);
      const permissionMode = effectivePermissionMode(agent, meta.permissionMode);
      const initialContextUsage: ContextUsage =
        prompted && meta.contextUsage !== undefined
          ? { _tag: 'historical', ...meta.contextUsage }
          : { _tag: 'unavailable' };

      const session: LiveSession = {
        meta: permissionMode === meta.permissionMode ? meta : { ...meta, permissionMode },
        agent,
        hub: yield* PubSub.unbounded<SessionStreamItem>(),
        lock: (yield* Semaphore.make(1)).withPermit,
        state: {
          agentStatus,
          isDraft: !prompted,
          title: titleOf(meta),
          options: { permissionMode },
          commands: [],
          canAttachImages: false,
          imageLimits: agent.imageLimits,
          ...agentLiveFields(agent),
          contextUsage: initialContextUsage,
        },
        acp: undefined,
        acpCapabilities: undefined,
        prompted,
        running: undefined,
        prompting: undefined,
        stopRequested: false,
        config: [],
        wanted: {
          model: meta.model === undefined ? {} : { pinned: meta.model },
          effort: meta.effort === undefined ? {} : { pinned: meta.effort },
        },
        clearing: false,
        compacting: undefined,
        compactionReported: false,
        deleted: false,
        permissions: new Map(),
        cancelGracePhase: undefined,
        cancelGraceFiber: undefined,
      };
      return session;
    });

    /**
     * The Session open in this run; a kept one from an earlier run is brought in from the store first. That starts
     * nothing: its Agent connects only when a Tab shows it or a Turn starts.
     */
    const lookup = (id: SessionId): Effect.Effect<LiveSession, SessionError> =>
      Effect.suspend(() => {
        const session = open.get(id);
        return session === undefined ? loading(bringIn(id)) : Effect.succeed(session);
      });

    const bringIn = Effect.fnUntraced(function* (id: SessionId) {
      if (deleting.has(id)) {
        return yield* new SessionError({ reason: 'NotFound', detail: `no Session ${id}` });
      }
      const known = open.get(id);
      if (known !== undefined) return known;
      const meta = yield* store.get(id);
      // Not running is never shown: the Agent starts when the Session is shown or prompted.
      const session = yield* makeLive(meta, true, 'ready');
      // A Turn an earlier run never ended was cut off when that run ended.
      const interrupted = closeInterrupted(yield* store.replay(id));
      if (interrupted.length > 0) {
        yield* append(session, interrupted);
        yield* store.flush(id).pipe(Effect.orDie);
      }
      if (deleting.has(id)) {
        return yield* new SessionError({ reason: 'NotFound', detail: `no Session ${id}` });
      }
      open.set(id, session);
      return session;
    });

    const attentionOf = (
      items: ReadonlyArray<TranscriptItem>,
      status: LiveState['agentStatus'],
    ): Attention | undefined => {
      const pending = new Set<PermissionRequestId>();
      let failed = false;
      for (const item of items) {
        if (item._tag === 'TurnStarted' || item._tag === 'ContextCleared') {
          failed = false;
          pending.clear();
        } else if (item._tag === 'TurnEnded') {
          failed = item.outcome._tag === 'failed';
          pending.clear();
        } else if (item._tag === 'PermissionRequest') {
          if (item.state._tag === 'pending') pending.add(item.id);
          else pending.delete(item.id);
        }
      }
      return pending.size > 0
        ? 'needsAnswer'
        : failed || status === 'stopped'
          ? 'error'
          : undefined;
    };

    const unconfirmedExitOf = Effect.fnUntraced(function* (
      agentId: AgentId,
    ): Effect.fn.Return<UnconfirmedExit | undefined> {
      const gate = yield* lifetime.exitGateState({ agentId });
      if (gate.clear || gate.state === 'cancelPending') return undefined;
      return {
        ...(gate.pid === undefined ? {} : { pid: gate.pid }),
        state: gate.state,
      };
    });

    const snapshot = Effect.fnUntraced(function* (session: LiveSession) {
      const events = session.prompted
        ? yield* store.replay(session.meta.id).pipe(Effect.orDie)
        : [];
      // The live meta is not updated on archive/unarchive; the store holds the current `archivedAt`.
      const archivedAt = session.prompted
        ? yield* store.get(session.meta.id).pipe(
            Effect.map((meta) => meta.archivedAt),
            Effect.catch(() => Effect.succeed(session.meta.archivedAt)),
          )
        : session.meta.archivedAt;
      const attention =
        archivedAt === undefined
          ? attentionOf(
              events.map((event) => event.item),
              session.state.agentStatus,
            )
          : undefined;
      const cancelGrace: CancelGrace | undefined =
        session.cancelGracePhase !== undefined && session.running !== undefined
          ? {
              phase: session.cancelGracePhase,
              otherWorkingCount: (yield* lifetime.otherWorking(
                session.meta.id,
                session.meta.agentId,
              )).length,
            }
          : undefined;
      const unconfirmedExit = yield* unconfirmedExitOf(session.meta.agentId);
      return {
        ...session.state,
        ...(attention === undefined ? {} : { attention }),
        ...(session.running === undefined ? {} : { runningTurn: session.running.turnId }),
        ...(cancelGrace === undefined ? {} : { cancelGrace }),
        ...(unconfirmedExit === undefined ? {} : { unconfirmedExit }),
        ...(session.compacting === undefined ? {} : { compacting: true }),
      };
    });

    const summaryState = Effect.fnUntraced(function* (id: SessionId) {
      const session = open.get(id);
      const events = yield* store.replay(id).pipe(Effect.orDie);
      const attention = attentionOf(
        [
          ...events.map((event) => event.item),
          ...(session === undefined ? closeInterrupted(events) : []),
        ],
        session?.state.agentStatus ?? 'ready',
      );
      return {
        ...(attention === undefined ? {} : { attention }),
        ...(session?.running === undefined && session?.compacting === undefined
          ? {}
          : { running: true }),
        empty: events.length === 0,
      };
    });

    const list = Effect.fnUntraced(function* (projectId: ProjectId) {
      const summaries = yield* store.list(projectId);
      return yield* Effect.forEach(
        summaries,
        Effect.fnUntraced(function* (summary) {
          if (summary.archivedAt !== undefined) return summary;
          const { empty: _empty, ...state } = yield* summaryState(summary.id);
          return { ...summary, ...state };
        }),
      );
    });

    const publishState = (session: LiveSession, state: LiveState) =>
      PubSub.publish(session.hub, { _tag: 'Live', state }).pipe(
        Effect.andThen(
          PubSub.publish(changesHub, {
            sessionId: session.meta.id,
            projectId: session.meta.projectId,
            state,
          }),
        ),
      );

    const setState = (session: LiveSession, patch: Partial<LiveState>) =>
      Effect.suspend(() => {
        if (session.deleted) return Effect.void;
        const merged: LiveState = { ...session.state, ...patch };
        const withoutLimitation =
          'modelsLimitation' in patch && patch.modelsLimitation === undefined
            ? (() => {
                const { modelsLimitation: _drop, ...rest } = merged;
                return rest;
              })()
            : merged;
        if (withoutLimitation.agentStatus !== 'cantStart') {
          const {
            cantStartReason: _dropReason,
            cantStartDetail: _dropDetail,
            ...rest
          } = withoutLimitation;
          session.state = rest;
        } else {
          session.state = withoutLimitation;
        }
        return snapshot(session).pipe(Effect.flatMap((state) => publishState(session, state)));
      });

    const requireExitConfirmed = Effect.fnUntraced(function* (target: {
      readonly agentId: AgentId;
      readonly sessionId?: SessionId;
    }) {
      const gate = yield* lifetime.exitGateState(target);
      if (!gate.clear) {
        return yield* new SessionError({
          reason: 'ExitUnconfirmed',
          detail: gate.detail,
        });
      }
    });

    const refreshOpenForAgent = Effect.fnUntraced(function* (agentId: AgentId) {
      for (const session of open.values()) {
        if (session.meta.agentId === agentId && !session.deleted) {
          yield* setState(session, {});
        }
      }
    });

    const refreshGraceHolders = Effect.fnUntraced(function* (agentId: AgentId) {
      for (const session of open.values()) {
        if (
          session.meta.agentId === agentId &&
          !session.deleted &&
          session.cancelGracePhase !== undefined
        ) {
          yield* setState(session, {});
        }
      }
    });

    const clearCancelGrace = Effect.fnUntraced(function* (session: LiveSession) {
      const fiber = session.cancelGraceFiber;
      session.cancelGracePhase = undefined;
      session.cancelGraceFiber = undefined;
      if (fiber !== undefined) yield* Fiber.interrupt(fiber);
      yield* lifetime.markCancelSettled(session.meta.id);
    });

    const exitConfirmed = yield* lifetime.subscribeExitConfirmed;
    yield* exitConfirmed.pipe(
      Stream.runForEach((agentId) => refreshOpenForAgent(agentId)),
      Effect.forkIn(scope),
    );

    /** Numbers the items as the Session's next Transcript events and publishes them. */
    const append = (session: LiveSession, items: ReadonlyArray<TranscriptItem>) =>
      session.lock(
        Effect.suspend(() => {
          if (session.deleted) return Effect.succeed<ReadonlyArray<TranscriptEvent>>([]);
          return store.append(session.meta.id, items).pipe(
            Effect.flatMap((events) =>
              PubSub.publishAll(
                session.hub,
                events.map((event) => ({ _tag: 'Transcript', event }) as const),
              ).pipe(Effect.as(events)),
            ),
            Effect.tap(() =>
              items.some(
                (item) =>
                  item._tag === 'TurnStarted' ||
                  item._tag === 'TurnEnded' ||
                  item._tag === 'ContextCleared' ||
                  item._tag === 'PermissionRequest',
              )
                ? snapshot(session).pipe(Effect.flatMap((state) => publishState(session, state)))
                : Effect.void,
            ),
            Effect.orDie,
          );
        }),
      );

    /**
     * Answers every pending Permission request `cancelled`, toward the Agent and in the Transcript: the Turn was
     * cancelled or ended, so nobody will answer them.
     */
    const cancelPermissions = Effect.fnUntraced(function* (session: LiveSession) {
      const pending = yield* Effect.sync(() => {
        const all = [...session.permissions.values()];
        session.permissions.clear();
        return all;
      });
      if (pending.length === 0) return;
      yield* Effect.forEach(pending, ({ answer }) => Deferred.succeed(answer, cancelledOutcome), {
        discard: true,
      });
      yield* append(
        session,
        pending.map(({ item }) => ({ ...item, state: { _tag: 'cancelled' } as const })),
      );
    });

    /**
     * A Permission request from the Agent: shown pending until the user answers, or answered at once by the
     * Permission mode's policy. Its Step is shown first if the Turn has not shown it yet.
     */
    const onPermission = Effect.fnUntraced(function* (
      session: LiveSession,
      { request, answer }: PendingPermission,
    ) {
      const running = session.running;
      if (running === undefined) return yield* Deferred.succeed(answer, cancelledOutcome);
      const { toolCallId } = request.toolCall;
      const known = running.steps.get(toolCallId);
      const stepId = known?.id ?? StepId.make(randomUUID());
      const created =
        known === undefined ? stepOfToolCall(request.toolCall, running.turnId, stepId) : undefined;
      if (created !== undefined)
        session.running = { ...running, steps: new Map(running.steps).set(toolCallId, created) };
      const step = created === undefined ? [] : [created];
      const item = toPermissionRequest(request, {
        id: PermissionRequestId.make(randomUUID()),
        turnId: running.turnId,
        stepId,
      });
      const policy = policyAnswer(
        resolvePermissionMapping(
          session.agent.permissionModes,
          session.state.options.permissionMode,
        ),
        item.options,
      );
      if (policy !== undefined) {
        yield* Deferred.succeed(answer, selectedOutcome(policy.id));
        return yield* append(session, [
          ...step,
          { ...item, state: { _tag: 'answered', optionId: policy.id, by: 'policy' } },
        ]);
      }
      session.permissions.set(item.id, { item, answer });
      return yield* append(session, [...step, item]);
    });

    /**
     * Puts the Agent's session in the mode Spence's Permission mode maps to. An Agent that does not offer that mode
     * is left as it is; a failure to switch is logged, not shown.
     */
    const applyPermissionMode = (session: LiveSession, acp: AcpSession) =>
      Effect.suspend(() => {
        const { agentMode } = resolvePermissionMapping(
          session.agent.permissionModes,
          session.state.options.permissionMode,
        );
        const offered = acp.modes?.availableModes.some((mode) => mode.id === agentMode) === true;
        if (!offered) return Effect.void;
        return acp
          .setMode(agentMode)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning(`could not set the Agent's mode ${agentMode}: ${error.detail}`),
            ),
          );
      });

    const endTurn = Effect.fnUntraced(function* (session: LiveSession, outcome: TurnOutcome) {
      if (session.deleted) return;
      const running = session.running;
      if (running === undefined) return;
      yield* clearCancelGrace(session);
      const meta = yield* store.get(session.meta.id).pipe(Effect.orDie);
      if (meta.autoTitle === undefined && meta.autoTitleImageCount === undefined) {
        const transcript = yield* store.replay(session.meta.id).pipe(Effect.orDie);
        const first = transcript.find(
          (event) => event.item._tag === 'Message' && event.item.role === 'user',
        );
        if (first?.item._tag === 'Message') {
          const text = first.item.parts
            .flatMap((part) => (part._tag === 'text' ? [part.text] : []))
            .join('');
          const title = (text.split(/\r?\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
          if (title !== '') {
            yield* store
              .updateMeta(session.meta.id, (current) => ({
                ...current,
                autoTitle: title,
                autoTitleIsPlaceholder: true,
              }))
              .pipe(Effect.orDie);
            yield* setState(session, {
              title: titleOf(yield* store.get(session.meta.id).pipe(Effect.orDie)),
            });
          } else {
            const count = first.item.parts.filter((part) => part._tag === 'image').length;
            if (count > 0) {
              yield* store
                .updateMeta(session.meta.id, (current) => ({
                  ...current,
                  autoTitleImageCount: count,
                  autoTitleIsPlaceholder: true,
                }))
                .pipe(Effect.orDie);
              yield* setState(session, {
                title: titleOf(yield* store.get(session.meta.id).pipe(Effect.orDie)),
              });
            }
          }
        }
      }
      yield* cancelPermissions(session);
      session.running = undefined;
      session.prompting = undefined;
      session.stopRequested = false;
      session.compactionReported = false;
      if (
        (outcome._tag === 'cancelled' || outcome._tag === 'failed') &&
        session.state.contextUsage?._tag === 'waiting'
      ) {
        yield* setState(session, { contextUsage: historicalOf(session.state.contextUsage) });
      }
      // Released before the end is published: whoever sees it sees the Turn no longer working.
      yield* lifetime.turnEnded(session.meta.id);
      yield* refreshGraceHolders(session.meta.agentId);
      // Steps the Agent left unfinished (it was stopped, or went away) end with their Turn.
      yield* append(session, [
        ...cancelSteps(running),
        { _tag: 'TurnEnded', turnId: running.turnId, outcome },
      ]);
      yield* store.flush(session.meta.id).pipe(Effect.orDie);
    });

    const onEvent = Effect.fnUntraced(function* (session: LiveSession, event: AcpSessionEvent) {
      switch (event._tag) {
        case 'Update': {
          // Live state, at any time: not part of a Turn.
          if (event.update.sessionUpdate === 'session_info_update') {
            const title = event.update.title?.trim();
            if (title === undefined || title === '') return;
            yield* store
              .updateMeta(session.meta.id, ({ autoTitleImageCount: _count, ...meta }) => ({
                ...meta,
                autoTitle: title,
                autoTitleIsPlaceholder: false,
              }))
              .pipe(Effect.orDie);
            return yield* setState(session, {
              title: titleOf(yield* store.get(session.meta.id).pipe(Effect.orDie)),
            });
          }
          if (event.update.sessionUpdate === 'available_commands_update') {
            return yield* setState(session, {
              commands: toCommands(event.update.availableCommands),
            });
          }
          if (event.update.sessionUpdate === 'usage_update') {
            const mapped = toContextUsage(event.update);
            if (mapped === undefined) return;
            session.compactionReported = true;
            yield* store
              .updateMeta(session.meta.id, (meta) => withSavedContextUsage(meta, readingOf(mapped)))
              .pipe(Effect.orDie);
            return yield* setState(session, { contextUsage: mapped });
          }
          if (event.update.sessionUpdate === 'config_option_update') {
            const previousModel = optionsOf(session).model?.value;
            session.config = event.update.configOptions;
            const { options, modelsLimitation } = foldedOptions(session);
            if (previousModel !== undefined && options.model?.value !== previousModel) {
              yield* store
                .updateMeta(session.meta.id, (meta) => withSavedContextUsage(meta, undefined))
                .pipe(Effect.orDie);
              return yield* setState(session, {
                options,
                modelsLimitation,
                contextUsage: { _tag: 'unavailable' },
              });
            }
            return yield* setState(session, { options, modelsLimitation });
          }
          const applyCompactionContextUsage = Effect.fnUntraced(function* (status: string) {
            const current = session.state.contextUsage;
            if (status === 'failed' || status === 'cancelled') {
              session.compactionReported = false;
              yield* setState(session, { contextUsage: historicalOf(current) });
            } else if (status === 'in_progress') {
              session.compactionReported = false;
              yield* setState(session, { contextUsage: waitingOf(current) });
            } else if (!session.compactionReported && current?._tag !== 'waiting') {
              yield* setState(session, { contextUsage: waitingOf(current) });
            }
          });

          if (
            event.update.sessionUpdate === 'compaction_update' ||
            event.update.sessionUpdate === 'compaction_summary_chunk'
          ) {
            if (session.running === undefined && session.compacting === undefined) return;
            if (event.update.sessionUpdate === 'compaction_update') {
              yield* applyCompactionContextUsage(event.update.status);
            }
            if (session.running !== undefined) {
              const [fold, items] = foldUpdate(session.running, event.update, randomUUID);
              session.running = fold;
              return yield* append(session, items);
            }
            if (session.compacting !== undefined) {
              session.prompted = true;
              const [compactions, compaction] = applyCompactionUpdate(
                session.compacting.compactions,
                event.update,
                randomUUID,
              );
              session.compacting.compactions = compactions;
              return yield* append(session, [compaction]);
            }
            return;
          }
          if (session.running === undefined) return;
          const [fold, items] = foldUpdate(session.running, event.update, randomUUID);
          session.running = fold;
          return yield* append(session, items);
        }
        case 'PermissionRequest':
          return yield* onPermission(session, event);
        case 'PromptEnded':
        case 'CompactionEnded': {
          const outcome =
            event._tag === 'PromptEnded'
              ? promptOutcome(event.result)
              : promptOutcome(Exit.map(event.result, () => ({ stopReason: 'end_turn' as const })));
          if (outcome._tag === 'failed' && outcome.reason === 'needsLogin') {
            const failedAgentId = session.agent.id;
            agentsNeedingLogin.add(failedAgentId);
            yield* Effect.forEach(
              open.values(),
              (other) =>
                other.agent.id === failedAgentId
                  ? setState(other, { agentStatus: 'needsLogin' })
                  : Effect.void,
              { discard: true },
            );
          }
          if (outcome._tag === 'failed' && outcome.reason === 'agentStopped') {
            if (session.acp !== undefined) yield* detach(session, session.acp);
            yield* setState(session, {
              agentStatus: 'stopped',
              contextUsage: historicalOf(session.state.contextUsage),
            });
          }
          if (event._tag === 'PromptEnded') {
            return yield* endTurn(session, outcome);
          }
          const compacting = session.compacting;
          if (compacting === undefined) return;
          const fallbackStatus: Exclude<Compaction['status'], 'running'> = compacting.cancelled
            ? 'cancelled'
            : Exit.isFailure(event.result)
              ? 'failed'
              : 'done';
          return yield* endStandaloneCompaction(session, fallbackStatus);
        }
      }
    });

    const endStandaloneCompaction = Effect.fnUntraced(function* (
      session: LiveSession,
      fallbackStatus: Exclude<Compaction['status'], 'running'>,
    ) {
      if (session.deleted) return;
      const compacting = session.compacting;
      if (compacting === undefined) return;
      const updates: Array<Compaction> = [];
      let hadFailureOrCancel = false;
      for (const item of compacting.compactions.values()) {
        const nextStatus = item.status === 'running' ? fallbackStatus : item.status;
        if (nextStatus === 'failed' || nextStatus === 'cancelled') hadFailureOrCancel = true;
        if (item.status === 'running') updates.push({ ...item, status: nextStatus });
      }
      if (compacting.compactions.size === 0) {
        if (fallbackStatus === 'failed' || fallbackStatus === 'cancelled') {
          hadFailureOrCancel = true;
        }
        updates.push({
          _tag: 'Compaction',
          id: CompactionId.make(randomUUID()),
          status: fallbackStatus,
          summary: '',
        });
      }
      if (updates.length > 0) {
        session.prompted = true;
        yield* append(session, updates);
      }
      session.compacting = undefined;
      if (hadFailureOrCancel) {
        session.compactionReported = false;
        yield* setState(session, { contextUsage: historicalOf(session.state.contextUsage) });
      } else if (!session.compactionReported && session.state.contextUsage?._tag !== 'waiting') {
        yield* setState(session, { contextUsage: waitingOf(session.state.contextUsage) });
      } else {
        yield* setState(session, {});
      }
      yield* store.flush(session.meta.id).pipe(Effect.orDie);
      yield* lifetime.turnEnded(session.meta.id);
    });

    /** The ACP session is gone (closed, or its Agent stopped): the next Turn opens another. */
    const detach = (session: LiveSession, acp: AcpSession) =>
      Effect.sync(() => {
        if (session.acp === acp) session.acp = undefined;
      });

    /** Reads the ACP session's events for as long as it lives; a dead Agent fails only a running Turn. */
    const read = (session: LiveSession, acp: AcpSession) =>
      acp.events.pipe(
        Stream.runForEach((event) => onEvent(session, event)),
        Effect.andThen(detach(session, acp)),
        Effect.catch(
          Effect.fnUntraced(function* (error: AcpError) {
            if (session.deleted) return;
            yield* detach(session, acp);
            if (session.running !== undefined) {
              yield* setState(session, {
                agentStatus: 'stopped',
                contextUsage: historicalOf(session.state.contextUsage),
              });
              yield* endTurn(session, {
                _tag: 'failed',
                reason: 'agentStopped',
                detail: error.detail,
              });
            }
            if (session.compacting !== undefined) {
              yield* setState(session, {
                agentStatus: 'stopped',
                contextUsage: historicalOf(session.state.contextUsage),
              });
              yield* endStandaloneCompaction(session, 'failed');
            }
          }),
        ),
      );

    /** Applies one wanted option to a fresh ACP session; one the Agent does not offer is dropped silently. */
    const applyWanted = Effect.fnUntraced(function* (
      session: LiveSession,
      acp: AcpSession,
      option: OptionName,
    ) {
      const options = optionsOf(session);
      const shown = options[option];
      const offered =
        option === 'model'
          ? (options.model?.choices.map((choice) => choice.id) ?? [])
          : (options.effort?.choices ?? []);
      const value = chooseStart<string>({ ...session.wanted[option], offered });
      if (value === undefined || value === shown?.value) return;
      const target = agentValue(session.config, session.agent.effort, option, value);
      if (target === undefined) return;
      session.config = yield* acp
        .setConfigOption(target.configId, target.value)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`${option} not applied: ${error.detail}`).pipe(
              Effect.as(session.config),
            ),
          ),
        );
    });

    /**
     * Starts reading a newly opened ACP session. Until its first Turn the Session is a draft: the store holds it in
     * memory with this ACP session, and nothing is written. After that, the ACP session id is recorded, and one the
     * Agent could not resume or load means its memory of the Session is lost, which the Transcript marks.
     */
    const attach = Effect.fnUntraced(function* (
      session: LiveSession,
      opened: OpenedAcpSession,
      reason: ContextCleared['reason'] | undefined,
    ) {
      if (session.deleted || session.agent.id !== opened.manager.agentId) return;
      const agent = session.agent;
      if (session.prompted && reason !== undefined)
        yield* append(session, [{ _tag: 'ContextCleared', reason }]);
      const savedModel = session.meta.model;
      const contextInvalidated = reason === 'lost' || reason === 'cleared';
      if (contextInvalidated) {
        yield* store
          .updateMeta(session.meta.id, (meta) => withSavedContextUsage(meta, undefined))
          .pipe(Effect.orDie);
      }
      yield* store.addAcpSession(session.meta.id, opened.session.sessionId).pipe(Effect.orDie);
      const askMapping = agent.permissionModes.ask;
      const acpHasAsk =
        askMapping !== undefined &&
        (opened.session.modes === undefined ||
          opened.session.modes === null ||
          opened.session.modes.availableModes.some((mode) => mode.id === askMapping.agentMode));
      const askMode = agent.capabilities.askMode && acpHasAsk;
      if (!askMode && session.state.options.permissionMode === 'ask') {
        session.state = {
          ...session.state,
          options: { ...session.state.options, permissionMode: 'auto' },
        };
        session.meta = { ...session.meta, permissionMode: 'auto' };
        yield* store.setOptions(session.meta.id, { permissionMode: 'auto' }).pipe(Effect.orDie);
      }
      yield* applyPermissionMode(session, opened.session);
      session.acp = opened.session;
      session.config = opened.session.configOptions;
      yield* Effect.forkIn(read(session, opened.session), scope);
      yield* applyWanted(session, opened.session, 'model');
      yield* applyWanted(session, opened.session, 'effort');
      const { options, modelsLimitation } = foldedOptions(session);
      const modelChangedOnReopen =
        session.prompted &&
        reason === undefined &&
        savedModel !== undefined &&
        options.model?.value !== savedModel;
      // From now on a new ACP session starts on what this one runs with.
      session.wanted = {
        model: options.model === undefined ? {} : { pinned: options.model.value },
        effort: options.effort === undefined ? {} : { pinned: options.effort.value },
      };
      yield* store
        .updateMeta(session.meta.id, (meta) =>
          contextInvalidated || modelChangedOnReopen
            ? withSavedContextUsage(withOptions(meta, options), undefined)
            : withOptions(meta, options),
        )
        .pipe(Effect.orDie);
      yield* remembered.rememberModels(agent.id, options.model?.choices ?? []);
      session.acpCapabilities = opened.manager.agentCapabilities;
      const rawVersion = opened.manager.agentInfo?.version;
      const installedVersion =
        normalizeVersion(rawVersion) ??
        (agent.installKind === 'native' ? yield* agents.checkNativeVersion(agent) : undefined);
      const versionQualification = qualifyVersion(
        installedVersion ?? rawVersion,
        agent.qualification,
      );
      const capabilities: AgentCapabilities = {
        ...agent.capabilities,
        models:
          agent.capabilities.models &&
          options.model !== undefined &&
          options.model.choices.length > 0,
        effort:
          agent.capabilities.effort &&
          options.effort !== undefined &&
          options.effort.choices.length > 0,
        images:
          agent.capabilities.images &&
          opened.manager.agentCapabilities.promptCapabilities?.image === true,
        askMode,
        resume:
          agent.capabilities.resume &&
          (opened.manager.agentCapabilities.loadSession === true ||
            Boolean(opened.manager.agentCapabilities.sessionCapabilities?.resume)),
        supportsCompaction:
          agent.capabilities.supportsCompaction &&
          supportsAcpCompaction(opened.manager.agentCapabilities),
      };
      yield* setState(session, {
        agentStatus: 'ready',
        isDraft: !session.prompted,
        capabilities,
        canAttachImages: capabilities.images,
        options,
        modelsLimitation,
        ...(installedVersion === undefined ? {} : { installedVersion }),
        versionQualification,
        ...(agent.upgradeCommand === undefined ? {} : { upgradeCommand: agent.upgradeCommand }),
        authMethods: toAuthMethodInfos(agent, opened.manager.authMethods),
        ...(contextInvalidated || modelChangedOnReopen
          ? { contextUsage: { _tag: 'unavailable' } }
          : {}),
      });
    });

    /**
     * How `AgentLifetime` opens the Session's ACP session: starts the Agent (memoized per Agent), then `session/new`
     * in the Session's folder for a draft, or for a kept Session resume, else load, else new (spec 4.4).
     */
    const openAcp = (
      session: LiveSession,
      reason: ContextCleared['reason'] = 'lost',
    ): OpenAcpSession =>
      Effect.suspend(() => {
        const agent = session.agent;
        return setState(session, { agentStatus: 'starting' }).pipe(
          Effect.andThen(
            agentsNeedingLogin.has(agent.id)
              ? Effect.fail(new AcpError({ reason: 'AuthRequired', detail: 'Login required' }))
              : acpClient.connect(agent),
          ),
          Effect.tap((manager) =>
            Effect.sync(() => {
              agentAuthMethods.set(agent.id, manager.authMethods);
            }),
          ),
          Effect.flatMap((manager) => {
            const { id, cwd } = session.meta;
            const reopened: Effect.Effect<Reopened, OpenError> =
              session.prompted && reason !== 'cleared'
                ? store.get(id).pipe(
                    Effect.orDie,
                    Effect.flatMap((meta) =>
                      reopenAcpSession(manager, meta.acpSessionIds.at(-1), meta.cwd),
                    ),
                  )
                : manager
                    .newSession(cwd)
                    .pipe(Effect.map((acp) => ({ session: acp, lost: false })));
            return reopened.pipe(
              Effect.tap(({ session: acp, lost }) =>
                attach(
                  session,
                  { manager, session: acp },
                  reason === 'cleared' ? 'cleared' : lost ? 'lost' : undefined,
                ),
              ),
              Effect.map(({ session: acp }) => ({ manager, session: acp })),
            );
          }),
          Effect.tapError((error) => {
            if (session.agent.id !== agent.id) return Effect.void;
            const { status, cantStartReason, cantStartDetail } = unavailable(error);
            const rawAuthMethods = agentAuthMethods.get(agent.id) ?? [];
            return setState(session, {
              agentStatus: status,
              ...(cantStartReason === undefined ? {} : { cantStartReason }),
              ...(cantStartDetail === undefined ? {} : { cantStartDetail }),
              ...(rawAuthMethods.length > 0
                ? { authMethods: toAuthMethodInfos(agent, rawAuthMethods) }
                : {}),
            });
          }),
        );
      });

    const create = Effect.fn('Sessions.create')(function* (
      projectId: ProjectId,
      agentId?: AgentId,
    ) {
      const project = yield* projects
        .check(projectId)
        .pipe(
          Effect.mapError(
            (error) => new SessionError({ reason: 'NotFound', detail: error.detail }),
          ),
        );
      const agent =
        agentId === undefined
          ? yield* resolveDefaultAgent
          : (catalog.get(agentId) ??
            (yield* new SessionError({
              reason: 'NotFound',
              detail: `Unknown Agent ${agentId}`,
            })));
      const { defaultPermissionMode } = yield* settings.get;
      const permissionMode = effectivePermissionMode(
        agent,
        project.settings.defaultPermissionMode ?? defaultPermissionMode,
      );
      const wanted = yield* wantedForAgent(agent);
      const now = yield* Clock.currentTimeMillis;
      const id = SessionId.make(randomUUID());
      const session = yield* makeLive(
        {
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
        false,
        'starting',
      );
      session.wanted = wanted;
      yield* store.createDraft(session.meta);
      open.set(id, session);
      // A new Session is shown in a Tab at once (spec 4.1): the Agent and its ACP session start now, so the Composer
      // is ready by the time the user has typed. The Tabs issue reports closing it.
      yield* requireExitConfirmed({ agentId: agent.id }).pipe(
        Effect.andThen(lifetime.tabActivated(id, openAcp(session), agent.id)),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      return id;
    });

    const setAgent = Effect.fn('Sessions.setAgent')(function* (id: SessionId, agentId: AgentId) {
      const session = yield* lookup(id);
      if (session.prompted || session.running !== undefined || session.clearing) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'Agent cannot be changed after a Turn starts',
        });
      }
      const nextAgent = catalog.get(agentId);
      if (nextAgent === undefined) {
        return yield* new SessionError({
          reason: 'NotFound',
          detail: `Unknown Agent ${agentId}`,
        });
      }
      if (session.agent.id === nextAgent.id) return;
      const wanted = yield* wantedForAgent(nextAgent);
      const permissionMode = effectivePermissionMode(
        nextAgent,
        session.state.options.permissionMode,
      );
      session.agent = nextAgent;
      session.acp = undefined;
      session.config = [];
      session.wanted = wanted;
      session.meta = {
        ...session.meta,
        agentId: nextAgent.id,
        acpSessionIds: [],
        permissionMode,
      };
      yield* store.updateMeta(id, (meta) => ({
        ...meta,
        agentId: nextAgent.id,
        acpSessionIds: [],
        permissionMode,
      }));
      const {
        authMethods: _dropAuth,
        installedVersion: _dropVer,
        versionQualification: _dropQual,
        upgradeCommand: _dropUpgrade,
        installInstructions: _dropInstr,
        loginInstructions: _dropLoginInstr,
        modelsLimitation: _dropLimit,
        cantStartReason: _dropReason,
        cantStartDetail: _dropDetail,
        ...baseState
      } = session.state;
      session.state = {
        ...baseState,
        ...agentLiveFields(nextAgent),
        agentStatus: 'starting',
        isDraft: true,
        options: { permissionMode },
        commands: [],
        canAttachImages: false,
      };
      yield* snapshot(session).pipe(Effect.flatMap((state) => publishState(session, state)));
      yield* requireExitConfirmed({ agentId: nextAgent.id }).pipe(
        Effect.andThen(lifetime.replace(id, openAcp(session))),
        Effect.ignore,
        Effect.forkIn(scope),
      );
    });

    const agentOf = (id: SessionId): Effect.Effect<AgentId, SessionError> =>
      lookup(id).pipe(Effect.map((session) => session.agent.id));

    const prompt = Effect.fn('Sessions.prompt')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
    ) {
      const session = yield* lookup(id);
      yield* requireExitConfirmed({ agentId: session.meta.agentId });
      const turnId = TurnId.make(randomUUID());
      const busy = yield* Effect.sync(() => {
        if (session.running !== undefined || session.clearing || session.compacting !== undefined) {
          return true;
        }
        session.running = openTurn(turnId, session.meta.cwd);
        return false;
      });
      if (busy) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'a Turn, Clear, or Compaction is running',
        });
      }
      // Opens the ACP session (starting the Agent) if the Session has none, and holds it open until the Turn ends.
      const acp = yield* lifetime.turnStarted(id, openAcp(session), session.meta.agentId).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            session.running = undefined;
            session.stopRequested = false;
          }),
        ),
        Effect.mapError((error) => unavailable(error).error),
      );
      yield* refreshGraceHolders(session.meta.agentId);
      // Set before the first event is published, so a subscriber from now on replays it from the store.
      const wasDraft = !session.prompted;
      session.prompted = true;
      if (wasDraft) {
        session.state = { ...session.state, isDraft: false };
      }
      yield* remembered.rememberLastAgent(session.agent.id);
      // Sending a Message unarchives an archived Session (spec 7.3).
      yield* store
        .updateMeta(id, ({ archivedAt: _archivedAt, ...rest }) => rest)
        .pipe(Effect.orDie);
      yield* append(session, [
        turnStarted(turnId, session.state.options),
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
      const activeAcp = yield* Effect.sync(() => {
        if (session.running !== undefined) {
          if (session.prompting === undefined) session.stopRequested = true;
          return session.prompting;
        }
        if (session.compacting !== undefined) {
          session.compacting.cancelled = true;
          return session.compacting.acp;
        }
        return undefined;
      });
      if (session.running === undefined && session.compacting === undefined) return;
      // A failed cancel means the Agent is gone; its events report that.
      if (activeAcp !== undefined) yield* activeAcp.cancel.pipe(Effect.ignore);
      yield* cancelPermissions(session);
      if (
        session.running !== undefined &&
        !session.deleted &&
        session.cancelGracePhase === undefined
      ) {
        session.cancelGracePhase = 'waiting';
        yield* lifetime.markCancelPending(id, session.meta.agentId);
        const timer = yield* Effect.gen(function* () {
          yield* Effect.sleep(CANCEL_GRACE);
          if (
            session.deleted ||
            session.running === undefined ||
            session.cancelGracePhase !== 'waiting'
          ) {
            return;
          }
          session.cancelGracePhase = 'ready';
          session.cancelGraceFiber = undefined;
          yield* setState(session, {});
        }).pipe(Effect.forkIn(scope));
        session.cancelGraceFiber = timer;
        yield* setState(session, {});
      }
    });

    const stopAgent = Effect.fn('Sessions.stopAgent')(function* (id: SessionId, force = false) {
      const session = yield* lookup(id);
      const agentId = session.meta.agentId;
      yield* requireExitConfirmed({ agentId });

      const others = yield* lifetime.otherWorking(id, agentId);
      if (others.length > 0 && !force) {
        return {
          _tag: 'confirmRequired',
          otherWorkingCount: others.length,
          agentName: session.agent.name,
        } as const;
      }

      // End active Turns as interrupted and detach all open ACP sessions on this Agent BEFORE killing its process,
      // so Scope finalizer's `AcpError(Exited)` never overwrites `interrupted` with `agentStopped`.
      for (const openSession of open.values()) {
        if (openSession.meta.agentId !== agentId || openSession.deleted) continue;
        const wasRunning = openSession.running !== undefined;
        yield* clearCancelGrace(openSession);
        if (openSession.acp !== undefined) {
          yield* detach(openSession, openSession.acp);
        } else {
          openSession.prompting = undefined;
        }
        if (wasRunning) {
          yield* setState(openSession, { agentStatus: 'stopped' });
          yield* endTurn(openSession, {
            _tag: 'failed',
            reason: 'interrupted',
            detail: STOP_AGENT_INTERRUPTED_DETAIL,
          });
        }
      }

      const killed = yield* lifetime.killAgent(agentId);
      yield* refreshOpenForAgent(agentId);
      if (!killed.exitConfirmed) {
        const gate = yield* lifetime.exitGateState({ agentId });
        return yield* new SessionError({
          reason: 'ExitUnconfirmed',
          detail: gate.clear
            ? `Agent ${agentId} process exit was not confirmed within kill timeout`
            : gate.detail,
        });
      }
      return {
        _tag: 'stopped',
        ...(killed.pid === undefined ? {} : { pid: killed.pid }),
      } as const;
    });

    const checkExitGate = Effect.fn('Sessions.checkExitGate')(function* (id: SessionId) {
      const session = yield* lookup(id);
      yield* requireExitConfirmed({ agentId: session.meta.agentId, sessionId: id });
    });

    const rename = Effect.fn('Sessions.rename')(function* (id: SessionId, title: string) {
      const session = yield* lookup(id);
      const value = title.trim();
      yield* store.updateMeta(id, (meta) => {
        const { userTitle: _userTitle, ...rest } = meta;
        return value === '' ? rest : { ...rest, userTitle: value };
      });
      yield* store.flush(id);
      yield* setState(session, { title: titleOf(yield* store.get(id)) });
    });

    const answerPermission = Effect.fn('Sessions.answerPermission')(function* (
      id: SessionId,
      requestId: PermissionRequestId,
      optionId: string,
    ) {
      const session = yield* lookup(id);
      // Taken out at once: a second answer, or a cancel meanwhile, finds nothing pending.
      const pending = yield* Effect.sync(() => {
        const found = session.permissions.get(requestId);
        if (found === undefined || !found.item.options.some((option) => option.id === optionId)) {
          return undefined;
        }
        session.permissions.delete(requestId);
        return found;
      });
      if (pending === undefined) return;
      yield* Deferred.succeed(pending.answer, selectedOutcome(optionId));
      yield* append(session, [
        { ...pending.item, state: { _tag: 'answered', optionId, by: 'user' } },
      ]);
    });

    const setOption = Effect.fn('Sessions.setOption')(function* (change: SessionOptionChange) {
      const { sessionId: id } = change;
      const session = yield* lookup(id);
      const agent = session.agent;
      if (change.option === 'permissionMode') {
        const nextMode =
          session.state.capabilities?.askMode === false && change.value === 'ask'
            ? 'auto'
            : effectivePermissionMode(agent, change.value);
        yield* setState(session, {
          options: { ...session.state.options, permissionMode: nextMode },
        });
        yield* store.setOptions(id, { permissionMode: nextMode });
        if (session.acp !== undefined) yield* applyPermissionMode(session, session.acp);
        return;
      }
      const { option, value } = change;
      // The renderer offers only the choices the live state lists; anything else is a bug, not a user's choice.
      if (option === 'effort' && !isEffort(value)) {
        return yield* Effect.die(`not an Effort level: ${value}`);
      }
      const modelChanged = option === 'model' && session.state.options.model?.value !== value;
      if (modelChanged) {
        yield* store.updateMeta(id, (meta) => withSavedContextUsage(meta, undefined));
        yield* setState(session, { contextUsage: { _tag: 'unavailable' } });
      }
      const acp = session.acp;
      if (acp !== undefined) {
        const target = agentValue(session.config, agent.effort, option, value);
        if (target === undefined) {
          return yield* Effect.die(`${agent.name} does not offer ${option} ${value}`);
        }
        session.config = yield* acp.setConfigOption(target.configId, target.value).pipe(
          // The Agent went away meanwhile: its events report that.
          Effect.orDie,
        );
      }
      // Without an ACP session (the Agent stopped) the choice applies to the next one.
      session.wanted = { ...session.wanted, [option]: { pinned: value } };
      const { options, modelsLimitation } =
        acp === undefined
          ? { options: session.state.options, modelsLimitation: session.state.modelsLimitation }
          : foldedOptions(session);
      yield* store.updateMeta(id, (meta) => withOptions(meta, options));
      yield* remembered.rememberLast(
        agent.id,
        option === 'model' ? { model: value } : isEffort(value) ? { effort: value } : {},
      );
      yield* setState(session, { options, modelsLimitation });
    });

    const clearContext = Effect.fn('Sessions.clearContext')(function* (id: SessionId) {
      const session = yield* lookup(id);
      yield* requireExitConfirmed({ agentId: session.meta.agentId, sessionId: id });
      const busy = yield* Effect.sync(() => {
        if (session.running !== undefined || session.clearing || session.compacting !== undefined) {
          return true;
        }
        session.clearing = true;
        return false;
      });
      if (busy) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'a Turn, Clear, or Compaction is running',
        });
      }
      yield* store
        .updateMeta(id, (meta) => withSavedContextUsage(meta, undefined))
        .pipe(Effect.orDie);
      yield* setState(session, { contextUsage: { _tag: 'unavailable' } });
      yield* lifetime.replace(id, openAcp(session, 'cleared')).pipe(
        Effect.mapError((error) => unavailable(error).error),
        Effect.ensuring(
          Effect.sync(() => {
            session.clearing = false;
          }),
        ),
      );
    });

    const compact = Effect.fn('Sessions.compact')(function* (id: SessionId) {
      const session = yield* lookup(id);
      const precheck = yield* Effect.sync(() => {
        if (session.running !== undefined || session.clearing || session.compacting !== undefined) {
          return 'busy' as const;
        }
        if (
          !session.agent.capabilities.supportsCompaction ||
          (session.acpCapabilities !== undefined && !supportsAcpCompaction(session.acpCapabilities))
        ) {
          return 'unsupported' as const;
        }
        session.compacting = { acp: undefined, cancelled: false, compactions: new Map() };
        session.compactionReported = false;
        return 'ok' as const;
      });
      if (precheck === 'busy') {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'a Turn, Clear, or Compaction is running',
        });
      }
      if (precheck === 'unsupported') {
        return yield* new SessionError({
          reason: 'Unsupported',
          detail: 'The Agent does not offer session/compact',
        });
      }
      yield* setState(session, { contextUsage: waitingOf(session.state.contextUsage) });
      const acp = yield* lifetime.turnStarted(id, openAcp(session)).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            session.compacting = undefined;
          }).pipe(Effect.andThen(setState(session, {}))),
        ),
        Effect.mapError((error) => unavailable(error).error),
      );
      if (
        !session.agent.capabilities.supportsCompaction ||
        session.acpCapabilities === undefined ||
        !supportsAcpCompaction(session.acpCapabilities)
      ) {
        session.compacting = undefined;
        yield* setState(session, { contextUsage: historicalOf(session.state.contextUsage) });
        yield* lifetime.turnEnded(id);
        return yield* new SessionError({
          reason: 'Unsupported',
          detail: 'The Agent does not offer session/compact',
        });
      }
      const cancelledBeforeSend = yield* Effect.sync(() => {
        if (session.compacting === undefined) return true;
        if (session.compacting.cancelled) return true;
        session.compacting.acp = acp;
        return false;
      });
      if (cancelledBeforeSend) {
        yield* endStandaloneCompaction(session, 'cancelled');
        return;
      }
      yield* Effect.forkIn(acp.compact.pipe(Effect.ignore), scope);
    });

    const events = (id: SessionId, afterSeq = 0) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const session = yield* lookup(id);
          // Subscribed before the replay is read: nothing appended in between is missed, only seen twice.
          const live = yield* PubSub.subscribe(session.hub);
          const state = yield* snapshot(session);
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

    /** The Session's Tab is shown: connects it, in the background; how that goes shows in its Agent status. */
    const activate = (id: SessionId) =>
      lookup(id).pipe(
        Effect.flatMap((session) =>
          requireExitConfirmed({ agentId: session.meta.agentId }).pipe(
            Effect.andThen(lifetime.tabActivated(id, openAcp(session), session.meta.agentId)),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
        Effect.asVoid,
      );

    const retryAgent = Effect.fn('Sessions.retryAgent')(function* (id: SessionId) {
      const session = yield* lookup(id);
      yield* requireExitConfirmed({ agentId: session.meta.agentId, sessionId: id });
      yield* lifetime.tabActivated(id, openAcp(session), session.meta.agentId).pipe(
        Effect.mapError((error) => unavailable(error).error),
        Effect.asVoid,
      );
    });

    const loginAgent = Effect.fn('Sessions.loginAgent')(function* (id: SessionId) {
      const session = yield* lookup(id);
      yield* requireExitConfirmed({ agentId: session.meta.agentId, sessionId: id });
      const agent = session.agent;
      const method = agentAuthMethods.get(agent.id)?.[0];
      if (method === undefined) {
        return yield* new SessionError({
          reason: 'AgentCantStart',
          detail: `${agent.name} did not offer a login method`,
        });
      }
      yield* acpClient
        .login(agent, method)
        .pipe(Effect.mapError((error) => unavailable(error).error));
      agentsNeedingLogin.delete(agent.id);
      yield* acpClient.disconnect(agent.id);
      yield* Effect.forEach(
        open.values(),
        (other) =>
          other.agent.id === agent.id && other.state.agentStatus === 'needsLogin'
            ? setState(other, { agentStatus: 'ready' })
            : Effect.void,
        { discard: true },
      );
      yield* lifetime.tabActivated(id, openAcp(session), agent.id).pipe(
        Effect.mapError((error) => unavailable(error).error),
        Effect.asVoid,
      );
    });

    const composers = new Map<SessionId, ComposerDraft>();

    const setTabs = Effect.fn('Sessions.setTabs')(function* (
      ids: ReadonlyArray<SessionId>,
      active: SessionId | undefined,
    ) {
      const before = tabs;
      const now = { open: new Set(ids), active };
      tabs = now;
      for (const id of before.open) {
        if (!now.open.has(id)) {
          composers.delete(id);
          yield* lifetime.tabClosed(id);
        }
      }
      for (const id of now.open) {
        if (before.open.has(id) || id === active) continue;
        yield* lifetime.tabOpened(id);
      }
      if (active !== undefined && active !== before.active) yield* activate(active);
      yield* remembered.rememberTabs({ open: ids, ...(active === undefined ? {} : { active }) });
    });

    const cancelProject = Effect.fn('Sessions.cancelProject')(function* (projectId: ProjectId) {
      const runningIds = Array.from(open.entries())
        .filter(([, session]) => session.running !== undefined)
        .map(([id]) => id);
      yield* Effect.forEach(runningIds, (id) =>
        store.get(id).pipe(
          Effect.flatMap((meta) =>
            meta.projectId === projectId ? cancel(id).pipe(Effect.ignore) : Effect.void,
          ),
          Effect.ignore,
        ),
      );
    });

    const restoreTabs = Effect.gen(function* () {
      const last = yield* remembered.tabs;
      const listed = new Set((yield* projects.list).map((project) => project.id));
      const restored = yield* Effect.forEach(last.open, (id) =>
        store.get(id).pipe(
          Effect.flatMap(
            Effect.fnUntraced(function* (meta) {
              if (!listed.has(meta.projectId)) return [] as ReadonlyArray<RestoredTab>;
              const { empty, ...state } = yield* summaryState(id);
              const tab: RestoredTab = {
                id,
                projectId: meta.projectId,
                title: titleOf(meta),
                ...state,
                ...(empty ? { draft: true } : {}),
              };
              return [tab];
            }),
          ),
          // A draft that was never kept, or a Session deleted since.
          Effect.catch(() => Effect.succeed([])),
        ),
      );
      const kept = restored.flat();
      const { active } = last;
      const result: RestoredTabs =
        active !== undefined && kept.some((tab) => tab.id === active)
          ? { tabs: kept, active }
          : { tabs: kept };
      return result;
    });

    const forgetTab = Effect.fnUntraced(function* (id: SessionId) {
      if (tabs.open.has(id)) {
        const nextOpen = new Set(tabs.open);
        nextOpen.delete(id);
        const active = tabs.active === id ? undefined : tabs.active;
        tabs = { open: nextOpen, active };
        yield* remembered.rememberTabs({
          open: [...nextOpen],
          ...(active === undefined ? {} : { active }),
        });
      }
      yield* lifetime.tabClosed(id);
    });

    const archive = Effect.fn('Sessions.archive')(function* (id: SessionId) {
      yield* store.get(id);
      const now = Timestamp.make(yield* Clock.currentTimeMillis);
      yield* store.updateMeta(id, (meta) => ({ ...meta, archivedAt: now }));
      yield* store.flush(id).pipe(Effect.orDie);
      const existing = open.get(id);
      if (existing !== undefined) {
        if (existing.running !== undefined) yield* cancel(id);
        yield* setState(existing, {});
      }
      yield* forgetTab(id);
    });

    const unarchive = Effect.fn('Sessions.unarchive')(function* (id: SessionId) {
      yield* store.get(id);
      yield* store.updateMeta(id, ({ archivedAt: _archivedAt, ...rest }) => rest);
      yield* store.flush(id).pipe(Effect.orDie);
      const existing = open.get(id);
      if (existing !== undefined) yield* setState(existing, {});
    });

    const remove = Effect.fn('Sessions.remove')(function* (id: SessionId) {
      const meta = yield* store.get(id);
      deleting.add(id);
      composers.delete(id);
      return yield* Effect.gen(function* () {
        const existing = open.get(id);
        if (existing !== undefined) {
          existing.deleted = true;
          open.delete(id);
          yield* clearCancelGrace(existing);
          if (existing.running !== undefined) {
            if (existing.prompting !== undefined) {
              yield* existing.prompting.cancel.pipe(Effect.ignore);
            } else {
              existing.stopRequested = true;
            }
            yield* cancelPermissions(existing);
            existing.running = undefined;
            existing.prompting = undefined;
            yield* lifetime.turnEnded(id);
            yield* refreshGraceHolders(meta.agentId);
          }
          if (existing.compacting !== undefined) {
            if (existing.compacting.acp !== undefined) {
              yield* existing.compacting.acp.cancel.pipe(Effect.ignore);
            } else {
              existing.compacting.cancelled = true;
            }
            existing.compacting = undefined;
            yield* lifetime.turnEnded(id);
          }
          yield* PubSub.shutdown(existing.hub);
        }
        yield* forgetTab(id);
        yield* store.remove(id);
        yield* deleteQueue.deleteOrQueue(meta.agentId, meta.acpSessionIds);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            deleting.delete(id);
          }),
        ),
      );
    });

    const protectedFromAutoArchive = Effect.sync((): ReadonlySet<SessionId> => {
      const ids = new Set<SessionId>(tabs.open);
      for (const [id, session] of open) {
        if (
          session.running !== undefined ||
          session.compacting !== undefined ||
          session.permissions.size > 0
        ) {
          ids.add(id);
        }
      }
      return ids;
    });

    const getComposer = (id: SessionId): Effect.Effect<ComposerDraft> =>
      Effect.sync(() => composers.get(id) ?? { text: '', images: [] });

    const setComposer = (id: SessionId, draft: ComposerDraft): Effect.Effect<void> =>
      Effect.sync(() => {
        if (draft.text === '' && draft.images.length === 0) composers.delete(id);
        else composers.set(id, draft);
      });

    return Sessions.of({
      changes,
      list,
      create,
      setAgent,
      agentOf,
      prompt,
      cancel,
      stopAgent,
      checkExitGate,
      rename,
      retryAgent,
      loginAgent,
      cancelProject,
      answerPermission,
      setOption,
      clearContext,
      compact,
      archive,
      unarchive,
      remove,
      protectedFromAutoArchive,
      events,
      setTabs,
      restoreTabs,
      getComposer,
      setComposer,
    });
  }),
);
