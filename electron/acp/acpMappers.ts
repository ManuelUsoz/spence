import type {
  CompactionStatus,
  ContentBlock,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallContent,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk/unstable';
import { Cause, Exit, Option } from 'effect';
import path from 'node:path';
import {
  type Compaction,
  CompactionId,
  type ContextUsage,
  type Diff,
  MessageId,
  type Notice,
  type PlanEntry,
  type Step,
  StepId,
  type StepKind,
  type StepStatus,
  ThoughtId,
  type MessagePart,
  type PermissionOption,
  type PermissionRequest,
  type PermissionRequestId,
  type TranscriptItem,
  type TurnId,
  type TurnOutcome,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpError } from './acpErrors';

// ACP -> Spence contract. Main folds ACP's partial updates into whole Transcript items; only Message and Thought text
// stream, as deltas appended to the item the Turn has open.

/**
 * What a running Turn has open: the agent Message or the Thought the next text chunk appends to, and every Step and
 * Compaction so far, by the Agent's id, so an update can be merged into the whole item.
 */
export interface TurnFold {
  readonly turnId: TurnId;
  /** The Project folder: Step files are made relative to it. */
  readonly cwd: string;
  readonly message?: MessageId;
  readonly thought?: ThoughtId;
  readonly steps: ReadonlyMap<string, Step>;
  readonly compactions: ReadonlyMap<string, Compaction>;
}

export const openTurn = (turnId: TurnId, cwd: string): TurnFold => ({
  turnId,
  cwd,
  steps: new Map(),
  compactions: new Map(),
});

/** The fold with no Message or Thought open: the next text starts a new one. */
const closeText = ({ message: _message, thought: _thought, ...fold }: TurnFold): TurnFold => fold;

const stepKind = (kind: ToolKind | null | undefined): StepKind => {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'fetch':
    case 'other':
      return kind;
    case 'think':
    case 'switch_mode':
    case null:
    case undefined:
      return 'other';
  }
};

const stepStatus = (status: ToolCallStatus): StepStatus => {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'failed':
      return 'failed';
  }
};

/** A path the Agent gave, relative to the Project (with `/`) when it is inside it, else as given. */
const inProject = (cwd: string, file: string): string => {
  const relative = path.relative(cwd, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative)
    ? file
    : relative.split(path.sep).join('/');
};

/** The diffs and text output of a tool call's content; terminals are dropped. */
const contentOf = (cwd: string, content: ReadonlyArray<ToolCallContent>) => ({
  diffs: content.flatMap((part): ReadonlyArray<Diff> => {
    if (part.type !== 'diff') return [];
    const before = part.oldText ?? undefined;
    return [
      {
        path: inProject(cwd, part.path),
        ...(before === undefined ? {} : { before }),
        after: part.newText,
      },
    ];
  }),
  output: content
    .flatMap((part) =>
      part.type === 'content' && part.content.type === 'text' ? [part.content.text] : [],
    )
    .join('\n'),
});

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

type ToolCallFields = Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }>;

/**
 * A tool call or its update, merged into the Step with the same id: what the update leaves out is kept. Raw input and
 * output and terminals are dropped.
 */
const mergeStep = (
  fold: TurnFold,
  update: ToolCallFields,
  newId: () => string,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  const known = fold.steps.get(update.toolCallId);
  const base: Step = known ?? {
    _tag: 'Step',
    id: StepId.make(newId()),
    turnId: fold.turnId,
    title: '',
    kind: 'other',
    status: 'pending',
    files: [],
    diffs: [],
    output: '',
  };
  const content =
    update.content === undefined || update.content === null
      ? { diffs: base.diffs, output: base.output }
      : contentOf(fold.cwd, update.content);
  const located =
    update.locations === undefined || update.locations === null
      ? base.files
      : update.locations.map((location) => inProject(fold.cwd, location.path));
  const step: Step = {
    ...base,
    title: update.title ?? base.title,
    kind: update.kind === undefined || update.kind === null ? base.kind : stepKind(update.kind),
    status:
      update.status === undefined || update.status === null
        ? base.status
        : stepStatus(update.status),
    files: unique([...located, ...content.diffs.map((diff) => diff.path)]),
    diffs: content.diffs,
    output: content.output,
  };
  return [{ ...closeText(fold), steps: new Map(fold.steps).set(update.toolCallId, step) }, [step]];
};

/** The Turn's Steps that had not finished, now cancelled: a Step never runs on after its Turn ended. */
export const cancelSteps = (fold: TurnFold): ReadonlyArray<Step> =>
  [...fold.steps.values()]
    .filter((step) => step.status === 'pending' || step.status === 'running')
    .map((step) => ({ ...step, status: 'cancelled' }));

const planEntryStatus = (status: 'pending' | 'in_progress' | 'completed'): PlanEntry['status'] =>
  status === 'in_progress' ? 'inProgress' : status;

const noticeSeverity = (severity: string): Notice['severity'] =>
  severity === 'warning' || severity === 'error' ? severity : 'info';

const compactionStatus = (status: CompactionStatus): Compaction['status'] => {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return status;
    default:
      return 'running';
  }
};

const textOfBlocks = (blocks: ReadonlyArray<ContentBlock>): string =>
  blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');

/** Compaction-related ACP session update variants. */
export type CompactionUpdate = Extract<
  SessionUpdate,
  { readonly sessionUpdate: 'compaction_update' | 'compaction_summary_chunk' }
>;

/** Applies one Compaction update onto a compaction map keyed by ACP compactionId. */
export const applyCompactionUpdate = (
  compactions: ReadonlyMap<string, Compaction>,
  update: CompactionUpdate,
  newId: () => string,
): readonly [ReadonlyMap<string, Compaction>, Compaction] => {
  const base: Compaction = compactions.get(update.compactionId) ?? {
    _tag: 'Compaction',
    id: CompactionId.make(newId()),
    status: 'running',
    summary: '',
  };
  const compaction: Compaction =
    update.sessionUpdate === 'compaction_update'
      ? {
          ...base,
          status: compactionStatus(update.status),
          summary:
            update.summary === undefined || update.summary === null
              ? base.summary
              : textOfBlocks(update.summary),
        }
      : {
          ...base,
          summary: base.summary + textOfBlocks([update.content]),
        };
  return [new Map(compactions).set(update.compactionId, compaction), compaction];
};

/** A Compaction update merged into the whole item with the same id. */
const mergeCompaction = (
  fold: TurnFold,
  update: CompactionUpdate,
  newId: () => string,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  const [compactions, compaction] = applyCompactionUpdate(fold.compactions, update, newId);
  return [{ ...fold, compactions }, [compaction]];
};

/**
 * Folds one `session/update` into the Turn: the items it adds to the Transcript, and what the Turn has open after it.
 * A Thought interrupts the Message (and the other way round), and so does a Step, so text after it starts a new item.
 * `user_message_chunk` (the Agent's echo of what we sent) and what the thread does not show are dropped.
 */
export const foldUpdate = (
  fold: TurnFold,
  update: SessionUpdate,
  newId: () => string,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type === 'image') {
        const id = MessageId.make(newId());
        return [
          { ...closeText(fold), message: id },
          [
            {
              _tag: 'Message',
              id,
              turnId: fold.turnId,
              role: 'agent',
              parts: [
                { _tag: 'image', mimeType: update.content.mimeType, data: update.content.data },
              ],
            },
          ],
        ];
      }
      if (update.content.type !== 'text') return [fold, []];
      const { text } = update.content;
      if (fold.message !== undefined) {
        return [fold, [{ _tag: 'MessageDelta', id: fold.message, text }]];
      }
      const id = MessageId.make(newId());
      return [
        { ...closeText(fold), message: id },
        [
          {
            _tag: 'Message',
            id,
            turnId: fold.turnId,
            role: 'agent',
            parts: [{ _tag: 'text', text }],
          },
        ],
      ];
    }
    case 'agent_thought_chunk': {
      if (update.content.type !== 'text') return [fold, []];
      const { text } = update.content;
      if (fold.thought !== undefined) {
        return [fold, [{ _tag: 'ThoughtDelta', id: fold.thought, text }]];
      }
      const id = ThoughtId.make(newId());
      return [
        { ...closeText(fold), thought: id },
        [{ _tag: 'Thought', id, turnId: fold.turnId, text }],
      ];
    }
    case 'tool_call':
    case 'tool_call_update':
      return mergeStep(fold, update, newId);
    case 'plan':
      return [
        fold,
        [
          {
            _tag: 'Plan',
            entries: update.entries.map((entry) => ({
              content: entry.content,
              priority: entry.priority,
              status: planEntryStatus(entry.status),
            })),
          },
        ],
      ];
    case 'notice':
      return [
        fold,
        [
          {
            _tag: 'Notice',
            severity: noticeSeverity(update.severity),
            title: update.title,
            ...(update.description === undefined || update.description === null
              ? {}
              : { description: update.description }),
          },
        ],
      ];
    case 'compaction_update':
    case 'compaction_summary_chunk':
      return mergeCompaction(fold, update, newId);
    // The echo of what we sent, and what the thread does not show (or other domains fold).
    case 'user_message_chunk':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'subagent_update':
    case 'plan_update':
    case 'plan_removed':
    case 'session_message':
    case 'session_message_chunk':
      return [fold, []];
  }
};

/** The outcome of a Turn the Agent ended with `stopReason`. */
export const outcomeOf = (stopReason: StopReason): TurnOutcome => {
  switch (stopReason) {
    case 'end_turn':
      return { _tag: 'done' };
    case 'cancelled':
      return { _tag: 'cancelled' };
    case 'refusal':
      return { _tag: 'refused' };
    case 'max_tokens':
      return { _tag: 'cutShort', limit: 'maxTokens' };
    case 'max_turn_requests':
      return { _tag: 'cutShort', limit: 'maxTurnRequests' };
  }
};

/** The outcome of a Turn whose prompt failed. */
export const failedOutcome = (error: AcpError): TurnOutcome => {
  switch (error.reason) {
    case 'Exited':
      return { _tag: 'failed', reason: 'agentStopped', detail: error.detail };
    case 'AuthRequired':
      return { _tag: 'failed', reason: 'needsLogin', detail: error.detail };
    case 'ProtocolVersion':
    case 'Unsupported':
    case 'Refused':
      return { _tag: 'failed', reason: 'agentError', detail: error.detail };
  }
};

/** How a `session/prompt` ended, as a Turn outcome: its stop reason, or why it failed. */
export const promptOutcome = (result: Exit.Exit<PromptResponse, AcpError>): TurnOutcome =>
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

const stepKindOf = (kind: ToolKind | null | undefined): StepKind => {
  switch (kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
    case 'search':
    case 'execute':
    case 'fetch':
      return kind;
    case 'think':
    case 'switch_mode':
    case 'other':
    case null:
    case undefined:
      return 'other';
  }
};

/** The Step a Permission request asks about, from the tool call it carries, when the Turn has not seen it yet. */
export const stepOfToolCall = (toolCall: ToolCallUpdate, turnId: TurnId, id: StepId): Step => ({
  _tag: 'Step',
  id,
  turnId,
  title: toolCall.title ?? '',
  kind: stepKindOf(toolCall.kind),
  status: 'pending',
  files: [],
  diffs: [],
  output: '',
});

const optionKindOf = (kind: PermissionOptionKind): PermissionOption['kind'] => {
  switch (kind) {
    case 'allow_once':
      return 'allowOnce';
    case 'allow_always':
      return 'allowAlways';
    case 'reject_once':
      return 'rejectOnce';
    case 'reject_always':
      return 'rejectAlways';
  }
};

/** A `session/request_permission` as a pending Permission request about the Step `stepId`; options in the Agent's order. */
export const toPermissionRequest = (
  request: RequestPermissionRequest,
  ids: { readonly id: PermissionRequestId; readonly turnId: TurnId; readonly stepId: StepId },
): PermissionRequest => ({
  _tag: 'PermissionRequest',
  ...ids,
  options: request.options.map((option) => ({
    id: option.optionId,
    label: option.name,
    kind: optionKindOf(option.kind),
  })),
  state: { _tag: 'pending' },
});

/** The ACP answer for the option picked. */
export const selectedOutcome = (optionId: string): RequestPermissionOutcome => ({
  outcome: 'selected',
  optionId,
});

/** The ACP answer for a request nobody will answer: the Turn was cancelled or ended. */
export const cancelledOutcome: RequestPermissionOutcome = { outcome: 'cancelled' };

const toBlock = (part: MessagePart): ContentBlock => {
  switch (part._tag) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'image':
      return { type: 'image', mimeType: part.mimeType, data: part.data };
    case 'audio':
      return { type: 'audio', mimeType: part.mimeType, data: part.data };
    case 'link':
      return {
        type: 'resource_link',
        uri: part.uri,
        name: part.name,
        ...(part.title === undefined ? {} : { title: part.title }),
        ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
        ...(part.size === undefined ? {} : { size: part.size }),
      };
    case 'resource': {
      const mimeType = part.mimeType === undefined ? {} : { mimeType: part.mimeType };
      return {
        type: 'resource',
        resource:
          part.contents._tag === 'text'
            ? { uri: part.uri, ...mimeType, text: part.contents.text }
            : { uri: part.uri, ...mimeType, blob: part.contents.blob },
      };
    }
  }
};

/** A user Message's parts as an ACP prompt, in order. */
export const toAcpPrompt = (parts: ReadonlyArray<MessagePart>): Array<ContentBlock> =>
  parts.map(toBlock);

/**
 * Maps an ACP `usage_update` payload into a Spence `ContextUsage` reading (spec 2.3).
 * Invalid `used` returns `undefined` so a prior/historical reading is never overwritten with fabricated values;
 * missing/non-positive/non-finite `size` yields `countOnly` (`capacity` unknown).
 */
export const toContextUsage = (update: {
  readonly used?: unknown;
  readonly size?: unknown;
}): Extract<ContextUsage, { readonly _tag: 'reported' | 'countOnly' }> | undefined => {
  if (typeof update.used !== 'number' || !Number.isFinite(update.used) || update.used < 0) {
    return undefined;
  }
  if (typeof update.size === 'number' && Number.isFinite(update.size) && update.size > 0) {
    return { _tag: 'reported', used: update.used, capacity: update.size };
  }
  return { _tag: 'countOnly', used: update.used };
};
