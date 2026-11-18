import type {
  AgentCapabilities as AcpAgentCapabilities,
  AuthMethod,
  RequestPermissionOutcome,
  SessionConfigOption,
} from '@agentclientprotocol/sdk/unstable';
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from 'effect';
import { randomUUID } from 'node:crypto';
import { agentCopy } from '../i18n/agent-copy';
import { resolveLocale, type Locale } from '../i18n/locale';
import { sessionCopy } from '../i18n/session-copy';
import { type AgentCapabilities, AgentId, Effort } from '../../src/shared/agents/agents.rpc';
import { type Project, type ProjectId, Timestamp } from '../../src/shared/projects/projects.rpc';
import {
  buildStructuredTranscriptExtract,
  computeHandoffBudget,
  computeSourceEndpoint,
  extractHandoffImages,
} from '../../src/shared/sessions/handoff';
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
  type HandoffAttempt,
  HandoffAttemptId,
  type HandoffCompatibility,
  type HandoffKind,
  type HandoffPreparation,
  type HandoffResult,
  type HandoffRevalidation,
  type HandoffSourceEndpoint,
  type LiveState,
  type MessagePart,
  MessageId,
  type MessageSender,
  type OptionName,
  type PermissionRequest,
  PermissionRequestId,
  type QueuedMessage,
  SessionError,
  SessionId,
  type SessionOptionChange,
  type SessionStreamItem,
  type SessionChange,
  type SessionOptions,
  type SessionSummary,
  type WorkerInfo,
  type SessionTitle,
  type Step,
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
  outcomeOf,
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
import { AcpSessionId, type AcpSession, supportsAcpCompaction } from '../acp/acpSession';
import { AcpClient } from '../acp/acpSessionManager';
import { Projects } from '../projects/projects';
import { Remembered } from '../settings/remembered';
import { Settings } from '../settings/settings';
import type { RestoredTab, RestoredTabs } from '../../src/shared/tabs/tabs.rpc';
import { DeleteQueue } from './delete-queue';
import {
  makeDelegationServer,
  toolError,
  type DelegationTools,
  type ToolOutcome,
} from './delegation-server';
import { MAX_ACTIVE_WORKERS_PER_PARENT, MAX_DELEGATION_DEPTH } from './session-messaging';
import {
  MAX_MESSAGE_HOPS,
  MESSAGE_RATE_LIMIT,
  MESSAGE_RATE_WINDOW_MS,
  makeRateLimiter,
  reachableFrom,
} from './session-messaging';
import { closeInterrupted, reopenAcpSession, type Reopened } from './reopen';
import { AgentCatalog } from './session-agent';
import { agentValue, chooseStart, foldOptions, toCommands } from './session-options';
import {
  activeContextOf,
  AgentContextId,
  isNativeWorker,
  isOwnedWorker,
  SessionStore,
  type SessionMeta,
} from './session-store';
import {
  draftSummaryWithFallback,
  resolveHandoffCompatibility,
  runDestinationAcknowledgement,
} from './session-handoff';

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
  /** The folder the Session works in. */
  readonly folderOf: (id: SessionId) => Effect.Effect<string, SessionError>;
  /** Points an unsent draft Session at another folder (a Worktree of its repository) and restarts its Agent there. */
  readonly setDraftFolder: (id: SessionId, folder: string) => Effect.Effect<void, SessionError>;
  /** Starts a Turn with the user's Message once the Agent is ready; `Busy` while a Turn runs. */
  readonly prompt: (
    id: SessionId,
    parts: ReadonlyArray<MessagePart>,
    from?: MessageSender,
  ) => Effect.Effect<TurnId, SessionError>;
  /** Injects a Message into the running Turn without cancelling it; `NotRunning` when none runs. */
  readonly steer: (
    id: SessionId,
    parts: ReadonlyArray<MessagePart>,
  ) => Effect.Effect<void, SessionError>;
  /** Lines a Message up in the Queue; with no Turn running it starts one at once. */
  readonly enqueue: (
    id: SessionId,
    parts: ReadonlyArray<MessagePart>,
  ) => Effect.Effect<void, SessionError>;
  /** Replaces the Queue whole (reorder, edit, remove). */
  readonly setQueue: (
    id: SessionId,
    queue: ReadonlyArray<QueuedMessage>,
  ) => Effect.Effect<void, SessionError>;
  /** Drops every queued Message. */
  readonly clearQueue: (id: SessionId) => Effect.Effect<void, SessionError>;
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
  /** Dismisses the `memoryLost` reopen gate so the next prompt starts on the fresh empty Agent context. */
  readonly startEmptyContext: (id: SessionId) => Effect.Effect<void, SessionError>;
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
  /** How many Worker descendants `remove` would also delete (nested included), for the delete warning. */
  readonly countWorkers: (id: SessionId) => Effect.Effect<number, SessionError>;
  /** Sessions that auto-archive must skip: open Tabs, running Turns, or pending Permission requests. */
  readonly protectedFromAutoArchive: Effect.Effect<ReadonlySet<SessionId>>;
  /** The Tabs remembered from the last run that can still open: kept Sessions of listed Projects. */
  readonly restoreTabs: Effect.Effect<RestoredTabs>;
  /** Returns unsent Composer text and images remembered in main for an open Session. */
  readonly getComposer: (id: SessionId) => Effect.Effect<ComposerDraft>;
  /** Stores unsent Composer text and images in main across window reloads. */
  readonly setComposer: (id: SessionId, draft: ComposerDraft) => Effect.Effect<void>;
  /** Prepares a reviewed Summary handoff for Switch Agent, Model change, or `memoryLost` recovery. */
  readonly prepareHandoff: (input: {
    readonly sessionId: SessionId;
    readonly kind: HandoffKind;
    readonly targetAgentId?: AgentId;
    readonly targetModel?: string;
  }) => Effect.Effect<HandoffPreparation, SessionError>;
  /** Revalidates source endpoint, destination capabilities, `'exit'` confirmation, and token budget. */
  readonly revalidateHandoff: (input: {
    readonly sessionId: SessionId;
    readonly endpoint: HandoffSourceEndpoint;
    readonly targetAgentId: AgentId;
    readonly targetModel?: string;
    readonly summary: string;
    readonly selectedImageIds: ReadonlyArray<string>;
  }) => Effect.Effect<HandoffRevalidation, SessionError>;
  /** Executes destination startup acknowledgement and commits the handoff only upon clean acknowledgement. */
  readonly executeHandoff: (input: {
    readonly sessionId: SessionId;
    readonly kind: HandoffKind;
    readonly endpoint: HandoffSourceEndpoint;
    readonly targetAgentId: AgentId;
    readonly targetModel?: string;
    readonly summary: string;
    readonly selectedImageIds: ReadonlyArray<string>;
    readonly allowEndpointAdvance?: boolean;
  }) => Effect.Effect<HandoffResult, SessionError>;
  /** Lists durable failed/interrupted Handoff attempts inspectable on a Session. */
  readonly listHandoffAttempts: (
    id: SessionId,
  ) => Effect.Effect<ReadonlyArray<HandoffAttempt>, SessionError>;
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
  /** The Queue: Messages waiting for the current Turn to settle, in send order. Ephemeral, never persisted. */
  queue: ReadonlyArray<QueuedMessage>;
  /** True while a queued Message is being turned into the next Turn, so one advance runs at a time. */
  draining: boolean;
  /** Whether the Agent can redirect a running Turn without cancelling it. */
  steeringSupported: boolean;
  /** A Turn has started: the Session is kept, and the Agent's memory holds it, so a later ACP session loses it. */
  prompted: boolean;
  running: TurnFold | undefined;
  /** Session-to-Session hops behind the running Turn's Message; 0 for the user's own. */
  turnHops: number;
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
  /** Summary handoff startup currently running on a destination Agent. */
  handoffRunning:
    | {
        targetAgentId: AgentId;
        acp: AcpSession | undefined;
        cancelled: boolean;
      }
    | undefined;
  /** A fresh `usage_update` arrived during the current Turn's compaction. */
  compactionReported: boolean;
  /** The Session is deleted: late async events and appends are dropped. */
  deleted: boolean;
  /** Permission requests waiting for the user, with the Agent's side waiting on `answer`. */
  readonly permissions: Map<PermissionRequestId, PendingRequest>;
  /** Serializes Steers, so repeated Steers are injected (and recorded) in arrival order. */
  readonly steeringLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
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

/** A Turn's start, with immutable Agent and requested option attribution. */
const turnStarted = (
  turnId: TurnId,
  agentId: AgentId,
  options: LiveState['options'],
): TranscriptItem => ({
  _tag: 'TurnStarted',
  turnId,
  agentId,
  ...(options.model?.value === undefined ? {} : { model: options.model.value }),
  ...(options.effort === undefined ? {} : { effort: options.effort.value }),
  permissionMode: options.permissionMode,
});

/** The Session file with the Model and Effort the Session runs with. */
const withOptions = (meta: SessionMeta, options: LiveState['options']): SessionMeta => {
  const { model: _model, effort: _effort, ...rest } = meta;
  return {
    ...rest,
    ...(options.model?.value === undefined ? {} : { model: options.model.value }),
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

/** The title shown for a Session: the user's, else the automatic one, else a placeholder. */
const displayTitle = (title: SessionTitle): string => title.user ?? title.auto ?? 'Untitled';

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
    const delegation = yield* makeDelegationServer;
    const runDelegation = yield* FiberSet.makeRuntimePromise();
    /** Retry keys belong to the parent Session and its active context, not to one credential. */
    const delegationScope = (session: LiveSession) =>
      `${session.meta.id}:${session.meta.activeContextId}`;
    /** Workers a parent is waiting on right now: bounded so one Turn cannot fan out without limit. */
    const activeDelegations = new Map<SessionId, number>();
    const delegationBindings = new Map<
      SessionId,
      { readonly revoke: () => void; acp: AcpSession | undefined }
    >();
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

    const currentLocale = Effect.map(settings.get, ({ language }) => resolveLocale(language));

    /** The Session's options folded from its ACP config options, applying catalog eligibility filters. */
    const foldedOptions = (
      session: LiveSession,
      locale: Locale = 'en',
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
      const modelsLimitation =
        filtered.excludedNote === undefined
          ? undefined
          : (agentCopy(locale, session.agent.id)?.excludedNote ?? filtered.excludedNote);
      const firstEligible = filtered.models[0];
      if (firstEligible === undefined) {
        const { model: _drop, ...rest } = raw;
        return { options: rest, modelsLimitation };
      }
      const value = filtered.models.some((choice) => choice.id === raw.model?.value)
        ? raw.model.value
        : undefined;
      return {
        options: {
          ...raw,
          model: {
            ...(value === undefined ? {} : { value }),
            choices: filtered.models,
          },
        },
        modelsLimitation,
      };
    };

    const optionsOf = (session: LiveSession) => foldedOptions(session).options;

    const effectivePermissionMode = (
      entry: CatalogEntry,
      mode: LiveState['options']['permissionMode'],
    ) => (!entry.capabilities.askMode && mode === 'ask' ? ('auto' as const) : mode);

    const agentLiveFields = (entry: CatalogEntry, locale: Locale = 'en'): Partial<LiveState> => {
      const copy = agentCopy(locale, entry.id);
      const installInstructions = copy?.installInstructions ?? entry.installInstructions;
      const loginInstructions = copy?.loginInstructions ?? entry.loginInstructions;
      const upgradeCommand = copy?.upgradeCommand ?? entry.upgradeCommand;
      return {
        imageLimits: entry.imageLimits,
        agentName: entry.name,
        agentId: entry.id,
        agentPackage: entry.package,
        capabilities: entry.capabilities,
        installKind: entry.installKind,
        ...(installInstructions === undefined ? {} : { installInstructions }),
        ...(loginInstructions === undefined ? {} : { loginInstructions }),
        ...(upgradeCommand === undefined ? {} : { upgradeCommand }),
      };
    };

    const makeLive = Effect.fnUntraced(function* (
      meta: SessionMeta,
      prompted: boolean,
      agentStatus: LiveState['agentStatus'],
    ) {
      const locale = yield* currentLocale;
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
          commandsLoaded: false,
          queue: [],
          canAttachImages: false,
          imageLimits: agent.imageLimits,
          ...agentLiveFields(agent, locale),
          contextUsage: initialContextUsage,
          ...(meta.memoryLost === true ? { memoryLost: true } : {}),
        },
        acp: undefined,
        acpCapabilities: undefined,
        queue: [],
        draining: false,
        steeringSupported: false,
        prompted,
        running: undefined,
        turnHops: 0,
        prompting: undefined,
        stopRequested: false,
        config: [],
        wanted: {
          model: meta.model === undefined ? {} : { pinned: meta.model },
          effort: meta.effort === undefined ? {} : { pinned: meta.effort },
        },
        clearing: false,
        compacting: undefined,
        handoffRunning: undefined,
        compactionReported: false,
        deleted: false,
        permissions: new Map(),
        steeringLock: (yield* Semaphore.make(1)).withPermit,
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

    /**
     * The direct native Workers of a reopened Session that were working when the app went away. Their activity is
     * unknown until the adapter reports it again, so they are listed as such, never as running. A Spence-owned
     * Worker ran in the process that is gone, so it is known idle and is not listed.
     */
    const restoredWorkers = Effect.fnUntraced(function* (parentId: SessionId) {
      const children = (yield* store.listAll).filter(
        (meta) =>
          meta.parentSessionId === parentId && isNativeWorker(meta) && !deleting.has(meta.id),
      );
      const workers: Array<WorkerInfo> = [];
      for (const child of children) {
        const active =
          child.workerActive ?? closeInterrupted(yield* store.replay(child.id)).length > 0;
        if (!active) continue;
        workers.push({
          sessionId: child.id,
          title: child.userTitle ?? child.autoTitle ?? 'Worker',
          state: 'unknown',
          agentId: child.agentId,
        });
      }
      return workers.length === 0 ? {} : { workers };
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
        if (isNativeWorker(meta)) {
          // A native Worker cut off mid-Turn was working when the app went away: remember it for its Parent.
          yield* store
            .updateMeta(id, (current) => ({
              ...current,
              workerActive: current.workerActive ?? true,
            }))
            .pipe(Effect.orDie);
        }
        yield* append(session, interrupted);
        yield* store.flush(id).pipe(Effect.orDie);
      }
      session.state = { ...session.state, ...(yield* restoredWorkers(id)) };
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
      // A Worker asked the user something through this Session; the user's own next Message answers it.
      let asked = false;
      for (const item of items) {
        if (item._tag === 'Message' && item.role === 'user') {
          if (item.from === undefined) asked = false;
          else if (item.from.needsUser === true || item.from.projectName !== undefined)
            asked = true;
        }
        if (item._tag === 'ContextCleared') asked = false;
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
      return pending.size > 0 || asked
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
          ? (attentionOf(
              events.map((event) => event.item),
              session.state.agentStatus,
            ) ??
            (session.queue.some(
              (item) => item.from?.needsUser === true || item.from?.projectName !== undefined,
            )
              ? 'needsAnswer'
              : undefined))
          : undefined;
      const cancelGrace: CancelGrace | undefined =
        session.cancelGracePhase !== undefined &&
        (session.running !== undefined || session.compacting !== undefined)
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
        queue: session.queue,
        ...(session.steeringSupported ? { steeringSupported: true } : {}),
        ...(attention === undefined ? {} : { attention }),
        ...(session.running === undefined ? {} : { runningTurn: session.running.turnId }),
        ...(cancelGrace === undefined ? {} : { cancelGrace }),
        ...(unconfirmedExit === undefined ? {} : { unconfirmedExit }),
        ...(session.compacting === undefined ? {} : { compacting: true }),
        ...(session.handoffRunning === undefined ? {} : { handoffRunning: true }),
        ...(session.meta.parentSessionId === undefined
          ? {}
          : {
              parentSessionId: session.meta.parentSessionId,
              workerKind: session.meta.workerKind ?? 'native',
            }),
        ...(session.meta.forkLineage === undefined
          ? {}
          : { forkLineage: session.meta.forkLineage }),
        ...(session.meta.forks === undefined ? {} : { forks: session.meta.forks }),
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

    const publishOwnedWorker = Effect.fnUntraced(function* (
      session: LiveSession,
      items: ReadonlyArray<TranscriptItem> = [],
    ) {
      if (!isOwnedWorker(session.meta)) return;
      const parent = open.get(session.meta.parentSessionId);
      if (parent === undefined || parent.deleted) return;
      const prior = parent.state.workers?.find((item) => item.sessionId === session.meta.id);
      const state =
        session.running === undefined
          ? ('idle' as const)
          : session.permissions.size > 0
            ? ('requiresAction' as const)
            : ('running' as const);
      const now = yield* Clock.currentTimeMillis;
      const startedAt =
        state === 'idle'
          ? undefined
          : prior !== undefined && prior.state !== 'idle' && prior.state !== 'unknown'
            ? (prior.startedAt ?? now)
            : now;
      const latest = items.flatMap((item) => (item._tag === 'Step' ? [item] : [])).at(-1);
      const action =
        state === 'idle'
          ? undefined
          : latest === undefined
            ? prior?.action
            : latest.status === 'running' || latest.status === 'pending'
              ? {
                  kind: latest.kind,
                  target:
                    latest.kind === 'read' ||
                    latest.kind === 'edit' ||
                    latest.kind === 'delete' ||
                    latest.kind === 'move'
                      ? (latest.files[0] ?? latest.title)
                      : latest.title,
                }
              : undefined;
      const modelOption = session.state.options.model;
      const modelName = modelOption?.choices.find(
        (choice) => choice.id === modelOption.value,
      )?.name;
      const turnId = prior?.turnId ?? parent.running?.turnId;
      const worker = {
        sessionId: session.meta.id,
        title: session.state.title.user ?? session.state.title.auto ?? 'Worker',
        state,
        agentId: session.meta.agentId,
        agentName: session.agent.name,
        ...(modelName === undefined ? {} : { modelName }),
        ...(turnId === undefined ? {} : { turnId }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(action === undefined ? {} : { action }),
      };
      parent.state = {
        ...parent.state,
        workers: [
          ...(parent.state.workers ?? []).filter((item) => item.sessionId !== worker.sessionId),
          worker,
        ],
      };
      yield* snapshot(parent).pipe(Effect.flatMap((next) => publishState(parent, next)));
    });

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
        return snapshot(session).pipe(
          Effect.flatMap((state) => publishState(session, state)),
          Effect.andThen(publishOwnedWorker(session)),
        );
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
            Effect.tap(() =>
              items.some(
                (item) =>
                  item._tag === 'TurnStarted' ||
                  item._tag === 'TurnEnded' ||
                  item._tag === 'PermissionRequest' ||
                  item._tag === 'Step',
              )
                ? publishOwnedWorker(session, items)
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

    const endTurn = Effect.fnUntraced(function* (
      session: LiveSession,
      outcome: TurnOutcome,
    ): Effect.fn.Return<void> {
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
      const actualModel = foldedOptions(session).options.model?.value;
      yield* refreshGraceHolders(session.meta.agentId);
      // Steps the Agent left unfinished (it was stopped, or went away) end with their Turn.
      yield* append(session, [
        ...cancelSteps(running),
        {
          _tag: 'TurnEnded',
          turnId: running.turnId,
          outcome,
          ...(actualModel === undefined ? {} : { actualModel }),
        },
      ]);
      yield* store.flush(session.meta.id).pipe(Effect.orDie);
      // A queued Message starts the next Turn once the Turn settles, except after a failure: then the Queue waits.
      if (outcome._tag !== 'failed') yield* drainQueue(session);
    });

    const onEvent = Effect.fnUntraced(function* (session: LiveSession, event: AcpSessionEvent) {
      switch (event._tag) {
        case 'WorkerState': {
          if (event.state === 'running' || event.state === 'requires_action') {
            if (session.running === undefined) {
              const turnId = TurnId.make(randomUUID());
              session.running = openTurn(turnId, session.meta.cwd);
              yield* append(session, [
                turnStarted(turnId, session.agent.id, session.state.options),
              ]);
            }
          } else if (event.state === 'idle' && session.running !== undefined) {
            const running = session.running;
            session.running = undefined;
            const reason = event.stopReason;
            const outcome: TurnOutcome =
              reason === 'end_turn' ||
              reason === 'cancelled' ||
              reason === 'refusal' ||
              reason === 'max_tokens' ||
              reason === 'max_turn_requests'
                ? outcomeOf(reason)
                : {
                    _tag: 'failed',
                    reason: 'agentError',
                    detail:
                      reason === null
                        ? 'Worker stopped without a reported outcome'
                        : `Worker stopped: ${reason}`,
                  };
            yield* append(session, [
              ...cancelSteps(running),
              { _tag: 'TurnEnded', turnId: running.turnId, outcome },
            ]);
            yield* store.flush(session.meta.id).pipe(Effect.orDie);
          }
          return;
        }
        case 'Update': {
          if (event.update.sessionUpdate === 'subagent_update') {
            const update = event.update;
            const parentAcp = session.acp;
            if (parentAcp === undefined || session.deleted) return;
            const now = yield* Clock.currentTimeMillis;
            const contextId = AgentContextId.make(randomUUID());
            const nativeId = AcpSessionId.make(update.sessionId);
            const meta = yield* store
              .ensureWorker(
                {
                  id: SessionId.make(randomUUID()),
                  projectId: session.meta.projectId,
                  cwd: update.cwd ?? session.meta.cwd,
                  agentId: session.meta.agentId,
                  parentSessionId: session.meta.id,
                  autoTitleIsPlaceholder: false,
                  ...(update.title === null || update.title === undefined
                    ? {}
                    : { autoTitle: update.title }),
                  createdAt: now,
                  lastActivityAt: now,
                  activeContextId: contextId,
                  contexts: [
                    {
                      id: contextId,
                      agentId: session.meta.agentId,
                      acpSessionIds: [nativeId],
                      createdAt: now,
                    },
                  ],
                  permissionMode: session.meta.permissionMode,
                },
                nativeId,
                session.meta.activeContextId,
              )
              .pipe(Effect.orDie);
            let child = open.get(meta.id);
            if (child === undefined) {
              child = yield* makeLive(meta, true, 'ready');
              open.set(meta.id, child);
            }
            if (child.acp === undefined) {
              const acp = yield* parentAcp.attachWorker(nativeId).pipe(Effect.orDie);
              child.acp = acp;
              yield* Effect.forkIn(read(child, acp), scope);
            }
            const prior = session.state.workers?.find((worker) => worker.sessionId === meta.id);
            const rawState = update.state?.state;
            const state =
              rawState === 'running'
                ? 'running'
                : rawState === 'requires_action'
                  ? 'requiresAction'
                  : rawState === 'idle'
                    ? 'idle'
                    : rawState === undefined && update.state !== null
                      ? (prior?.state ?? 'unknown')
                      : 'unknown';
            const turnId = prior?.turnId ?? session.running?.turnId;
            if (state !== 'unknown') {
              const active = state !== 'idle';
              if (meta.workerActive !== active) {
                yield* store
                  .updateMeta(meta.id, (current) => ({ ...current, workerActive: active }))
                  .pipe(Effect.orDie);
              }
            }
            const worker = {
              sessionId: meta.id,
              title:
                update.title === undefined
                  ? (prior?.title ?? meta.autoTitle ?? 'Worker')
                  : (update.title ?? 'Worker'),
              state,
              ...(turnId === undefined ? {} : { turnId }),
            } as const;
            yield* setState(session, {
              workers: [
                ...(session.state.workers ?? []).filter((item) => item.sessionId !== meta.id),
                worker,
              ],
            });
            return;
          }
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
              commands: toCommands(event.update.availableCommands, session.agent.name),
              commandsLoaded: true,
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
            const locale = yield* currentLocale;
            const { options, modelsLimitation } = foldedOptions(session, locale);
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
          if (session.running === undefined && isNativeWorker(session.meta)) {
            const turnId = TurnId.make(randomUUID());
            session.running = openTurn(turnId, session.meta.cwd);
            yield* append(session, [turnStarted(turnId, session.agent.id, session.state.options)]);
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
      yield* clearCancelGrace(session);
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
      yield* drainQueue(session);
    });

    /** The ACP session is gone (closed, or its Agent stopped): the next Turn opens another. */
    const detach = (session: LiveSession, acp: AcpSession) =>
      Effect.sync(() => {
        if (session.acp === acp) {
          session.acp = undefined;
          const binding = delegationBindings.get(session.meta.id);
          if (binding?.acp === acp) {
            binding.revoke();
            delegationBindings.delete(session.meta.id);
          }
          session.steeringSupported = false;
        }
      });

    /** Reads the ACP session's events for as long as it lives; a dead Agent fails only a running Turn. */
    /** Native Workers announced through a lost connection are unknown until the adapter reports them again. */
    const markWorkersUnknown = (session: LiveSession) =>
      Effect.suspend(() => {
        const workers = session.state.workers;
        // A Spence-owned Worker has its own connection, which this one does not carry.
        const lost = (worker: WorkerInfo) =>
          (worker.state === 'running' || worker.state === 'requiresAction') &&
          !isOwnedWorker(open.get(worker.sessionId)?.meta);
        if (session.deleted || workers === undefined || !workers.some(lost)) return Effect.void;
        return setState(session, {
          workers: workers.map((worker) =>
            lost(worker) ? { ...worker, state: 'unknown' as const } : worker,
          ),
        });
      });

    const read = (session: LiveSession, acp: AcpSession): Effect.Effect<void> =>
      acp.events.pipe(
        Stream.runForEach((event) => onEvent(session, event)),
        Effect.andThen(detach(session, acp)),
        Effect.andThen(markWorkersUnknown(session)),
        Effect.catch(
          Effect.fnUntraced(function* (error: AcpError) {
            if (session.deleted) return;
            yield* detach(session, acp);
            yield* markWorkersUnknown(session);
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
      if (session.prompted && reason === 'lost') {
        if (session.meta.memoryLost !== true) {
          const locale = yield* currentLocale;
          yield* append(session, [
            { _tag: 'ContextCleared', reason: 'lost' },
            {
              _tag: 'Notice',
              severity: 'info',
              title: sessionCopy(locale).memoryLostNoticeTitle,
            },
          ]);
          yield* store.startContext(session.meta.id, agent.id).pipe(Effect.orDie);
          yield* store.setMemoryLost(session.meta.id, true).pipe(Effect.orDie);
          session.meta = yield* store.get(session.meta.id).pipe(Effect.orDie);
        }
      } else if (session.prompted && reason !== undefined) {
        yield* append(session, [{ _tag: 'ContextCleared', reason }]);
      }
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
      session.steeringSupported =
        session.agent.nativeSteering === true || opened.manager.steeringSupported;
      session.config = opened.session.configOptions;
      yield* Effect.forkIn(read(session, opened.session), scope);
      yield* applyWanted(session, opened.session, 'model');
      yield* applyWanted(session, opened.session, 'effort');
      const locale = yield* currentLocale;
      const { options, modelsLimitation } = foldedOptions(session, locale);
      const modelChangedOnReopen =
        session.prompted &&
        reason === undefined &&
        savedModel !== undefined &&
        options.model?.value !== savedModel;
      // From now on a new ACP session starts on what this one runs with.
      session.wanted = {
        model: options.model?.value === undefined ? {} : { pinned: options.model.value },
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
        ...(reason === 'lost' ? { memoryLost: true } : {}),
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
        if (isNativeWorker(session.meta)) {
          return Effect.fail(
            new AcpError({
              reason: 'Unsupported',
              detail: 'Worker sessions cannot be opened independently',
            }),
          );
        }
        const agent = session.agent;
        const wasMemoryLost = session.meta.memoryLost === true;
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
            let contextId = session.meta.activeContextId;
            const registered = delegation.register(
              delegationTools(
                session,
                () =>
                  delegationBindings.get(id) === binding &&
                  !session.deleted &&
                  session.agent.id === agent.id &&
                  binding.acp !== undefined &&
                  session.acp === binding.acp &&
                  session.meta.activeContextId === contextId &&
                  session.running !== undefined,
              ),
              () => delegationScope(session),
            );
            const binding = { ...registered, acp: undefined as AcpSession | undefined };
            delegationBindings.get(id)?.revoke();
            delegationBindings.set(id, binding);
            const servers = [binding.server];
            const reopened: Effect.Effect<Reopened, OpenError> =
              session.prompted && reason !== 'cleared'
                ? store.get(id).pipe(
                    Effect.orDie,
                    Effect.flatMap((meta) => {
                      const active = activeContextOf(meta);
                      const last =
                        active !== undefined && active.agentId === session.agent.id
                          ? active.acpSessionIds.at(-1)
                          : undefined;
                      // If a previous Clear already retired the old context before an ACP session opened,
                      // or memoryLost was already recorded on reopen, starting a fresh ACP session does not
                      // append another ContextCleared { reason: 'lost' }.
                      if (
                        wasMemoryLost ||
                        meta.memoryLost === true ||
                        (last === undefined && meta.contexts.length > 1)
                      ) {
                        return manager
                          .newSession(meta.cwd, servers)
                          .pipe(Effect.map((acp) => ({ session: acp, lost: false })));
                      }
                      return reopenAcpSession(manager, last, meta.cwd, servers);
                    }),
                  )
                : manager
                    .newSession(cwd, servers)
                    .pipe(Effect.map((acp) => ({ session: acp, lost: false })));
            return reopened.pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  binding.revoke();
                  if (delegationBindings.get(id) === binding) delegationBindings.delete(id);
                }),
              ),
              Effect.tap(({ session: acp, lost }) =>
                attach(
                  session,
                  { manager, session: acp },
                  reason === 'cleared' ? 'cleared' : lost ? 'lost' : undefined,
                ).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (session.acp === acp && !session.deleted) {
                        contextId = session.meta.activeContextId;
                        binding.acp = acp;
                      } else {
                        binding.revoke();
                        if (delegationBindings.get(id) === binding) delegationBindings.delete(id);
                      }
                    }),
                  ),
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
      parent?: LiveSession,
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
      const permissionMode =
        parent?.state.options.permissionMode ??
        effectivePermissionMode(
          agent,
          project.settings.defaultPermissionMode ?? defaultPermissionMode,
        );
      const wanted = parent?.wanted ?? (yield* wantedForAgent(agent));
      const now = yield* Clock.currentTimeMillis;
      const id = SessionId.make(randomUUID());
      const activeContextId = AgentContextId.make(randomUUID());
      const session = yield* makeLive(
        {
          id,
          projectId,
          cwd: parent?.meta.cwd ?? project.path,
          agentId: agent.id,
          autoTitleIsPlaceholder: false,
          createdAt: now,
          lastActivityAt: now,
          activeContextId,
          contexts: [
            {
              id: activeContextId,
              agentId: agent.id,
              acpSessionIds: [],
              createdAt: now,
            },
          ],
          permissionMode,
          ...(parent === undefined
            ? {}
            : { parentSessionId: parent.meta.id, workerKind: 'owned' as const }),
        },
        false,
        'starting',
      );
      session.wanted = wanted;
      yield* store.createDraft(session.meta);
      open.set(id, session);
      // A new Session is shown in a Tab at once (spec 4.1): the Agent and its ACP session start now, so the Composer
      // is ready by the time the user has typed. The Tabs issue reports closing it.
      if (parent === undefined) {
        yield* requireExitConfirmed({ agentId: agent.id }).pipe(
          Effect.andThen(lifetime.tabActivated(id, openAcp(session), agent.id)),
          Effect.ignore,
          Effect.forkIn(scope),
        );
      }
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
      delegationBindings.get(id)?.revoke();
      delegationBindings.delete(id);
      const wanted = yield* wantedForAgent(nextAgent);
      const permissionMode = effectivePermissionMode(
        nextAgent,
        session.state.options.permissionMode,
      );
      session.agent = nextAgent;
      session.acp = undefined;
      session.steeringSupported = false;
      session.config = [];
      session.wanted = wanted;
      const draftContextId = AgentContextId.make(randomUUID());
      const draftContexts = [
        {
          id: draftContextId,
          agentId: nextAgent.id,
          acpSessionIds: [],
          createdAt: session.meta.createdAt,
        },
      ];
      session.meta = {
        ...session.meta,
        agentId: nextAgent.id,
        activeContextId: draftContextId,
        contexts: draftContexts,
        permissionMode,
      };
      yield* store.updateMeta(id, (meta) => ({
        ...meta,
        agentId: nextAgent.id,
        activeContextId: draftContextId,
        contexts: draftContexts,
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
      const locale = yield* currentLocale;
      session.state = {
        ...baseState,
        ...agentLiveFields(nextAgent, locale),
        agentStatus: 'starting',
        isDraft: true,
        options: { permissionMode },
        commands: [],
        commandsLoaded: false,
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

    const folderOf = (id: SessionId): Effect.Effect<string, SessionError> =>
      lookup(id).pipe(Effect.map((session) => session.meta.cwd));

    const setDraftFolder = Effect.fn('Sessions.setDraftFolder')(function* (
      id: SessionId,
      folder: string,
    ) {
      const session = yield* lookup(id);
      if (session.prompted || session.running !== undefined || session.clearing) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'The folder cannot be changed after a Turn starts',
        });
      }
      if (session.meta.cwd === folder) return;
      delegationBindings.get(id)?.revoke();
      delegationBindings.delete(id);
      session.acp = undefined;
      session.steeringSupported = false;
      session.meta = { ...session.meta, cwd: folder };
      yield* store.updateMeta(id, (meta) => ({ ...meta, cwd: folder }));
      // A start failure belonged to the old folder.
      const { cantStartReason: _dropReason, cantStartDetail: _dropDetail, ...kept } = session.state;
      session.state = {
        ...kept,
        agentStatus: 'starting',
        commands: [],
        commandsLoaded: false,
        canAttachImages: false,
      };
      yield* snapshot(session).pipe(Effect.flatMap((state) => publishState(session, state)));
      yield* requireExitConfirmed({ agentId: session.agent.id }).pipe(
        Effect.andThen(lifetime.replace(id, openAcp(session))),
        Effect.ignore,
        Effect.forkIn(scope),
      );
    });

    const prompt = Effect.fn('Sessions.prompt')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
      from?: MessageSender,
    ): Effect.fn.Return<TurnId, SessionError> {
      const session = yield* lookup(id);
      if (isNativeWorker(session.meta)) {
        return yield* new SessionError({
          reason: 'Unsupported',
          detail: 'Worker prompting is not supported',
        });
      }
      yield* requireExitConfirmed({ agentId: session.meta.agentId });
      const turnId = TurnId.make(randomUUID());
      if (session.meta.memoryLost === true) {
        return yield* new SessionError({
          reason: 'MemoryLost',
          detail: 'Start with empty context or prepare a summary handoff before sending',
        });
      }
      const busy = yield* Effect.sync(() => {
        if (session.running !== undefined || session.clearing || session.compacting !== undefined) {
          return true;
        }
        session.running = openTurn(turnId, session.meta.cwd);
        session.turnHops = from?.hops ?? 0;
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
          }).pipe(Effect.andThen(publishOwnedWorker(session))),
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
        turnStarted(turnId, session.agent.id, session.state.options),
        {
          _tag: 'Message',
          id: MessageId.make(randomUUID()),
          turnId,
          role: 'user',
          parts,
          ...(from === undefined ? {} : { from }),
        },
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
      const guidance =
        '\n\n[Spence guidance: Prefer the Spence delegate tool when delegation is appropriate, to create a writable Worker visible in this app. Native delegation remains available. To coordinate with other Sessions of this delegation tree, use the Spence list_sessions and send_message tools. Follow the user’s instructions.]';
      // The Agent is told who sent it; the Transcript carries the attribution in `from`, not in the text.
      const attribution =
        from === undefined
          ? []
          : [
              {
                type: 'text' as const,
                text: `[Spence message from ${from.title}${from.projectName === undefined ? '' : ` in ${from.projectName}`} (session ${from.sessionId})${from.needsUser === true ? '; the sender needs the user to answer: relay it to the user' : ''}]\n\n`,
              },
            ];
      yield* Effect.forkIn(
        acp
          .prompt([...attribution, ...toAcpPrompt(parts), { type: 'text', text: guidance }])
          .pipe(Effect.ignore),
        scope,
      );
      return turnId;
    });

    /** A Session's ancestors from its Parent up to the root of its delegation tree, from persisted parentage. */
    const ancestorsOf = Effect.fnUntraced(function* (session: LiveSession) {
      const metas = new Map((yield* store.listAll).map((meta) => [meta.id, meta] as const));
      const chain: SessionId[] = [];
      const seen = new Set<SessionId>([session.meta.id]);
      let next = session.meta.parentSessionId;
      while (next !== undefined && !seen.has(next)) {
        chain.push(next);
        seen.add(next);
        next = metas.get(next)?.parentSessionId;
      }
      return chain;
    });

    /** The child's actual terminal answer, or a structured failure or cancellation; never a claim of completion. */
    const delegateWorker = Effect.fn('Sessions.delegateWorker')(function* (
      parent: LiveSession,
      task: string,
    ): Effect.fn.Return<ToolOutcome> {
      if ((yield* ancestorsOf(parent)).length >= MAX_DELEGATION_DEPTH)
        return toolError(
          'DepthLimit',
          `Workers may be nested at most ${MAX_DELEGATION_DEPTH} deep; do this task yourself`,
        );
      const parentId = parent.meta.id;
      const waiting = activeDelegations.get(parentId) ?? 0;
      if (waiting >= MAX_ACTIVE_WORKERS_PER_PARENT)
        return toolError(
          'WorkerLimit',
          `At most ${MAX_ACTIVE_WORKERS_PER_PARENT} Workers may run for one Session at once; wait for one to finish`,
        );
      activeDelegations.set(parentId, waiting + 1);
      return yield* Effect.gen(function* () {
        const id = yield* create(parent.meta.projectId, parent.agent.id, parent);
        const child = yield* lookup(id);
        yield* setState(child, {
          title: {
            auto: task.split(/\r?\n/)[0]?.trim().slice(0, 80) || 'Worker',
            autoIsPlaceholder: true,
          },
        });
        const turnId = yield* prompt(id, [{ _tag: 'text', text: task }]);
        const items = yield* events(id).pipe(
          Stream.takeUntil(
            (item) =>
              item._tag === 'Transcript' &&
              item.event.item._tag === 'TurnEnded' &&
              item.event.item.turnId === turnId,
          ),
          Stream.runCollect,
        );
        let result = '';
        for (const item of items) {
          if (item._tag !== 'Transcript') continue;
          const entry = item.event.item;
          if (entry._tag === 'MessageDelta') result += entry.text;
          if (entry._tag === 'Message' && entry.role === 'agent')
            result += entry.parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');
          if (entry._tag === 'TurnEnded' && entry.turnId === turnId) {
            switch (entry.outcome._tag) {
              case 'done':
                return { text: result };
              case 'cancelled':
                return toolError('WorkerCancelled', 'The Worker was stopped before it finished');
              case 'failed':
                return toolError('WorkerFailed', entry.outcome.detail);
              case 'refused':
                return toolError('WorkerFailed', 'The Worker refused the task');
              case 'cutShort':
                return toolError(
                  'WorkerFailed',
                  `The Worker was cut short: ${entry.outcome.limit}`,
                );
            }
          }
        }
        return toolError('WorkerFailed', 'The Worker ended without a result');
      }).pipe(
        Effect.catchTag('SessionError', (error) =>
          Effect.succeed(toolError('WorkerFailed', error.detail)),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            const left = (activeDelegations.get(parentId) ?? 1) - 1;
            if (left <= 0) activeDelegations.delete(parentId);
            else activeDelegations.set(parentId, left);
          }),
        ),
      );
    });

    const steer = Effect.fn('Sessions.steer')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
    ): Effect.fn.Return<void, SessionError> {
      const session = yield* lookup(id);
      return yield* session.steeringLock(
        Effect.gen(function* () {
          const running = session.running;
          const acp = session.prompting;
          if (running === undefined || acp === undefined) {
            return yield* new SessionError({
              reason: 'NotRunning',
              detail: 'No Turn is running to steer',
            });
          }
          if (!session.steeringSupported || acp.steering === undefined) {
            return yield* new SessionError({
              reason: 'Unsupported',
              detail: `${session.agent.name} cannot steer a running Turn`,
            });
          }
          // Steer supersedes a pending Permission request: it is answered cancelled, then the Message redirects.
          yield* cancelPermissions(session);
          const toSessionError = (error: AcpError): SessionError =>
            new SessionError({ reason: 'Unsupported', detail: error.detail });
          if (acp.steering === 'native') {
            // Native Steering is the running Turn's own prompt: its response ends that Turn and is ignored here.
            yield* Effect.forkIn(
              acp
                .steerNative(toAcpPrompt(parts))
                .pipe(
                  Effect.catch((error) =>
                    Effect.logWarning(`steering could not be delivered: ${error.detail}`),
                  ),
                ),
              scope,
            );
          } else {
            const outcome = yield* acp
              .steer(toAcpPrompt(parts))
              .pipe(Effect.mapError(toSessionError));
            if (outcome === 'notRunning') {
              return yield* new SessionError({
                reason: 'NotRunning',
                detail: 'The Turn ended before the Message could be injected',
              });
            }
          }
          // The request is gone: the steering Message redirects the Turn instead.
          yield* append(session, [
            {
              _tag: 'Message',
              id: MessageId.make(randomUUID()),
              turnId: running.turnId,
              role: 'user',
              parts,
              steer: true,
            },
          ]);
        }),
      );
    });

    /** Sends the Queue head as the next Turn, once nothing else holds the Session. */
    const drainQueue = Effect.fnUntraced(function* (session: LiveSession): Effect.fn.Return<void> {
      if (session.deleted || session.draining) return;
      if (
        session.running !== undefined ||
        session.clearing ||
        session.compacting !== undefined ||
        session.handoffRunning !== undefined
      ) {
        return;
      }
      const head = session.queue[0];
      if (head === undefined) return;
      session.draining = true;
      yield* Effect.gen(function* () {
        session.queue = session.queue.slice(1);
        yield* setState(session, {});
        const sent = yield* prompt(session.meta.id, head.parts, head.from).pipe(Effect.exit);
        if (Exit.isFailure(sent)) {
          // The Turn could not start (Memory lost, a racing Clear, ...): keep the Message queued.
          session.queue = session.queue.some((item) => item.id === head.id)
            ? session.queue
            : [head, ...session.queue];
          yield* setState(session, {});
        }
      }).pipe(Effect.ensuring(Effect.sync(() => (session.draining = false))));
    });

    /** Lines a Message up in the Queue; says whether it started a Turn at once or is still waiting. */
    const enqueueMessage = Effect.fn('Sessions.enqueueMessage')(function* (
      id: SessionId,
      parts: ReadonlyArray<MessagePart>,
      from?: MessageSender,
    ): Effect.fn.Return<'started' | 'queued', SessionError> {
      const session = yield* lookup(id);
      const item: QueuedMessage = {
        id: MessageId.make(randomUUID()),
        parts,
        ...(from === undefined ? {} : { from }),
      };
      session.queue = [...session.queue, item];
      yield* setState(session, {});
      // With no Turn running the Queue sends at once; otherwise the Turn's settlement advances it.
      yield* drainQueue(session);
      return session.queue.some((queued) => queued.id === item.id) ? 'queued' : 'started';
    });

    const enqueue = (id: SessionId, parts: ReadonlyArray<MessagePart>) =>
      enqueueMessage(id, parts).pipe(Effect.asVoid);

    const sessionTitle = (session: LiveSession): string => displayTitle(session.state.title);

    const messageRateAllowed = makeRateLimiter(MESSAGE_RATE_LIMIT, MESSAGE_RATE_WINDOW_MS);

    /** The Sessions of the caller's delegation tree, from persisted parentage only. */
    const listReachable = Effect.fnUntraced(function* (caller: LiveSession) {
      const metas = yield* store.listAll;
      return reachableFrom(caller.meta.id, metas).flatMap((entry) => {
        if (deleting.has(entry.id)) return [];
        const meta = metas.find((candidate) => candidate.id === entry.id);
        if (meta === undefined) return [];
        const live = open.get(entry.id);
        return [
          {
            id: entry.id,
            title: live === undefined ? displayTitle(titleOf(meta)) : sessionTitle(live),
            state: stateOf(live),
            relation: entry.relation,
          },
        ];
      });
    });

    /** The active Projects other than the caller's. */
    const otherProjects = Effect.fnUntraced(function* (caller: LiveSession) {
      return (yield* projects.list).filter((project) => project.id !== caller.meta.projectId);
    });

    const pairAllowed = (
      access: ReadonlyArray<{ readonly from: ProjectId; readonly to: ProjectId }>,
      from: ProjectId,
      to: ProjectId,
    ): boolean => access.some((entry) => entry.from === from && entry.to === to);

    /** Contacts waiting on the user, by sender Session and target Project: a second call joins the first. */
    const pendingContacts = new Map<string, Deferred.Deferred<boolean>>();

    /**
     * Whether the sender's Project may message the target Project: a stored "Always allow", else a normal Permission
     * request in the sender's Session. The Permission mode never answers it; only the user does. Nothing is stored
     * for Allow once or Deny, and a cancelled Turn, a deleted Session or a revoked credential count as Deny.
     */
    const projectAccess = Effect.fnUntraced(function* (
      sender: LiveSession,
      target: Project,
    ): Effect.fn.Return<boolean> {
      const current = yield* settings.get;
      if (pairAllowed(current.crossProjectAccess, sender.meta.projectId, target.id)) return true;
      const key = `${sender.meta.id}|${target.id}`;
      const waiting = pendingContacts.get(key);
      if (waiting !== undefined) return yield* Deferred.await(waiting);
      const running = sender.running;
      if (running === undefined) return false;
      const decided = yield* Deferred.make<boolean>();
      pendingContacts.set(key, decided);
      return yield* Effect.gen(function* () {
        const copy = sessionCopy(resolveLocale(current.language)).crossProject;
        const from = (yield* projects.list).find((project) => project.id === sender.meta.projectId);
        const stepId = StepId.make(randomUUID());
        const step: Step = {
          _tag: 'Step',
          id: stepId,
          turnId: running.turnId,
          title: copy.question(from?.name ?? '', target.name),
          kind: 'other',
          status: 'pending',
          files: [],
          diffs: [],
          output: '',
        };
        const item: PermissionRequest = {
          _tag: 'PermissionRequest',
          id: PermissionRequestId.make(randomUUID()),
          turnId: running.turnId,
          stepId,
          options: [
            { id: 'allow-once', label: copy.allowOnce, kind: 'allowOnce' },
            { id: 'allow-always', label: copy.allowAlways, kind: 'allowAlways' },
            { id: 'deny', label: copy.deny, kind: 'rejectOnce' },
          ],
          state: { _tag: 'pending' },
        };
        const answer = yield* Deferred.make<RequestPermissionOutcome>();
        sender.permissions.set(item.id, { item, answer });
        yield* append(sender, [step, item]);
        const outcome = yield* Deferred.await(answer);
        const choice = outcome.outcome === 'selected' ? outcome.optionId : undefined;
        const allowed = choice === 'allow-once' || choice === 'allow-always';
        if (choice === 'allow-always') {
          const stored = (yield* settings.get).crossProjectAccess;
          if (!pairAllowed(stored, sender.meta.projectId, target.id)) {
            const addedAt = Timestamp.make(yield* Clock.currentTimeMillis);
            yield* settings
              .update({
                crossProjectAccess: [
                  ...stored,
                  { from: sender.meta.projectId, to: target.id, addedAt },
                ],
              })
              .pipe(Effect.ignore);
          }
        }
        yield* append(sender, [{ ...step, status: allowed ? 'done' : 'cancelled' }]);
        return allowed;
      }).pipe(
        Effect.tap((allowed) => Deferred.succeed(decided, allowed)),
        Effect.ensuring(
          Effect.suspend(() => {
            pendingContacts.delete(key);
            return Deferred.succeed(decided, false);
          }),
        ),
      );
    });

    /** A root Session of another active Project that the caller could message, resolved in main from persisted data. */
    const foreignTarget = Effect.fnUntraced(function* (caller: LiveSession, id: string) {
      const meta = (yield* store.listAll).find((candidate) => candidate.id === id);
      if (
        meta === undefined ||
        deleting.has(meta.id) ||
        meta.projectId === caller.meta.projectId ||
        meta.parentSessionId !== undefined ||
        meta.archivedAt !== undefined
      ) {
        return undefined;
      }
      const project = (yield* otherProjects(caller)).find((entry) => entry.id === meta.projectId);
      return project === undefined ? undefined : { meta, project };
    });

    const stateOf = (live: LiveSession | undefined) =>
      live?.running === undefined
        ? 'idle'
        : live.permissions.size > 0
          ? 'requiresAction'
          : 'running';

    /** `list_sessions` with a `projectId`: the Sessions of another Project, once the user allowed the pair. */
    const listForeignSessions = Effect.fnUntraced(function* (
      caller: LiveSession,
      projectId: string,
    ): Effect.fn.Return<ToolOutcome> {
      const project = (yield* otherProjects(caller)).find((entry) => entry.id === projectId);
      if (project === undefined) return toolError('NotReachable', 'No such other Project');
      if (!(yield* projectAccess(caller, project)))
        return toolError('PermissionDenied', 'The user did not allow messaging that Project');
      const metas = (yield* store.listAll).filter(
        (meta) =>
          meta.projectId === project.id &&
          meta.parentSessionId === undefined &&
          meta.archivedAt === undefined &&
          !deleting.has(meta.id),
      );
      const sessions = metas.map((meta) => {
        const live = open.get(meta.id);
        return {
          id: meta.id,
          title: live === undefined ? displayTitle(titleOf(meta)) : sessionTitle(live),
          state: stateOf(live),
          project: project.name,
        };
      });
      return { text: JSON.stringify({ sessions }) };
    });

    /** `send_message` to a Session outside the delegation tree: only another Project, only with the user's say. */
    const sendAcrossProjects = Effect.fnUntraced(function* (
      sender: LiveSession,
      input: { readonly to: string; readonly text: string; readonly needsUser: boolean },
      hops: number,
    ): Effect.fn.Return<ToolOutcome> {
      const found = yield* foreignTarget(sender, input.to);
      if (found === undefined)
        return toolError('NotReachable', 'No such Session in your delegation tree');
      if (input.needsUser)
        return toolError('InvalidTarget', 'A message that needs the user goes to your Parent');
      if (!(yield* projectAccess(sender, found.project)))
        return toolError('PermissionDenied', 'The user did not allow messaging that Project');
      // The wait may have outlived the Session or its Project: resolve again before delivering.
      const target = yield* foreignTarget(sender, input.to);
      if (target === undefined)
        return toolError('NotReachable', 'That Session or its Project is gone');
      // The quota is charged only once the user has allowed the message, so a denied one costs nothing.
      const now = yield* Clock.currentTimeMillis;
      if (!messageRateAllowed(`${sender.meta.projectId}>${target.project.id}`, now))
        return toolError(
          'RateLimited',
          'Too many messages between these Projects; wait before sending more',
        );
      const senderProject = (yield* projects.list).find(
        (project) => project.id === sender.meta.projectId,
      );
      const from: MessageSender = {
        sessionId: sender.meta.id,
        title: sessionTitle(sender),
        hops,
        projectName: senderProject?.name ?? '',
      };
      const delivered = yield* enqueueMessage(
        target.meta.id,
        [{ _tag: 'text', text: input.text }],
        from,
      ).pipe(Effect.exit);
      if (Exit.isFailure(delivered)) {
        const failure = Cause.squash(delivered.cause);
        return toolError(
          'DeliveryFailed',
          failure instanceof SessionError ? failure.detail : 'The message could not be delivered',
        );
      }
      const locale = resolveLocale((yield* settings.get).language);
      const live = open.get(target.meta.id);
      yield* append(sender, [
        {
          _tag: 'Notice',
          severity: 'info',
          title: sessionCopy(locale).crossProject.sentNotice(
            live === undefined ? displayTitle(titleOf(target.meta)) : sessionTitle(live),
            target.project.name,
          ),
          description: input.text,
        },
      ]);
      return {
        text: JSON.stringify({ delivered: true, delivery: delivered.value, to: target.meta.id }),
      };
    });

    /** `send_message`: the target is picked from the tree Spence derives, never from caller-supplied scope. */
    const sendSessionMessage = Effect.fnUntraced(function* (
      sender: LiveSession,
      input: { readonly to: string; readonly text: string; readonly needsUser: boolean },
    ): Effect.fn.Return<ToolOutcome> {
      const hops = sender.turnHops + 1;
      if (hops > MAX_MESSAGE_HOPS)
        return toolError(
          'HopLimit',
          'This conversation has bounced between Sessions too many times',
        );
      const target = (yield* listReachable(sender)).find((entry) => entry.id === input.to);
      if (target === undefined) return yield* sendAcrossProjects(sender, input, hops);
      if (input.needsUser && target.relation !== 'parent')
        return toolError('InvalidTarget', 'A message that needs the user goes to your Parent');
      // The quota is charged only for a message that may be delivered, and there is one per delegation tree, so
      // spawning Workers does not multiply it.
      const now = yield* Clock.currentTimeMillis;
      const root = (yield* ancestorsOf(sender)).at(-1) ?? sender.meta.id;
      if (!messageRateAllowed(root, now))
        return toolError('RateLimited', 'Too many messages; wait before sending more');
      const from: MessageSender = {
        sessionId: sender.meta.id,
        title: sessionTitle(sender),
        hops,
        ...(input.needsUser ? { needsUser: true } : {}),
      };
      return yield* enqueueMessage(target.id, [{ _tag: 'text', text: input.text }], from).pipe(
        Effect.map((delivery): ToolOutcome => ({
          text: JSON.stringify({ delivered: true, delivery, to: target.id }),
        })),
        Effect.catchTag('SessionError', (error) =>
          Effect.succeed(toolError('DeliveryFailed', error.detail)),
        ),
      );
    });

    /**
     * What one credential may do: every call needs the live Turn of the context it was issued for (`active`),
     * so a stale, foreign or revoked caller can neither delegate nor message.
     */
    const delegationTools = (session: LiveSession, active: () => boolean): DelegationTools => {
      const guarded = <E>(effect: Effect.Effect<ToolOutcome, E>) =>
        runDelegation(
          Effect.suspend(() =>
            active()
              ? effect
              : Effect.succeed(
                  toolError('NotActive', 'This capability is no longer active: its Turn has ended'),
                ),
          ),
        );
      return {
        delegate: (task) => guarded(delegateWorker(session, task)),
        listSessions: (input) =>
          guarded(
            input.projectId === undefined
              ? Effect.gen(function* () {
                  const sessions = yield* listReachable(session);
                  const access = (yield* settings.get).crossProjectAccess;
                  const others = (yield* otherProjects(session)).map((project) => ({
                    id: project.id,
                    name: project.name,
                    allowed: pairAllowed(access, session.meta.projectId, project.id),
                  }));
                  return { text: JSON.stringify({ sessions, projects: others }) };
                })
              : listForeignSessions(session, input.projectId),
          ),
        sendMessage: (input) => guarded(sendSessionMessage(session, input)),
      };
    };

    const setQueue = Effect.fn('Sessions.setQueue')(function* (
      id: SessionId,
      queue: ReadonlyArray<QueuedMessage>,
    ): Effect.fn.Return<void, SessionError> {
      const session = yield* lookup(id);
      session.queue = [...queue];
      yield* setState(session, {});
    });

    const clearQueue = Effect.fn('Sessions.clearQueue')(function* (
      id: SessionId,
    ): Effect.fn.Return<void, SessionError> {
      const session = yield* lookup(id);
      session.queue = [];
      yield* setState(session, {});
    });

    /** Cancels the Session's own running work; says whether the Agent refused or could not be reached. */
    const cancelOwn = Effect.fn('Sessions.cancelOwn')(function* (
      session: LiveSession,
    ): Effect.fn.Return<'refused' | undefined> {
      const id = session.meta.id;
      const activeAcp = yield* Effect.sync(() => {
        if (session.running !== undefined) {
          if (session.prompting === undefined) session.stopRequested = true;
          return session.prompting;
        }
        if (session.compacting !== undefined) {
          session.compacting.cancelled = true;
          return session.compacting.acp;
        }
        if (session.handoffRunning !== undefined) {
          session.handoffRunning.cancelled = true;
          return session.handoffRunning.acp;
        }
        return undefined;
      });
      if (
        session.running === undefined &&
        session.compacting === undefined &&
        session.handoffRunning === undefined
      ) {
        return undefined;
      }
      // A failed cancel usually means the Agent is gone and its events report that; the caller is told too.
      const refused =
        activeAcp === undefined
          ? undefined
          : yield* activeAcp.cancel.pipe(
              Effect.as(undefined),
              Effect.catch((error) =>
                Effect.logWarning(`stop was not accepted: ${error.detail}`).pipe(
                  Effect.as('refused' as const),
                ),
              ),
            );
      yield* cancelPermissions(session);
      if (
        (session.running !== undefined || session.compacting !== undefined) &&
        !session.deleted &&
        session.cancelGracePhase === undefined
      ) {
        session.cancelGracePhase = 'waiting';
        yield* lifetime.markCancelPending(id, session.meta.agentId);
        const timer = yield* Effect.gen(function* () {
          yield* Effect.sleep(CANCEL_GRACE);
          if (
            session.deleted ||
            (session.running === undefined && session.compacting === undefined) ||
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
      return refused;
    });

    /**
     * Stop reaches the Session's Spence-owned Worker descendants through their own Sessions: each cancels its own
     * running Turn, which is what ends it, and passes Stop on to its own Workers. Nothing here marks a Worker stopped;
     * its Turn outcome does. Ancestors and siblings are never visited. Native Workers have no cancellation path
     * (`AcpSession.cancel` refuses a Worker), so they are left as the adapter reports them.
     */
    const cancel: SessionsShape['cancel'] = Effect.fn('Sessions.cancel')(function* (id: SessionId) {
      const session = yield* lookup(id);
      const refused = yield* cancelOwn(session);
      const parent =
        isOwnedWorker(session.meta) && refused !== undefined
          ? open.get(session.meta.parentSessionId)
          : undefined;
      // A Worker that did not accept Stop is not claimed stopped: its Parent's Transcript says so.
      if (parent !== undefined && !parent.deleted) {
        const locale = resolveLocale((yield* settings.get).language);
        yield* append(parent, [
          {
            _tag: 'Notice',
            severity: 'warning',
            title: sessionCopy(locale).workerStopFailed(sessionTitle(session)),
          },
        ]);
      }
      const owned = [...open.values()].filter(
        (child) => child.meta.parentSessionId === id && isOwnedWorker(child.meta),
      );
      yield* Effect.forEach(
        owned,
        (child) =>
          cancel(child.meta.id).pipe(
            Effect.catch((error) =>
              Effect.logWarning(`a Worker could not be stopped: ${error.detail}`),
            ),
          ),
        { concurrency: 'unbounded', discard: true },
      );
    });

    const stopAgent = Effect.fn('Sessions.stopAgent')(function* (id: SessionId, force = false) {
      const session = yield* lookup(id);
      const agentId = session.handoffRunning?.targetAgentId ?? session.meta.agentId;
      const targetAgentName =
        session.handoffRunning !== undefined
          ? (catalog.get(agentId)?.name ?? session.agent.name)
          : session.agent.name;
      yield* requireExitConfirmed({ agentId });

      const others = yield* lifetime.otherWorking(id, agentId);
      if (others.length > 0 && !force) {
        return {
          _tag: 'confirmRequired',
          otherWorkingCount: others.length,
          agentName: targetAgentName,
        } as const;
      }

      // End active Turns as interrupted and detach all open ACP sessions on this Agent BEFORE killing its process,
      // so Scope finalizer's `AcpError(Exited)` never overwrites `interrupted` with `agentStopped`.
      for (const openSession of open.values()) {
        if (openSession.meta.agentId !== agentId || openSession.deleted) continue;
        const wasRunning = openSession.running !== undefined;
        const wasCompacting = openSession.compacting !== undefined;
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
        if (wasCompacting) {
          yield* setState(openSession, {
            agentStatus: 'stopped',
            contextUsage: historicalOf(openSession.state.contextUsage),
          });
          yield* endStandaloneCompaction(openSession, 'cancelled');
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

    /**
     * A Worker never has broader Permission mode than its Parent: 'ask' is the stricter mode, so while the Parent
     * asks, so does the Worker. `undefined` means the Parent sets no ceiling.
     */
    const permissionCeiling = Effect.fnUntraced(function* (session: LiveSession) {
      const parentId = session.meta.parentSessionId;
      if (!isOwnedWorker(session.meta) || parentId === undefined) return undefined;
      const parentMode =
        open.get(parentId)?.state.options.permissionMode ??
        (yield* store.get(parentId).pipe(
          Effect.map((meta) => meta.permissionMode),
          Effect.orElseSucceed(() => undefined),
        ));
      return parentMode === 'ask' ? ('ask' as const) : undefined;
    });

    /** Lowers every owned descendant to 'ask' (live ones through their Session, the rest in the store). */
    const lowerWorkers = Effect.fnUntraced(function* (parentId: SessionId): Effect.fn.Return<void> {
      const children = (yield* store.listAll).filter(
        (meta) => meta.parentSessionId === parentId && isOwnedWorker(meta),
      );
      for (const child of children) {
        if (open.has(child.id)) {
          yield* setOption({
            sessionId: child.id,
            option: 'permissionMode',
            value: 'ask',
          }).pipe(Effect.ignore);
        } else {
          yield* store.setOptions(child.id, { permissionMode: 'ask' });
          yield* lowerWorkers(child.id);
        }
      }
    });

    const setOption = Effect.fn('Sessions.setOption')(function* (
      change: SessionOptionChange,
    ): Effect.fn.Return<void, SessionError> {
      const { sessionId: id } = change;
      const session = yield* lookup(id);
      const agent = session.agent;
      if (change.option === 'permissionMode') {
        const wanted = (yield* permissionCeiling(session)) ?? change.value;
        const nextMode =
          session.state.capabilities?.askMode === false && wanted === 'ask'
            ? 'auto'
            : effectivePermissionMode(agent, wanted);
        yield* setState(session, {
          options: { ...session.state.options, permissionMode: nextMode },
        });
        yield* store.setOptions(id, { permissionMode: nextMode });
        if (session.acp !== undefined) yield* applyPermissionMode(session, session.acp);
        if (nextMode === 'ask') yield* lowerWorkers(id);
        return;
      }
      const { option, value } = change;
      // The renderer offers only the choices the live state lists; anything else is a bug, not a user's choice.
      if (option === 'effort' && !isEffort(value)) {
        return yield* Effect.die(`not an Effort level: ${value}`);
      }
      if (
        option === 'model' &&
        session.prompted &&
        !agent.capabilities.modelChangePreservesContext &&
        session.state.options.model?.value !== value
      ) {
        return yield* new SessionError({
          reason: 'Unsupported',
          detail: `${agent.name} requires a reviewed Summary handoff to change Model`,
        });
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
      const locale = yield* currentLocale;
      const { options, modelsLimitation } =
        acp === undefined
          ? { options: session.state.options, modelsLimitation: session.state.modelsLimitation }
          : foldedOptions(session, locale);
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
      yield* store.startContext(id, session.agent.id).pipe(Effect.orDie);
      yield* store
        .updateMeta(id, (meta) => withSavedContextUsage(meta, undefined))
        .pipe(Effect.orDie);
      session.meta = yield* store.get(id).pipe(Effect.orDie);
      yield* setState(session, { contextUsage: { _tag: 'unavailable' }, memoryLost: false });
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
      const acp = yield* lifetime.turnStarted(id, openAcp(session), session.meta.agentId).pipe(
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

    const startEmptyContext = Effect.fn('Sessions.startEmptyContext')(function* (id: SessionId) {
      const session = yield* lookup(id);
      yield* store.setMemoryLost(id, false).pipe(Effect.orDie);
      yield* store.flush(id).pipe(Effect.orDie);
      session.meta = yield* store.get(id).pipe(Effect.orDie);
      yield* setState(session, { memoryLost: false });
    });

    const isSessionBusy = (session: LiveSession): boolean =>
      session.running !== undefined ||
      session.clearing ||
      session.compacting !== undefined ||
      session.handoffRunning !== undefined;

    const compatibilityForTarget = Effect.fnUntraced(function* (
      session: LiveSession,
      target: CatalogEntry,
      images: ReadonlyArray<ReturnType<typeof extractHandoffImages>[number]>,
      requestedModel?: string,
      selectedImageIds?: ReadonlyArray<string>,
    ) {
      const listed = yield* agents.list;
      const installed = listed.find((entry) => entry.id === target.id)?.installed ?? false;
      const unconfirmedExit = yield* unconfirmedExitOf(target.id);
      const memory = yield* remembered.get(target.id);
      const allSettings = yield* settings.get;
      const locale = resolveLocale(allSettings.language);
      const agentSetting = allSettings.agents[target.id];
      const liveManager = yield* acpClient.connected(target.id);
      const liveModels =
        target.id === session.agent.id ? session.state.options.model?.choices : undefined;
      const liveCapabilities =
        target.id === session.agent.id ? session.state.capabilities : undefined;

      return resolveHandoffCompatibility({
        target,
        installed: installed || liveManager !== undefined,
        unconfirmedExit,
        memory,
        ...(agentSetting?.model === undefined ? {} : { defaultModel: agentSetting.model }),
        ...(agentSetting?.effort === undefined ? {} : { defaultEffort: agentSetting.effort }),
        ...(liveCapabilities === undefined ? {} : { liveCapabilities }),
        ...(liveModels === undefined ? {} : { liveModels }),
        sourceAgentId: session.agent.id,
        ...(session.state.options.model?.value === undefined
          ? {}
          : { sourceModel: session.state.options.model.value }),
        ...(session.state.options.effort?.value === undefined
          ? {}
          : { sourceEffort: session.state.options.effort.value }),
        sourcePermissionMode: session.state.options.permissionMode,
        ...(session.state.contextUsage === undefined
          ? {}
          : { sourceContextUsage: session.state.contextUsage }),
        ...(requestedModel === undefined ? {} : { requestedModel }),
        images,
        ...(selectedImageIds === undefined ? {} : { selectedImageIds }),
        locale,
      });
    });

    const prepareHandoff = Effect.fn('Sessions.prepareHandoff')(function* (input: {
      readonly sessionId: SessionId;
      readonly kind: HandoffKind;
      readonly targetAgentId?: AgentId;
      readonly targetModel?: string;
    }) {
      const session = yield* lookup(input.sessionId);
      if (isSessionBusy(session)) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'Finish or cancel the active Turn or Compaction before starting a handoff.',
        });
      }
      const transcript = session.prompted
        ? yield* store.replay(input.sessionId).pipe(Effect.orDie)
        : [];
      const endpoint = computeSourceEndpoint(input.sessionId, transcript);
      const images = extractHandoffImages(transcript);
      const fallbackSummary = buildStructuredTranscriptExtract(transcript);
      const canRunOutgoing =
        session.state.agentStatus === 'ready' || session.state.agentStatus === 'stopped';
      const locale = yield* currentLocale;
      const drafted = yield* draftSummaryWithFallback(
        session.agent,
        canRunOutgoing,
        session.meta.cwd,
        fallbackSummary,
        locale,
      ).pipe(Effect.provideService(AcpClient, acpClient));

      const destinations: Array<HandoffCompatibility> = [];
      for (const entry of catalog.entries) {
        const compat = yield* compatibilityForTarget(
          session,
          entry,
          images,
          entry.id === (input.targetAgentId ?? session.agent.id) ? input.targetModel : undefined,
        );
        destinations.push(compat);
      }

      const defaultDestination =
        input.targetAgentId ??
        (input.kind === 'switch'
          ? (destinations.find((d) => d.agentId !== session.agent.id && d.canRun)?.agentId ??
            destinations.find((d) => d.agentId !== session.agent.id)?.agentId ??
            session.agent.id)
          : session.agent.id);

      return {
        kind: input.kind,
        endpoint,
        summary: drafted.summary,
        draftSource: drafted.draftSource,
        ...(drafted.fallbackReason === undefined ? {} : { fallbackReason: drafted.fallbackReason }),
        images,
        destinations,
        defaultDestinationAgentId: defaultDestination,
        ...(input.targetModel === undefined ? {} : { requestedModel: input.targetModel }),
      };
    });

    const revalidateHandoff = Effect.fn('Sessions.revalidateHandoff')(function* (input: {
      readonly sessionId: SessionId;
      readonly endpoint: HandoffSourceEndpoint;
      readonly targetAgentId: AgentId;
      readonly targetModel?: string;
      readonly summary: string;
      readonly selectedImageIds: ReadonlyArray<string>;
    }) {
      const session = yield* lookup(input.sessionId);
      const target = catalog.get(input.targetAgentId);
      if (target === undefined) {
        return yield* new SessionError({
          reason: 'NotFound',
          detail: `Unknown Agent ${input.targetAgentId}`,
        });
      }
      const transcript = session.prompted
        ? yield* store.replay(input.sessionId).pipe(Effect.orDie)
        : [];
      const currentEndpoint = computeSourceEndpoint(input.sessionId, transcript);
      const endpointAdvanced =
        currentEndpoint.seq !== input.endpoint.seq ||
        currentEndpoint.turnId !== input.endpoint.turnId ||
        currentEndpoint.messageCount !== input.endpoint.messageCount;
      const images = extractHandoffImages(transcript);
      const compatibility = yield* compatibilityForTarget(
        session,
        target,
        images,
        input.targetModel,
        input.selectedImageIds,
      );
      const budget = computeHandoffBudget(input.summary, compatibility.destinationCapacity);
      return {
        endpointAdvanced,
        currentEndpoint,
        compatibility,
        budget,
      };
    });

    const executeHandoff = Effect.fn('Sessions.executeHandoff')(function* (input: {
      readonly sessionId: SessionId;
      readonly kind: HandoffKind;
      readonly endpoint: HandoffSourceEndpoint;
      readonly targetAgentId: AgentId;
      readonly targetModel?: string;
      readonly summary: string;
      readonly selectedImageIds: ReadonlyArray<string>;
      readonly allowEndpointAdvance?: boolean;
    }) {
      const session = yield* lookup(input.sessionId);
      const target = catalog.get(input.targetAgentId);
      if (target === undefined) {
        return yield* new SessionError({
          reason: 'NotFound',
          detail: `Unknown Agent ${input.targetAgentId}`,
        });
      }
      yield* requireExitConfirmed({ agentId: target.id, sessionId: input.sessionId });

      const precheckBusy = yield* Effect.sync(() => {
        if (isSessionBusy(session)) return true;
        session.handoffRunning = { targetAgentId: target.id, acp: undefined, cancelled: false };
        return false;
      });
      if (precheckBusy) {
        return yield* new SessionError({
          reason: 'Busy',
          detail: 'Finish or cancel the active Turn or Compaction before starting a handoff.',
        });
      }

      let handoffBinding: { readonly revoke: () => void; acp: AcpSession | undefined } | undefined;
      return yield* Effect.gen(function* () {
        const transcript = session.prompted
          ? yield* store.replay(input.sessionId).pipe(Effect.orDie)
          : [];
        const currentEndpoint = computeSourceEndpoint(input.sessionId, transcript);
        const endpointAdvanced =
          currentEndpoint.seq !== input.endpoint.seq ||
          currentEndpoint.turnId !== input.endpoint.turnId ||
          currentEndpoint.messageCount !== input.endpoint.messageCount;
        if (endpointAdvanced && input.allowEndpointAdvance !== true) {
          return yield* new SessionError({
            reason: 'Busy',
            detail:
              'Another Message advanced the source Session. Review against the new endpoint before confirming.',
          });
        }

        const images = extractHandoffImages(transcript);
        const compatibility = yield* compatibilityForTarget(
          session,
          target,
          images,
          input.targetModel,
          input.selectedImageIds,
        );
        const budget = computeHandoffBudget(input.summary, compatibility.destinationCapacity);
        if (budget.overBudget) {
          return yield* new SessionError({
            reason: 'Unsupported',
            detail: `Summary exceeds the ${budget.capTokens.toLocaleString()} token budget.`,
          });
        }
        const selectedSet = new Set(input.selectedImageIds);
        const selectedImages = images.filter((img) => selectedSet.has(img.id));
        const blockedSelected = compatibility.blockedImages.find((b) => selectedSet.has(b.imageId));
        if (blockedSelected !== undefined) {
          return yield* new SessionError({
            reason: 'Unsupported',
            detail: blockedSelected.reason,
          });
        }

        yield* setState(session, {});
        const managerExit = yield* acpClient.connect(target).pipe(
          Effect.map((manager) => ({ _tag: 'ok' as const, manager })),
          Effect.catch((error) =>
            Effect.succeed({ _tag: 'err' as const, error: unavailable(error).error }),
          ),
        );
        if (managerExit._tag === 'err') {
          const now = yield* Clock.currentTimeMillis;
          const attempt: HandoffAttempt = {
            id: HandoffAttemptId.make(`attempt-${randomUUID()}`),
            kind: input.kind,
            status: 'interrupted',
            createdAt: Timestamp.make(now),
            sourceEndpoint: currentEndpoint,
            targetAgentId: target.id,
            targetAgentName: target.name,
            ...(input.targetModel === undefined ? {} : { targetModel: input.targetModel }),
            summary: input.summary,
            selectedImageIds: [...input.selectedImageIds],
            messages: [],
            steps: [],
            failureReason: managerExit.error.detail,
          };
          yield* store.saveHandoffAttempt(input.sessionId, attempt).pipe(Effect.orDie);
          return { _tag: 'failed', attempt } satisfies HandoffResult;
        }

        let contextId = session.meta.activeContextId;
        const registered = delegation.register(
          delegationTools(
            session,
            () =>
              handoffBinding !== undefined &&
              delegationBindings.get(input.sessionId) === handoffBinding &&
              !session.deleted &&
              session.agent.id === target.id &&
              handoffBinding.acp !== undefined &&
              session.acp === handoffBinding.acp &&
              session.meta.activeContextId === contextId &&
              (session.handoffRunning !== undefined || session.running !== undefined),
          ),
          () => delegationScope(session),
        );
        handoffBinding = { ...registered, acp: undefined };
        const ack = yield* runDestinationAcknowledgement({
          manager: managerExit.manager,
          mcpServers: [registered.server],
          target,
          cwd: session.meta.cwd,
          summary: input.summary,
          selectedImages,
          ...(input.targetModel === undefined
            ? compatibility.resolvedModel === undefined
              ? {}
              : { targetModel: compatibility.resolvedModel }
            : { targetModel: input.targetModel }),
          ...(compatibility.resolvedEffort === undefined
            ? {}
            : { targetEffort: compatibility.resolvedEffort }),
          permissionMode: compatibility.resolvedPermissionMode,
          onSessionOpened: (acp) => {
            if (session.handoffRunning !== undefined) session.handoffRunning.acp = acp;
          },
          isCancelled: () => session.handoffRunning?.cancelled === true,
          scope,
          locale: yield* currentLocale,
        });

        if (!ack.ok) {
          const now = yield* Clock.currentTimeMillis;
          const attempt: HandoffAttempt = {
            id: HandoffAttemptId.make(`attempt-${randomUUID()}`),
            kind: input.kind,
            status: ack.status,
            createdAt: Timestamp.make(now),
            sourceEndpoint: currentEndpoint,
            targetAgentId: target.id,
            targetAgentName: target.name,
            ...(input.targetModel === undefined ? {} : { targetModel: input.targetModel }),
            summary: input.summary,
            selectedImageIds: [...input.selectedImageIds],
            messages: [...ack.messages],
            steps: [...ack.steps],
            ...(ack.diskStateNote === undefined ? {} : { diskStateNote: ack.diskStateNote }),
            failureReason: ack.failureReason,
          };
          yield* store.saveHandoffAttempt(input.sessionId, attempt).pipe(Effect.orDie);
          return { _tag: 'failed', attempt } satisfies HandoffResult;
        }

        if (input.kind === 'fork') {
          const forkId = SessionId.make(randomUUID());
          const forkContextId = AgentContextId.make(randomUUID());
          const now = yield* Clock.currentTimeMillis;
          const sourceTitle =
            session.state.title.user ??
            session.state.title.auto ??
            session.meta.userTitle ??
            session.meta.autoTitle ??
            'Untitled session';
          const forkTitle = `Fork of ${sourceTitle}`;
          const options = foldOptions(
            ack.config,
            target.effort,
            compatibility.resolvedPermissionMode,
          );
          const fromModel = session.state.options.model?.value;
          const forkLineage = {
            sourceSessionId: input.sessionId,
            ...(currentEndpoint.turnId === undefined
              ? {}
              : { sourceTurnId: currentEndpoint.turnId }),
            sourceTurnNumber: currentEndpoint.turnNumber,
            sourceTitle,
          };
          const forkMeta: SessionMeta = {
            id: forkId,
            projectId: session.meta.projectId,
            cwd: session.meta.cwd,
            agentId: target.id,
            autoTitle: forkTitle,
            autoTitleIsPlaceholder: false,
            createdAt: Timestamp.make(now),
            lastActivityAt: Timestamp.make(now),
            activeContextId: forkContextId,
            contexts: [
              {
                id: forkContextId,
                agentId: target.id,
                acpSessionIds: [ack.acp.sessionId],
                createdAt: Timestamp.make(now),
              },
            ],
            ...(options.model?.value === undefined ? {} : { model: options.model.value }),
            ...(options.effort === undefined ? {} : { effort: options.effort.value }),
            permissionMode: options.permissionMode,
            forkLineage,
          };

          yield* store.createDraft(forkMeta);
          yield* store
            .append(forkId, [
              {
                _tag: 'HandoffBoundary',
                kind: 'fork',
                fromAgentId: session.agent.id,
                toAgentId: target.id,
                ...(fromModel === undefined ? {} : { fromModel }),
                ...(options.model?.value === undefined ? {} : { toModel: options.model.value }),
                summary: input.summary,
                imageCount: selectedImages.length,
                contextId: forkContextId,
              },
              {
                _tag: 'TurnStarted',
                turnId: ack.turnId,
                agentId: target.id,
                ...(options.model?.value === undefined ? {} : { model: options.model.value }),
                ...(options.effort?.value === undefined ? {} : { effort: options.effort.value }),
                permissionMode: options.permissionMode,
              },
              ack.userMessage,
              ack.agentMessage,
              { _tag: 'TurnEnded', turnId: ack.turnId, outcome: { _tag: 'done' } },
            ])
            .pipe(Effect.orDie);
          yield* store.flush(forkId).pipe(Effect.orDie);
          yield* remembered.rememberModels(target.id, options.model?.choices ?? []);
          yield* remembered.rememberLastAgent(target.id);
          yield* ack.acp.close.pipe(Effect.ignore);

          if (currentEndpoint.turnId !== undefined) {
            const targetLink = {
              forkSessionId: forkId,
              sourceTurnId: currentEndpoint.turnId,
              forkTitle,
            };
            yield* store
              .updateMeta(input.sessionId, (meta) => ({
                ...meta,
                forks: [...(meta.forks ?? []), targetLink],
              }))
              .pipe(Effect.orDie);
            yield* store.flush(input.sessionId).pipe(Effect.orDie);
            session.meta = yield* store.get(input.sessionId).pipe(Effect.orDie);
          }

          return {
            _tag: 'committed',
            contextId: forkContextId,
            forkSessionId: forkId,
          } satisfies HandoffResult;
        }

        // Clean acknowledgement: commit the switch and hand the live ACP session to AgentLifetime.
        const previousAcp = session.acp;
        if (previousAcp !== undefined) {
          yield* detach(session, previousAcp);
        }
        yield* lifetime
          .replace(input.sessionId, Effect.succeed({ manager: ack.manager, session: ack.acp }))
          .pipe(Effect.orDie);

        const fromAgentId = session.agent.id;
        const fromModel = session.state.options.model?.value;
        const newCtx = yield* store.startContext(input.sessionId, target.id).pipe(Effect.orDie);
        yield* store.addAcpSession(input.sessionId, ack.acp.sessionId).pipe(Effect.orDie);
        yield* store.setMemoryLost(input.sessionId, false).pipe(Effect.orDie);

        session.agent = target;
        session.acp = ack.acp;
        session.config = ack.config;
        session.acpCapabilities = ack.manager.agentCapabilities;
        session.prompted = true;
        const nextModel = input.targetModel ?? compatibility.resolvedModel;
        session.wanted = {
          model: nextModel === undefined ? {} : { pinned: nextModel },
          effort:
            compatibility.resolvedEffort === undefined
              ? {}
              : { pinned: compatibility.resolvedEffort },
        };
        const locale = yield* currentLocale;
        const { options, modelsLimitation } = foldedOptions(session, locale);
        yield* store
          .updateMeta(input.sessionId, (meta) => ({
            ...withSavedContextUsage(withOptions(meta, options), undefined),
            agentId: target.id,
          }))
          .pipe(Effect.orDie);
        yield* remembered.rememberModels(target.id, options.model?.choices ?? []);
        yield* remembered.rememberLastAgent(target.id);
        session.meta = yield* store.get(input.sessionId).pipe(Effect.orDie);
        contextId = session.meta.activeContextId;
        handoffBinding.acp = ack.acp;
        delegationBindings.get(input.sessionId)?.revoke();
        delegationBindings.set(input.sessionId, handoffBinding);

        yield* append(session, [
          {
            _tag: 'HandoffBoundary',
            kind: input.kind,
            fromAgentId,
            toAgentId: target.id,
            ...(fromModel === undefined ? {} : { fromModel }),
            ...(options.model?.value === undefined ? {} : { toModel: options.model.value }),
            summary: input.summary,
            imageCount: selectedImages.length,
            contextId: newCtx.id,
          },
          {
            _tag: 'TurnStarted',
            turnId: ack.turnId,
            agentId: target.id,
            ...(options.model?.value === undefined ? {} : { requestedModel: options.model.value }),
            ...(options.model?.value === undefined ? {} : { model: options.model.value }),
            ...(options.effort?.value === undefined ? {} : { effort: options.effort.value }),
            permissionMode: options.permissionMode,
          },
          ack.userMessage,
          ack.agentMessage,
          { _tag: 'TurnEnded', turnId: ack.turnId, outcome: { _tag: 'done' } },
        ]);
        yield* store.flush(input.sessionId).pipe(Effect.orDie);

        yield* Effect.forkIn(read(session, ack.acp), scope);
        yield* setState(session, {
          agentId: target.id,
          agentName: target.name,
          agentStatus: 'ready',
          isDraft: false,
          options,
          modelsLimitation,
          capabilities: {
            ...target.capabilities,
            models:
              target.capabilities.models &&
              options.model !== undefined &&
              options.model.choices.length > 0,
            effort:
              target.capabilities.effort &&
              options.effort !== undefined &&
              options.effort.choices.length > 0,
            images:
              target.capabilities.images &&
              ack.manager.agentCapabilities.promptCapabilities?.image === true,
            askMode: target.capabilities.askMode,
            resume:
              target.capabilities.resume &&
              (ack.manager.agentCapabilities.loadSession === true ||
                Boolean(ack.manager.agentCapabilities.sessionCapabilities?.resume)),
            supportsCompaction:
              target.capabilities.supportsCompaction &&
              supportsAcpCompaction(ack.manager.agentCapabilities),
          },
          canAttachImages:
            target.capabilities.images &&
            ack.manager.agentCapabilities.promptCapabilities?.image === true,
          imageLimits: target.imageLimits,
          contextUsage: { _tag: 'unavailable' },
          memoryLost: false,
        });

        return { _tag: 'committed', contextId: newCtx.id } satisfies HandoffResult;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (
              handoffBinding !== undefined &&
              delegationBindings.get(input.sessionId) !== handoffBinding
            ) {
              handoffBinding.revoke();
            }
            session.handoffRunning = undefined;
          }).pipe(Effect.andThen(setState(session, {}))),
        ),
      );
    });

    const listHandoffAttempts = Effect.fn('Sessions.listHandoffAttempts')(function* (
      id: SessionId,
    ) {
      yield* lookup(id);
      return yield* store.listHandoffAttempts(id).pipe(Effect.orDie);
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
          isNativeWorker(session.meta)
            ? Effect.void
            : requireExitConfirmed({ agentId: session.meta.agentId }).pipe(
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
          const closing = open.get(id);
          if (closing !== undefined) closing.queue = [];
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
      // Removing a Project is destructive: its ephemeral Queues go with it, before its Turns are cancelled.
      for (const session of open.values()) {
        if (session.meta.projectId === projectId) session.queue = [];
      }
      // A removed Project loses every cross-Project allowance, as sender and as target.
      const stored = (yield* settings.get).crossProjectAccess;
      if (stored.some((entry) => entry.from === projectId || entry.to === projectId)) {
        yield* settings
          .update({
            crossProjectAccess: stored.filter(
              (entry) => entry.from !== projectId && entry.to !== projectId,
            ),
          })
          .pipe(Effect.ignore);
      }
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
      const existing = open.get(id);
      if (existing !== undefined) existing.queue = [];
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

    const removeOne = Effect.fn('Sessions.removeOne')(function* (id: SessionId) {
      const meta = yield* store.get(id);
      deleting.add(id);
      delegationBindings.get(id)?.revoke();
      delegationBindings.delete(id);
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
        delegation.forget(`${id}:`);
        yield* store.remove(id);
        // A deleted Worker leaves its Parent's live Worker list immediately.
        if (meta.parentSessionId !== undefined) {
          const openParent = open.get(meta.parentSessionId);
          if (openParent !== undefined && !openParent.deleted) {
            yield* setState(openParent, {
              workers: (openParent.state.workers ?? []).filter((item) => item.sessionId !== id),
            });
          }
        }
        // When a Fork is deleted, remove its reciprocal ForkTarget from its surviving source Session.
        if (meta.forkLineage !== undefined) {
          const sourceId = meta.forkLineage.sourceSessionId;
          yield* store
            .updateMeta(sourceId, (sourceMeta) => ({
              ...sourceMeta,
              forks: (sourceMeta.forks ?? []).filter((f) => f.forkSessionId !== id),
            }))
            .pipe(Effect.andThen(store.flush(sourceId)), Effect.ignore);
          const openSource = open.get(sourceId);
          if (openSource !== undefined) {
            openSource.meta = {
              ...openSource.meta,
              forks: (openSource.meta.forks ?? []).filter((f) => f.forkSessionId !== id),
            };
            yield* setState(openSource, {});
          }
        }
        // When a source Session is deleted, keep surviving Forks intact and mark their sourceDeleted flag.
        for (const forkTarget of meta.forks ?? []) {
          const forkId = forkTarget.forkSessionId;
          yield* store
            .updateMeta(forkId, (forkMeta) =>
              forkMeta.forkLineage === undefined
                ? forkMeta
                : {
                    ...forkMeta,
                    forkLineage: { ...forkMeta.forkLineage, sourceDeleted: true },
                  },
            )
            .pipe(Effect.andThen(store.flush(forkId)), Effect.ignore);
          const openFork = open.get(forkId);
          if (openFork !== undefined && openFork.meta.forkLineage !== undefined) {
            openFork.meta = {
              ...openFork.meta,
              forkLineage: { ...openFork.meta.forkLineage, sourceDeleted: true },
            };
            yield* setState(openFork, {});
          }
        }
        for (const context of meta.contexts) {
          if (context.acpSessionIds.length > 0) {
            yield* deleteQueue.deleteOrQueue(context.agentId, context.acpSessionIds);
          }
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            deleting.delete(id);
          }),
        ),
      );
    });

    /** Worker descendants of a Session, deepest first. */
    const workerDescendants = Effect.fnUntraced(function* (id: SessionId) {
      yield* store.get(id);
      const metas = yield* store.listAll;
      const ordered: Array<SessionId> = [];
      const visit = (parentId: SessionId): void => {
        for (const meta of metas) {
          if (meta.parentSessionId === parentId && !ordered.includes(meta.id)) {
            visit(meta.id);
            ordered.push(meta.id);
          }
        }
      };
      visit(id);
      return ordered;
    });

    const countWorkers = Effect.fn('Sessions.countWorkers')(function* (id: SessionId) {
      return (yield* workerDescendants(id)).length;
    });

    /** Deletes the Session and, deepest first, every Worker descendant; independent Forks are never touched. */
    const remove = Effect.fn('Sessions.remove')(function* (id: SessionId) {
      for (const descendant of yield* workerDescendants(id)) yield* removeOne(descendant);
      yield* removeOne(id);
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
      folderOf,
      setDraftFolder,
      prompt,
      steer,
      enqueue,
      setQueue,
      clearQueue,
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
      startEmptyContext,
      archive,
      unarchive,
      remove,
      countWorkers,
      protectedFromAutoArchive,
      events,
      setTabs,
      restoreTabs,
      getComposer,
      setComposer,
      prepareHandoff,
      revalidateHandoff,
      executeHandoff,
      listHandoffAttempts,
    });
  }),
);
