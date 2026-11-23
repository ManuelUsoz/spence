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
import { AssetRef } from '../assets/assets.rpc';
import { DeviceId } from '../devices/devices.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../projects/projects.rpc';

import { WorkflowKind } from '../settings/settings.rpc';

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

export const HandoffAttemptId = Schema.String.pipe(Schema.brand('HandoffAttemptId')).annotate({
  identifier: 'HandoffAttemptId',
});
export type HandoffAttemptId = typeof HandoffAttemptId.Type;

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

/**
 * An Image; `data` is base64. From a Remote device `data` is empty and `asset` says how to fetch the bytes
 * (`Assets.read`); the host's own Transcript always keeps them inline.
 */
export const ImagePart = Schema.TaggedStruct('image', {
  mimeType: Schema.String,
  data: Schema.String,
  asset: Schema.optionalKey(AssetRef),
}).annotate({ identifier: 'ImagePart' });
export type ImagePart = typeof ImagePart.Type;

/** Audio; `data` is base64, or empty with `asset` set from a Remote device (as for an Image). */
export const AudioPart = Schema.TaggedStruct('audio', {
  mimeType: Schema.String,
  data: Schema.String,
  asset: Schema.optionalKey(AssetRef),
}).annotate({ identifier: 'AudioPart' });
export type AudioPart = typeof AudioPart.Type;

export const TextContents = Schema.TaggedStruct('text', { text: Schema.String }).annotate({
  identifier: 'TextContents',
});
/** Binary resource contents; `blob` is base64, or empty with `asset` set from a Remote device. */
export const BlobContents = Schema.TaggedStruct('blob', {
  blob: Schema.String,
  asset: Schema.optionalKey(AssetRef),
}).annotate({
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
  workflow: Schema.optionalKey(WorkflowKind),
  verificationOf: Schema.optionalKey(TurnId),
  workflowStage: Schema.optionalKey(Schema.Literal(true)),
  /** The Agent that ran this Turn (absent on legacy v1 Transcripts). */
  agentId: Schema.optionalKey(AgentId),
  /** The options the Turn runs with (requested Model, Effort, Permission mode). */
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Effort),
  permissionMode: PermissionMode,
}).annotate({ identifier: 'TurnStarted' });
export type TurnStarted = typeof TurnStarted.Type;

export const WORKFLOW_INTERRUPTED_DETAIL = 'Spence closed while the workflow was running';

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
  /** Agent-reported actual Model for this Turn, when available. */
  actualModel: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'TurnEnded' });
export type TurnEnded = typeof TurnEnded.Type;

export const Role = Schema.Literals(['user', 'agent']).annotate({ identifier: 'Role' });
export type Role = typeof Role.Type;

/** One Session a Cross-device message passed through on its way, by the Device it lives on. */
export const ChainLink = Schema.Struct({
  deviceId: DeviceId,
  sessionId: SessionId,
}).annotate({ identifier: 'ChainLink' });
export type ChainLink = typeof ChainLink.Type;

/** The Session that sent a Message: it is shown as coming from that Session, not as the user's own. */
export const MessageSender = Schema.Struct({
  sessionId: SessionId,
  projectId: Schema.optionalKey(ProjectId),
  exchangeId: Schema.optionalKey(Schema.String),
  /** The sender's title when it sent the Message. */
  title: Schema.String,
  /** The sender asks the user to answer; it surfaces as Attention on the receiving Session. */
  needsUser: Schema.optionalKey(Schema.Boolean),
  /** How many Session-to-Session hops led to this Message; bounds ping-pong. */
  hops: Schema.optionalKey(Schema.Number),
  /** The sender's Project, set only when it sent across Projects or Devices. */
  projectName: Schema.optionalKey(Schema.String),
  /**
   * The Device the Message came from, set only on a Cross-device message (Provenance). The id is the connection's,
   * the name what that Device calls itself.
   */
  device: Schema.optionalKey(Schema.Struct({ id: DeviceId, name: Schema.String })),
  /** Whether a person or an Agent sent a Cross-device message; absent within one Device's delegation tree. */
  by: Schema.optionalKey(Schema.Literals(['person', 'agent'])),
  /**
   * The Sessions a Cross-device message came through, the sender last. Kept so the receiving Session's own sends
   * extend it, and a loop back to any of them is refused.
   */
  chain: Schema.optionalKey(Schema.Array(ChainLink)),
  /** The Permission mode the sending Agent asked under, set only on an Agent's Cross-device message. */
  permissionMode: Schema.optionalKey(PermissionMode),
}).annotate({ identifier: 'MessageSender' });
export type MessageSender = typeof MessageSender.Type;

export const Message = Schema.TaggedStruct('Message', {
  id: MessageId,
  turnId: TurnId,
  role: Role,
  parts: Schema.Array(MessagePart),
  /** A Message injected into a running Turn with Steer, rather than the Turn's initial prompt. */
  steer: Schema.optionalKey(Schema.Boolean),
  /** Set when another Session in the delegation tree sent it. */
  from: Schema.optionalKey(MessageSender),
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
  workflowSource: Schema.optionalKey(
    Schema.Struct({ role: Schema.String, agentName: Schema.String, title: Schema.String }),
  ),
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
  sent: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      sessionId: SessionId,
      projectId: ProjectId,
      projectName: Schema.String,
      title: Schema.String,
      queued: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: 'Notice' });
export type Notice = typeof Notice.Type;

export const HandoffKind = Schema.Literals([
  'switch',
  'modelChange',
  'memoryLost',
  'fork',
]).annotate({
  identifier: 'HandoffKind',
});
export type HandoffKind = typeof HandoffKind.Type;

/** Durable handoff boundary recorded on the Transcript when a Summary handoff commits. */
export const HandoffBoundary = Schema.TaggedStruct('HandoffBoundary', {
  kind: HandoffKind,
  fromAgentId: AgentId,
  toAgentId: AgentId,
  fromModel: Schema.optionalKey(Schema.String),
  toModel: Schema.optionalKey(Schema.String),
  summary: Schema.String,
  imageCount: Schema.Number,
  contextId: Schema.String,
}).annotate({ identifier: 'HandoffBoundary' });
export type HandoffBoundary = typeof HandoffBoundary.Type;

/** Durable lineage recorded on a Fork Session pointing back to its source Session and Turn (spec 2.6). */
export const ForkLineage = Schema.Struct({
  sourceSessionId: SessionId,
  sourceTurnId: Schema.optionalKey(TurnId),
  sourceTurnNumber: Schema.Number,
  sourceTitle: Schema.String,
  sourceDeleted: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'ForkLineage' });
export type ForkLineage = typeof ForkLineage.Type;

/** Reciprocal fork link recorded on a source Session pointing to a surviving Fork (spec 2.6). */
export const ForkTarget = Schema.Struct({
  forkSessionId: SessionId,
  sourceTurnId: TurnId,
  forkTitle: Schema.String,
}).annotate({ identifier: 'ForkTarget' });
export type ForkTarget = typeof ForkTarget.Type;

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
  HandoffBoundary,
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

export const SessionStatus = Schema.Literals(['idle', 'working', 'blocked', 'error']).annotate({
  identifier: 'SessionStatus',
});
export type SessionStatus = typeof SessionStatus.Type;

export const Attention = Schema.Literals(['blocked', 'error']).annotate({
  identifier: 'Attention',
});
export type Attention = typeof Attention.Type;

export const isAttentionStatus = (status: SessionStatus): status is Attention =>
  status === 'blocked' || status === 'error';

export const LastTurnOutcome = Schema.Literals([
  'done',
  'cancelled',
  'refused',
  'cutShort',
  'failed',
]).annotate({ identifier: 'LastTurnOutcome' });
export type LastTurnOutcome = typeof LastTurnOutcome.Type;

export const LastTurn = Schema.Struct({
  turnId: TurnId,
  outcome: LastTurnOutcome,
}).annotate({ identifier: 'LastTurn' });
export type LastTurn = typeof LastTurn.Type;

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
  model: Schema.optionalKey(
    Schema.Struct({ value: Schema.optionalKey(Schema.String), choices: Schema.Array(Model) }),
  ),
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

/** Who owns a Composer action: Spence itself, or the Agent and its vendor. */
export const ActionOwner = Schema.Struct({
  kind: Schema.Literals(['spence', 'agent']),
  /** Shown as-is: Spence, or the Agent's name from the Catalog. Never Agent output. */
  name: Schema.String,
}).annotate({ identifier: 'ActionOwner' });
export type ActionOwner = typeof ActionOwner.Type;

/** What kind of action an entry is, independently of who owns it. */
export const ActionKind = Schema.Literals(['skill', 'command']).annotate({
  identifier: 'ActionKind',
});
export type ActionKind = typeof ActionKind.Type;

/**
 * A Composer entry in the `/` palette. `id` is stable across catalog updates; `invocation` is the exact editable text
 * selection inserts. Kind is only `skill` when the Agent's adapter supplied reliable evidence.
 */
export const Command = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  invocation: Schema.String,
  owner: ActionOwner,
  kind: ActionKind,
  description: Schema.optionalKey(Schema.String),
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

export const WorkerKind = Schema.Literals(['owned', 'native']).annotate({
  identifier: 'WorkerKind',
});
export type WorkerKind = typeof WorkerKind.Type;

export const WorkerInfo = Schema.Struct({
  sessionId: SessionId,
  title: Schema.String,
  state: Schema.Literals(['running', 'requiresAction', 'idle', 'unknown']),
  stageOutcome: Schema.optionalKey(TurnOutcome),
  /** The Agent running the Worker, for its monogram. */
  agentId: Schema.optionalKey(AgentId),
  agentName: Schema.optionalKey(Schema.String),
  /** The Model's display name, when the Agent has one. */
  modelName: Schema.optionalKey(Schema.String),
  /** When the Worker's current run began (ms since the epoch); the panel shows the time since. */
  startedAt: Schema.optionalKey(Schema.Number),
  /** The Parent's Turn that started this Worker; the thread line for that Turn lists it. */
  turnId: Schema.optionalKey(TurnId),
  /** The current Step: its kind and target (file, command, search). Absent while thinking or between Steps. */
  action: Schema.optionalKey(Schema.Struct({ kind: StepKind, target: Schema.String })),
}).annotate({ identifier: 'WorkerInfo' });
export type WorkerInfo = typeof WorkerInfo.Type;

/** A Message waiting in the Queue; it becomes a Transcript Message only when its Turn starts. */
export const QueuedMessage = Schema.Struct({
  id: MessageId,
  parts: Schema.Array(MessagePart),
  from: Schema.optionalKey(MessageSender),
}).annotate({ identifier: 'QueuedMessage' });
export type QueuedMessage = typeof QueuedMessage.Type;

const VerificationRetry = Schema.Struct({ turnId: TurnId, originalTurnId: TurnId }).annotate({
  identifier: 'VerificationRetry',
});

export const LiveState = Schema.Struct({
  workers: Schema.optionalKey(Schema.Array(WorkerInfo)),
  verificationRetries: Schema.optionalKey(Schema.Array(VerificationRetry)),
  parentSessionId: Schema.optionalKey(SessionId),
  workerKind: Schema.optionalKey(WorkerKind),
  agentStatus: AgentStatus,
  status: SessionStatus,
  /** The last settled Turn in the current Agent context, if any. */
  lastTurn: Schema.optionalKey(LastTurn),
  /** The Turn running when a subscription begins, if any. */
  runningTurn: Schema.optionalKey(TurnId),
  /** The Queue, in send order; replaced whole. Ephemeral: never part of the Transcript until sent. */
  queue: Schema.Array(QueuedMessage),
  /** Whether the Agent can redirect a running Turn without cancelling it. */
  steeringSupported: Schema.optionalKey(Schema.Boolean),
  title: SessionTitle,
  options: SessionOptions,
  /** Replaced whole when the Agent reports its catalog. */
  commands: Schema.Array(Command),
  /** Whether the Agent has reported its catalog yet: false while discovery is loading. */
  commandsLoaded: Schema.Boolean,
  canAttachImages: Schema.Boolean,
  compacting: Schema.optionalKey(Schema.Boolean),
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
  loginInstructions: Schema.optionalKey(Schema.String),
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
  /** True when reopening failed to restore the active Agent context, until resolved by the user. */
  memoryLost: Schema.optionalKey(Schema.Boolean),
  /** True while a Summary handoff acknowledgement Turn is starting on a destination Agent. */
  handoffRunning: Schema.optionalKey(Schema.Boolean),
  /** Durable lineage when this Session is a Fork. */
  forkLineage: Schema.optionalKey(ForkLineage),
  /** Reciprocal links to surviving Forks branched from this Session. */
  forks: Schema.optionalKey(Schema.Array(ForkTarget)),
  /** Owning Device id for a Paired remote Session; absent or `'local'` on the Local device. */
  deviceId: Schema.optionalKey(Schema.String),
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

export const SessionWorkerSummary = Schema.Struct({
  sessionId: SessionId,
  parentSessionId: SessionId,
  title: Schema.String,
  state: WorkerInfo.fields.state,
});
export type SessionWorkerSummary = typeof SessionWorkerSummary.Type;

export const SessionSummary = Schema.Struct({
  id: SessionId,
  agentId: AgentId,
  title: SessionTitle,
  lastActivityAt: Timestamp,
  archivedAt: Schema.optionalKey(Timestamp),
  status: SessionStatus,
  /** How many Worker descendants deleting this Session would also delete; absent at zero. */
  workerCount: Schema.optionalKey(Schema.Number),
  /** Worker descendants with their immediate Parent, in sidebar order. */
  workers: Schema.optionalKey(Schema.Array(SessionWorkerSummary)),
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
    'NotRunning',
    'Unsupported',
    'MemoryLost',
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

// Summary handoff contracts (spec 2.5, 3.5; shared by Switch Agent and Fork).

export const HandoffDraftSource = Schema.Literals([
  'isolatedSummary',
  'transcriptExtract',
]).annotate({
  identifier: 'HandoffDraftSource',
});
export type HandoffDraftSource = typeof HandoffDraftSource.Type;

export const HandoffSourceEndpoint = Schema.Struct({
  sessionId: SessionId,
  /** Latest settled Turn id (including `cancelled`), if any. */
  turnId: Schema.optionalKey(TurnId),
  /** 1-based count of settled Turns (0 when none). */
  turnNumber: Schema.Number,
  /** Latest Transcript seq when preparation ran. */
  seq: Schema.Number,
  /** Number of Messages in the Transcript when preparation ran. */
  messageCount: Schema.Number,
}).annotate({ identifier: 'HandoffSourceEndpoint' });
export type HandoffSourceEndpoint = typeof HandoffSourceEndpoint.Type;

export const HandoffImage = Schema.Struct({
  id: Schema.String,
  name: Schema.optionalKey(Schema.String),
  mimeType: Schema.String,
  data: Schema.String,
  turnId: TurnId,
  role: Role,
  seq: Schema.Number,
}).annotate({ identifier: 'HandoffImage' });
export type HandoffImage = typeof HandoffImage.Type;

export const HandoffTokenBudget = Schema.Struct({
  estimatedTokens: Schema.Number,
  capTokens: Schema.Number,
  /** True when destination capacity is known (`min(10% capacity, 8,000)`); false when provisional `4,000`. */
  knownCapacity: Schema.Boolean,
  destinationCapacity: Schema.optionalKey(Schema.Number),
  overBudget: Schema.Boolean,
}).annotate({ identifier: 'HandoffTokenBudget' });
export type HandoffTokenBudget = typeof HandoffTokenBudget.Type;

export const HandoffBlockedImage = Schema.Struct({
  imageId: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: 'HandoffBlockedImage' });
export type HandoffBlockedImage = typeof HandoffBlockedImage.Type;

export const HandoffCompatibility = Schema.Struct({
  agentId: AgentId,
  agentName: Schema.String,
  installed: Schema.Boolean,
  canRun: Schema.Boolean,
  unconfirmedExit: Schema.optionalKey(UnconfirmedExit),
  capabilities: AgentCapabilities,
  imageLimits: ImageLimits,
  availableModels: Schema.Array(Model),
  /** Prefilled current Model if valid for destination, else configured default; undefined if none known/valid. */
  resolvedModel: Schema.optionalKey(Schema.String),
  /** Non-empty when the source Model was not valid for destination (never silently substituted). */
  modelMismatchNote: Schema.optionalKey(Schema.String),
  resolvedEffort: Schema.optionalKey(Effort),
  effortNote: Schema.optionalKey(Schema.String),
  resolvedPermissionMode: PermissionMode,
  permissionNote: Schema.optionalKey(Schema.String),
  destinationCapacity: Schema.optionalKey(Schema.Number),
  blockedImages: Schema.Array(HandoffBlockedImage),
}).annotate({ identifier: 'HandoffCompatibility' });
export type HandoffCompatibility = typeof HandoffCompatibility.Type;

export const HandoffPreparation = Schema.Struct({
  kind: HandoffKind,
  endpoint: HandoffSourceEndpoint,
  summary: Schema.String,
  draftSource: HandoffDraftSource,
  fallbackReason: Schema.optionalKey(Schema.String),
  images: Schema.Array(HandoffImage),
  destinations: Schema.Array(HandoffCompatibility),
  defaultDestinationAgentId: AgentId,
  requestedModel: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'HandoffPreparation' });
export type HandoffPreparation = typeof HandoffPreparation.Type;

export const HandoffRevalidation = Schema.Struct({
  endpointAdvanced: Schema.Boolean,
  currentEndpoint: HandoffSourceEndpoint,
  compatibility: HandoffCompatibility,
  budget: HandoffTokenBudget,
}).annotate({ identifier: 'HandoffRevalidation' });
export type HandoffRevalidation = typeof HandoffRevalidation.Type;

export const HandoffAttemptStatus = Schema.Literals(['failed', 'interrupted']).annotate({
  identifier: 'HandoffAttemptStatus',
});
export type HandoffAttemptStatus = typeof HandoffAttemptStatus.Type;

/** Durable record of a failed or interrupted Summary handoff startup, inspectable from the source Session. */
export const HandoffAttempt = Schema.Struct({
  id: HandoffAttemptId,
  kind: HandoffKind,
  status: HandoffAttemptStatus,
  createdAt: Timestamp,
  sourceEndpoint: HandoffSourceEndpoint,
  targetAgentId: AgentId,
  targetAgentName: Schema.String,
  targetModel: Schema.optionalKey(Schema.String),
  summary: Schema.String,
  selectedImageIds: Schema.Array(Schema.String),
  messages: Schema.Array(Message),
  steps: Schema.Array(Step),
  diskStateNote: Schema.optionalKey(Schema.String),
  failureReason: Schema.String,
}).annotate({ identifier: 'HandoffAttempt' });
export type HandoffAttempt = typeof HandoffAttempt.Type;

export const HandoffResult = Schema.Union([
  Schema.TaggedStruct('committed', {
    contextId: Schema.String,
    forkSessionId: Schema.optionalKey(SessionId),
  }),
  Schema.TaggedStruct('failed', { attempt: HandoffAttempt }),
]).annotate({ identifier: 'HandoffResult' });
export type HandoffResult = typeof HandoffResult.Type;

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
    payload: {
      sessionId: SessionId,
      parts: Schema.Array(MessagePart),
      workflow: Schema.optional(WorkflowKind),
      verificationOf: Schema.optional(TurnId),
    },
    success: TurnId,
    error: SessionError,
  }),
  /** Injects a Message into the running Turn without cancelling it; `NotRunning`/`Unsupported` otherwise. */
  Rpc.make('Session.steer', {
    payload: { sessionId: SessionId, parts: Schema.Array(MessagePart) },
    error: SessionError,
  }),
  /** Lines a Message up in the Queue; with no Turn running it starts one at once. */
  Rpc.make('Session.enqueue', {
    payload: { sessionId: SessionId, parts: Schema.Array(MessagePart) },
    error: SessionError,
  }),
  /** Replaces the Queue whole (reorder, edit, remove). */
  Rpc.make('Session.setQueue', {
    payload: { sessionId: SessionId, queue: Schema.Array(QueuedMessage) },
    error: SessionError,
  }),
  /** Drops every queued Message; never touches a running Turn. */
  Rpc.make('Session.clearQueue', {
    payload: { sessionId: SessionId },
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
  /** Triggers manual Context compaction on the live ACP session (stopped Turn only). */
  Rpc.make('Session.compact', {
    payload: { sessionId: SessionId },
    error: SessionError,
  }),
  /** Dismisses the `memoryLost` reopen gate so the next prompt starts on the fresh empty Agent context. */
  Rpc.make('Session.startEmptyContext', {
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
  /** How many Worker descendants deleting this Session would also delete (nested included). */
  Rpc.make('Session.countWorkers', {
    payload: { sessionId: SessionId },
    success: Schema.Number,
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
  /** Prepares a reviewed Summary handoff (isolated summary when supported, else deterministic Transcript extract). */
  Rpc.make('Session.prepareHandoff', {
    payload: {
      sessionId: SessionId,
      kind: HandoffKind,
      targetAgentId: Schema.optionalKey(AgentId),
      targetModel: Schema.optionalKey(Schema.String),
    },
    success: HandoffPreparation,
    error: SessionError,
  }),
  /** Revalidates source endpoint, destination capabilities, `'exit'` confirmation, and summary token budget. */
  Rpc.make('Session.revalidateHandoff', {
    payload: {
      sessionId: SessionId,
      endpoint: HandoffSourceEndpoint,
      targetAgentId: AgentId,
      targetModel: Schema.optionalKey(Schema.String),
      summary: Schema.String,
      selectedImageIds: Schema.Array(Schema.String),
    },
    success: HandoffRevalidation,
    error: SessionError,
  }),
  /** Executes destination startup acknowledgement and commits the handoff only upon clean acknowledgement. */
  Rpc.make('Session.executeHandoff', {
    payload: {
      sessionId: SessionId,
      kind: HandoffKind,
      endpoint: HandoffSourceEndpoint,
      targetAgentId: AgentId,
      targetModel: Schema.optionalKey(Schema.String),
      summary: Schema.String,
      selectedImageIds: Schema.Array(Schema.String),
      allowEndpointAdvance: Schema.optionalKey(Schema.Boolean),
    },
    success: HandoffResult,
    error: SessionError,
  }),
  /** Lists durable failed/interrupted Handoff attempts inspectable on a Session. */
  Rpc.make('Session.listHandoffAttempts', {
    payload: { sessionId: SessionId },
    success: Schema.Array(HandoffAttempt),
    error: SessionError,
  }),
);
