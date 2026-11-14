import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import {
  AgentCapabilities,
  AgentId,
  Effort,
  ImageLimits,
  InstallKind,
  Model,
  VersionQualification,
} from '../agents/agents.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../projects/projects.rpc';

// Ids. Every id in the contract is Spence's own; ACP ids stay in main.

export const SessionId = Schema.String.pipe(Schema.brand('SessionId')).annotate({
  identifier: 'SessionId',
});
export type SessionId = typeof SessionId.Type;

export const TurnId = Schema.String.pipe(Schema.brand('TurnId')).annotate({ identifier: 'TurnId' });
export type TurnId = typeof TurnId.Type;

export const MessageId = Schema.String.pipe(Schema.brand('MessageId')).annotate({
  identifier: 'MessageId',
});
export type MessageId = typeof MessageId.Type;

export const ThoughtId = Schema.String.pipe(Schema.brand('ThoughtId')).annotate({
  identifier: 'ThoughtId',
});
export type ThoughtId = typeof ThoughtId.Type;

export const StepId = Schema.String.pipe(Schema.brand('StepId')).annotate({ identifier: 'StepId' });
export type StepId = typeof StepId.Type;

export const PermissionRequestId = Schema.String.pipe(Schema.brand('PermissionRequestId')).annotate(
  { identifier: 'PermissionRequestId' },
);
export type PermissionRequestId = typeof PermissionRequestId.Type;

export const CompactionId = Schema.String.pipe(Schema.brand('CompactionId')).annotate({
  identifier: 'CompactionId',
});
export type CompactionId = typeof CompactionId.Type;

// Message parts.

export const TextPart = Schema.TaggedStruct('text', { text: Schema.String }).annotate({
  identifier: 'TextPart',
});
export type TextPart = typeof TextPart.Type;

export const LinkPart = Schema.TaggedStruct('link', {
  uri: Schema.String,
  name: Schema.String,
  title: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: 'LinkPart' });
export type LinkPart = typeof LinkPart.Type;

/** An Image; `data` is base64. */
export const ImagePart = Schema.TaggedStruct('image', {
  mimeType: Schema.String,
  data: Schema.String,
}).annotate({ identifier: 'ImagePart' });
export type ImagePart = typeof ImagePart.Type;

/** Audio; `data` is base64. */
export const AudioPart = Schema.TaggedStruct('audio', {
  mimeType: Schema.String,
  data: Schema.String,
}).annotate({ identifier: 'AudioPart' });
export type AudioPart = typeof AudioPart.Type;

export const TextContents = Schema.TaggedStruct('text', { text: Schema.String }).annotate({
  identifier: 'TextContents',
});
/** Binary resource contents; `blob` is base64. */
export const BlobContents = Schema.TaggedStruct('blob', { blob: Schema.String }).annotate({
  identifier: 'BlobContents',
});

/** An embedded resource: its text or its bytes. */
export const ResourcePart = Schema.TaggedStruct('resource', {
  uri: Schema.String,
  mimeType: Schema.optionalKey(Schema.String),
  contents: Schema.Union([TextContents, BlobContents]),
}).annotate({ identifier: 'ResourcePart' });
export type ResourcePart = typeof ResourcePart.Type;

export const MessagePart = Schema.Union([
  TextPart,
  LinkPart,
  ImagePart,
  AudioPart,
  ResourcePart,
]).annotate({ identifier: 'MessagePart' });
export type MessagePart = typeof MessagePart.Type;

// Transcript items (spec 4.3). Items are whole and keyed by id; only Message and Thought text stream as deltas.

export const TurnStarted = Schema.TaggedStruct('TurnStarted', {
  turnId: TurnId,
  /** The options the Turn runs with. */
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permissionMode: PermissionMode,
}).annotate({ identifier: 'TurnStarted' });
export type TurnStarted = typeof TurnStarted.Type;

export const FailureReason = Schema.Literals([
  'agentError',
  'agentStopped',
  'needsLogin',
  'interrupted',
]).annotate({ identifier: 'FailureReason' });
export type FailureReason = typeof FailureReason.Type;

export const TurnOutcome = Schema.Union([
  Schema.TaggedStruct('done', {}),
  Schema.TaggedStruct('cancelled', {}),
  Schema.TaggedStruct('refused', {}),
  /** The Agent hit a limit, e.g. `maxTokens` or `maxTurnRequests`. */
  Schema.TaggedStruct('cutShort', { limit: Schema.String }),
  Schema.TaggedStruct('failed', { reason: FailureReason, detail: Schema.String }),
]).annotate({ identifier: 'TurnOutcome' });
export type TurnOutcome = typeof TurnOutcome.Type;

export const TurnEnded = Schema.TaggedStruct('TurnEnded', {
  turnId: TurnId,
  outcome: TurnOutcome,
}).annotate({ identifier: 'TurnEnded' });
export type TurnEnded = typeof TurnEnded.Type;

export const Role = Schema.Literals(['user', 'agent']).annotate({ identifier: 'Role' });
export type Role = typeof Role.Type;

export const Message = Schema.TaggedStruct('Message', {
  id: MessageId,
  turnId: TurnId,
  role: Role,
  parts: Schema.Array(MessagePart),
}).annotate({ identifier: 'Message' });
export type Message = typeof Message.Type;

/** Text appended to the last text part of a Message. */
export const MessageDelta = Schema.TaggedStruct('MessageDelta', {
  id: MessageId,
  text: Schema.String,
}).annotate({ identifier: 'MessageDelta' });
export type MessageDelta = typeof MessageDelta.Type;

export const Thought = Schema.TaggedStruct('Thought', {
  id: ThoughtId,
  turnId: TurnId,
  text: Schema.String,
}).annotate({ identifier: 'Thought' });
export type Thought = typeof Thought.Type;

/** Text appended to a Thought. */
export const ThoughtDelta = Schema.TaggedStruct('ThoughtDelta', {
  id: ThoughtId,
  text: Schema.String,
}).annotate({ identifier: 'ThoughtDelta' });
export type ThoughtDelta = typeof ThoughtDelta.Type;

export const StepKind = Schema.Literals([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'fetch',
  'other',
]).annotate({ identifier: 'StepKind' });
export type StepKind = typeof StepKind.Type;

export const StepStatus = Schema.Literals([
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
]).annotate({ identifier: 'StepStatus' });
export type StepStatus = typeof StepStatus.Type;

export const Diff = Schema.Struct({
  /** Relative to the Project. */
  path: Schema.String,
  /** Absent for a new file. */
  before: Schema.optionalKey(Schema.String),
  after: Schema.String,
}).annotate({ identifier: 'Diff' });
export type Diff = typeof Diff.Type;

/** A Step, whole: a later item with the same id replaces it. */
export const Step = Schema.TaggedStruct('Step', {
  id: StepId,
  turnId: TurnId,
  title: Schema.String,
  kind: StepKind,
  status: StepStatus,
  /** Relative to the Project. */
  files: Schema.Array(Schema.String),
  diffs: Schema.Array(Diff),
  output: Schema.String,
}).annotate({ identifier: 'Step' });
export type Step = typeof Step.Type;

export const PlanEntry = Schema.Struct({
  content: Schema.String,
  priority: Schema.Literals(['high', 'medium', 'low']),
  status: Schema.Literals(['pending', 'inProgress', 'completed']),
}).annotate({ identifier: 'PlanEntry' });
export type PlanEntry = typeof PlanEntry.Type;

/** The Plan, always replaced whole. */
export const Plan = Schema.TaggedStruct('Plan', {
  entries: Schema.Array(PlanEntry),
}).annotate({ identifier: 'Plan' });
export type Plan = typeof Plan.Type;

export const PermissionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: Schema.Literals(['allowOnce', 'allowAlways', 'rejectOnce', 'rejectAlways']),
}).annotate({ identifier: 'PermissionOption' });
export type PermissionOption = typeof PermissionOption.Type;

export const PermissionState = Schema.Union([
  Schema.TaggedStruct('pending', {}),
  Schema.TaggedStruct('answered', {
    optionId: Schema.String,
    /** `policy` when main answered by the Permission mode. */
    by: Schema.Literals(['user', 'policy']),
  }),
  Schema.TaggedStruct('cancelled', {}),
]).annotate({ identifier: 'PermissionState' });
export type PermissionState = typeof PermissionState.Type;

/** A Permission request, whole: a later item with the same id replaces it. */
export const PermissionRequest = Schema.TaggedStruct('PermissionRequest', {
  id: PermissionRequestId,
  turnId: TurnId,
  stepId: StepId,
  options: Schema.Array(PermissionOption),
  state: PermissionState,
}).annotate({ identifier: 'PermissionRequest' });
export type PermissionRequest = typeof PermissionRequest.Type;

/** A Compaction, whole: a later item with the same id replaces it. */
export const Compaction = Schema.TaggedStruct('Compaction', {
  id: CompactionId,
  status: Schema.Literals(['running', 'done', 'failed', 'cancelled']),
  summary: Schema.String,
}).annotate({ identifier: 'Compaction' });
export type Compaction = typeof Compaction.Type;

export const Notice = Schema.TaggedStruct('Notice', {
  severity: Schema.Literals(['info', 'warning', 'error']),
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Notice' });
export type Notice = typeof Notice.Type;

/** Where the Agent's memory starts over: the user cleared it, or it was lost. */
export const ContextCleared = Schema.TaggedStruct('ContextCleared', {
  reason: Schema.Literals(['cleared', 'lost']),
}).annotate({ identifier: 'ContextCleared' });
export type ContextCleared = typeof ContextCleared.Type;

/** Detail recorded on `TurnEnded` when the user stops a stalled Agent via `Session.stopAgent`. */
export const STOP_AGENT_INTERRUPTED_DETAIL = 'Agent was stopped by user';

export const TranscriptItem = Schema.Union([
  TurnStarted,
  TurnEnded,
  Message,
  MessageDelta,
  Thought,
  ThoughtDelta,
  Step,
  Plan,
  PermissionRequest,
  Compaction,
  Notice,
  ContextCleared,
]).annotate({ identifier: 'TranscriptItem' });
export type TranscriptItem = typeof TranscriptItem.Type;

/** A Transcript item as stored and streamed: numbered by `seq` (from 1, gapless per Session). */
export const TranscriptEvent = Schema.Struct({
  seq: Schema.Number,
  at: Timestamp,
  item: TranscriptItem,
}).annotate({ identifier: 'TranscriptEvent' });
export type TranscriptEvent = typeof TranscriptEvent.Type;

// Live state (spec 4.2): a snapshot plus changes, never persisted.

export const AgentStatus = Schema.Literals([
  'ready',
  'starting',
  'notInstalled',
  'needsLogin',
  'cantStart',
  'stopped',
]).annotate({ identifier: 'AgentStatus' });
export type AgentStatus = typeof AgentStatus.Type;

export const Attention = Schema.Literals(['needsAnswer', 'error']).annotate({
  identifier: 'Attention',
});
export type Attention = typeof Attention.Type;

/** `user ?? auto`, else untitled. */
export const SessionTitle = Schema.Struct({
  user: Schema.optionalKey(Schema.String),
  auto: Schema.optionalKey(Schema.String),
  autoImageCount: Schema.optionalKey(Schema.Number),
  /** The automatic title is the first Message's start, not one the Agent gave. */
  autoIsPlaceholder: Schema.Boolean,
}).annotate({ identifier: 'SessionTitle' });
export type SessionTitle = typeof SessionTitle.Type;

export const SessionOptions = Schema.Struct({
  /** Absent when the Agent offers no Model. */
  model: Schema.optionalKey(Schema.Struct({ value: Schema.String, choices: Schema.Array(Model) })),
  /** Absent when the Agent has no effort option; `choices` are the levels it offers. */
  effort: Schema.optionalKey(Schema.Struct({ value: Effort, choices: Schema.Array(Effort) })),
  permissionMode: PermissionMode,
}).annotate({ identifier: 'SessionOptions' });
export type SessionOptions = typeof SessionOptions.Type;

/** An option `Session.setOption` changes. */
export const OptionName = Schema.Literals(['model', 'effort']).annotate({
  identifier: 'OptionName',
});
export type OptionName = typeof OptionName.Type;

export const Command = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  hint: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Command' });
export type Command = typeof Command.Type;

/** Why an Agent could not start when `agentStatus === 'cantStart'`. */
export const CantStartReason = Schema.Literals([
  'protocolVersion',
  'spawn',
  'unsupported',
]).annotate({
  identifier: 'CantStartReason',
});
export type CantStartReason = typeof CantStartReason.Type;

/** An authentication method advertised by the Agent on `initialize`. */
export const AuthMethodInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** Shell command the user can run manually (shown under "Other ways"). */
  command: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'AuthMethodInfo' });
export type AuthMethodInfo = typeof AuthMethodInfo.Type;

export const CancelGrace = Schema.Struct({
  /** `waiting` during the 5s cancel grace; `ready` once 5s elapsed and Stop Agent is surfaced. */
  phase: Schema.Literals(['waiting', 'ready']),
  /** Number of other active Sessions sharing this Agent process. */
  otherWorkingCount: Schema.Number,
}).annotate({ identifier: 'CancelGrace' });
export type CancelGrace = typeof CancelGrace.Type;

export const ProcessExitState = Schema.Literals([
  'stopping',
  'killTimedOut',
  'cancelPending',
]).annotate({ identifier: 'ProcessExitState' });
export type ProcessExitState = typeof ProcessExitState.Type;

export const UnconfirmedExit = Schema.Struct({
  pid: Schema.optionalKey(Schema.Number),
  state: ProcessExitState,
}).annotate({ identifier: 'UnconfirmedExit' });
export type UnconfirmedExit = typeof UnconfirmedExit.Type;

export const StopAgentResult = Schema.Union([
  Schema.TaggedStruct('stopped', {
    pid: Schema.optionalKey(Schema.Number),
  }),
  Schema.TaggedStruct('confirmRequired', {
    otherWorkingCount: Schema.Number,
    agentName: Schema.String,
  }),
]).annotate({ identifier: 'StopAgentResult' });
export type StopAgentResult = typeof StopAgentResult.Type;

/** Snapshot of a valid Context usage reading (`used` tokens, and `capacity` when positive & finite). */
export const ContextUsageReading = Schema.Struct({
  used: Schema.Number,
  capacity: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: 'ContextUsageReading' });
export type ContextUsageReading = typeof ContextUsageReading.Type;

/**
 * Reported-only Context usage for the Session's current Agent context and Model (spec 2.3).
 * Never populated from cumulative `Usage` or local estimation.
 */
export const ContextUsage = Schema.Union([
  Schema.TaggedStruct('unavailable', {}),
  Schema.TaggedStruct('reported', {
    used: Schema.Number,
    capacity: Schema.Number,
  }),
  Schema.TaggedStruct('countOnly', {
    used: Schema.Number,
  }),
  Schema.TaggedStruct('historical', {
    used: Schema.Number,
    capacity: Schema.optionalKey(Schema.Number),
  }),
  Schema.TaggedStruct('waiting', {
    prior: Schema.optionalKey(ContextUsageReading),
  }),
]).annotate({ identifier: 'ContextUsage' });
export type ContextUsage = typeof ContextUsage.Type;

export const LiveState = Schema.Struct({
  agentStatus: AgentStatus,
  attention: Schema.optionalKey(Attention),
  /** The Turn running when a subscription begins, if any. */
  runningTurn: Schema.optionalKey(TurnId),
  title: SessionTitle,
  options: SessionOptions,
  /** Replaced whole. */
  commands: Schema.Array(Command),
  canAttachImages: Schema.Boolean,
  imageLimits: ImageLimits,
  capabilities: Schema.optionalKey(AgentCapabilities),
  /** True while the Session has not started its first Turn (allows changing Agent directly). */
  isDraft: Schema.optionalKey(Schema.Boolean),
  /** The Agent's name, as the Catalog names it, for messages like "Claude can't take images". */
  agentName: Schema.optionalKey(Schema.String),
  agentId: Schema.optionalKey(AgentId),
  agentPackage: Schema.optionalKey(Schema.String),
  installKind: Schema.optionalKey(InstallKind),
  installInstructions: Schema.optionalKey(Schema.String),
  installedVersion: Schema.optionalKey(Schema.String),
  versionQualification: Schema.optionalKey(VersionQualification),
  upgradeCommand: Schema.optionalKey(Schema.String),
  modelsLimitation: Schema.optionalKey(Schema.String),
  cantStartReason: Schema.optionalKey(CantStartReason),
  cantStartDetail: Schema.optionalKey(Schema.String),
  authMethods: Schema.optionalKey(Schema.Array(AuthMethodInfo)),
  cancelGrace: Schema.optionalKey(CancelGrace),
  unconfirmedExit: Schema.optionalKey(UnconfirmedExit),
  /** Reported-only Context usage for the current Agent context and Model. */
  contextUsage: Schema.optionalKey(ContextUsage),
}).annotate({ identifier: 'LiveState' });
export type LiveState = typeof LiveState.Type;

export const SessionChange = Schema.Struct({
  sessionId: SessionId,
  projectId: ProjectId,
  state: LiveState,
}).annotate({ identifier: 'SessionChange' });
export type SessionChange = typeof SessionChange.Type;

/** What `Session.events` streams: the live state, replaced whole, or the next Transcript event. */
export const SessionStreamItem = Schema.Union([
  Schema.TaggedStruct('Live', { state: LiveState }),
  Schema.TaggedStruct('Transcript', { event: TranscriptEvent }),
]).annotate({ identifier: 'SessionStreamItem' });
export type SessionStreamItem = typeof SessionStreamItem.Type;

// Summaries and errors.

export const SessionSummary = Schema.Struct({
  id: SessionId,
  agentId: AgentId,
  title: SessionTitle,
  lastActivityAt: Timestamp,
  archivedAt: Schema.optionalKey(Timestamp),
  attention: Schema.optionalKey(Attention),
  running: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'SessionSummary' });
export type SessionSummary = typeof SessionSummary.Type;

/**
 * The one error of the sessions domain. A crash is a stream event, never this error. The Agent is unavailable as one
 * of `AgentNotInstalled`, `AgentNeedsLogin` or `AgentCantStart` (spec 4.1's `AgentUnavailable`), so a reason always
 * says why.
 */
export class SessionError extends Schema.TaggedError<SessionError>()('SessionError', {
  reason: Schema.Literals([
    'NotFound',
    'Busy',
    'AgentNotInstalled',
    'AgentNeedsLogin',
    'AgentCantStart',
    'ExitUnconfirmed',
  ]),
  detail: Schema.String,
}) {}

/** `Session.setOption`: one option of a Session and its new value, in Spence's vocabulary. */
export const SessionOptionChange = Schema.Union([
  Schema.Struct({ sessionId: SessionId, option: OptionName, value: Schema.String }),
  Schema.Struct({
    sessionId: SessionId,
    option: Schema.Literal('permissionMode'),
    value: PermissionMode,
  }),
]).annotate({ identifier: 'SessionOptionChange' });
export type SessionOptionChange = typeof SessionOptionChange.Type;

/** An image attached to an unsent Composer draft, kept in main across window reloads. */
export const ComposerImage = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  data: Schema.String,
}).annotate({ identifier: 'ComposerImage' });
export type ComposerImage = typeof ComposerImage.Type;

/** Unsent Composer text and attached images for one open Session. */
export const ComposerDraft = Schema.Struct({
  text: Schema.String,
  images: Schema.Array(ComposerImage),
}).annotate({ identifier: 'ComposerDraft' });
export type ComposerDraft = typeof ComposerDraft.Type;

export const SessionsRpcs = RpcGroup.make(
  Rpc.make('Session.changes', { success: SessionChange, stream: true }),
  Rpc.make('Session.list', {
    payload: { projectId: ProjectId },
    success: Schema.Array(SessionSummary),
  }),
  /** Starts a draft Session in the Project: the Agent and its ACP session start at once; nothing is kept yet. */
  Rpc.make('Session.create', {
    payload: { projectId: ProjectId, agentId: Schema.optionalKey(AgentId) },
    success: SessionId,
    error: SessionError,
  }),
  /** Changes the Agent of an unsent draft Session before its first Turn. */
  Rpc.make('Session.setAgent', {
    payload: { sessionId: SessionId, agentId: AgentId },
    error: SessionError,
  }),
  /** Starts a Turn with the user's Message; `Busy` while one runs. */
  Rpc.make('Session.prompt', {
    payload: { sessionId: SessionId, parts: Schema.Array(MessagePart) },
    success: TurnId,
    error: SessionError,
  }),
  /** Asks the Agent to stop the running Turn; nothing when none runs. */
  Rpc.make('Session.cancel', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /**
   * Force-stops the Agent process tree when cancelling stalls. Returns `confirmRequired` when other active
   * Sessions share that Agent and `force` is not true; fails `ExitUnconfirmed` if exit is not observed in time.
   */
  Rpc.make('Session.stopAgent', {
    payload: { sessionId: SessionId, force: Schema.optionalKey(Schema.Boolean) },
    success: StopAgentResult,
    error: SessionError,
  }),
  Rpc.make('Session.rename', {
    payload: { sessionId: SessionId, title: Schema.String },
    error: SessionError,
  }),
  Rpc.make('Session.retryAgent', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /** Runs the Agent's primary login method; interrupting cancels the login process. */
  Rpc.make('Session.loginAgent', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  Rpc.make('Session.openAgentLog', {
    payload: { sessionId: Schema.optionalKey(SessionId) },
  }),
  /** Answers a pending Permission request with one of its options; nothing when it is no longer pending. */
  Rpc.make('Session.answerPermission', {
    payload: { sessionId: SessionId, requestId: PermissionRequestId, optionId: Schema.String },
    error: SessionError,
  }),
  /** Changes one of the Session's options; the new state arrives on `Session.events`. */
  Rpc.make('Session.setOption', {
    payload: SessionOptionChange,
    error: SessionError,
  }),
  /**
   * Starts the Agent's memory over: a fresh ACP session, with the same options, and `ContextCleared` in the
   * Transcript. `Busy` while a Turn runs.
   */
  Rpc.make('Session.clearContext', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /** Archives a Session (`archivedAt`), cancelling any running Turn and closing its Tab. */
  Rpc.make('Session.archive', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /** Unarchives a Session (clears `archivedAt`). */
  Rpc.make('Session.unarchive', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /** Permanently deletes a Session from Spence and queues/sends ACP `session/delete`. */
  Rpc.make('Session.delete', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /**
   * The live state, then the Transcript events after `afterSeq` (all when absent), then live items as they happen.
   * Transcript events never repeat a `seq`.
   */
  Rpc.make('Session.events', {
    payload: { sessionId: SessionId, afterSeq: Schema.optionalKey(Schema.Number) },
    success: SessionStreamItem,
    error: SessionError,
    stream: true,
  }),
  /** Returns unsent Composer text and images remembered in main for an open Session. */
  Rpc.make('Session.getComposer', {
    payload: { sessionId: SessionId },
    success: ComposerDraft,
  }),
  /** Stores unsent Composer text and images in main across window reloads (until the Tab closes). */
  Rpc.make('Session.setComposer', {
    payload: { sessionId: SessionId, draft: ComposerDraft },
  }),
);
