import type {
  ContentBlock,
  PermissionOptionKind,
  PromptResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionUpdate,
  StopReason,
  ToolCallUpdate,
  ToolKind,
} from '@agentclientprotocol/sdk';
import { Cause, Exit, Option } from 'effect';
import {
  MessageId,
  ThoughtId,
  type MessagePart,
  type PermissionOption,
  type PermissionRequest,
  type PermissionRequestId,
  type Step,
  type StepId,
  type StepKind,
  type TranscriptItem,
  type TurnId,
  type TurnOutcome,
} from '../../src/shared/sessions/sessions.rpc';
import type { AcpError } from './acpErrors';

// ACP -> Spence contract. Main folds ACP's partial updates into whole Transcript items; only Message and Thought text
// stream, as deltas appended to the item the Turn has open.

/** What a running Turn has open: the agent Message or the Thought the next text chunk appends to. */
export interface TurnFold {
  readonly turnId: TurnId;
  readonly message?: MessageId;
  readonly thought?: ThoughtId;
}

export const openTurn = (turnId: TurnId): TurnFold => ({ turnId });

/**
 * Folds one `session/update` into the Turn: the items it adds to the Transcript, and what the Turn has open after it.
 * A Thought interrupts the Message (and the other way round), so text after it starts a new item. Only text is
 * mapped in v1: `user_message_chunk` (the Agent's echo of what we sent) and everything else are dropped for now.
 */
export const foldUpdate = (
  fold: TurnFold,
  update: SessionUpdate,
  newId: () => string,
): readonly [TurnFold, ReadonlyArray<TranscriptItem>] => {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      if (update.content.type !== 'text') return [fold, []];
      const { text } = update.content;
      if (fold.message !== undefined) {
        return [fold, [{ _tag: 'MessageDelta', id: fold.message, text }]];
      }
      const id = MessageId.make(newId());
      return [
        { turnId: fold.turnId, message: id },
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
        { turnId: fold.turnId, thought: id },
        [{ _tag: 'Thought', id, turnId: fold.turnId, text }],
      ];
    }
    // The echo of what we sent, and everything v1 does not show yet.
    case 'user_message_chunk':
    case 'tool_call':
    case 'tool_call_update':
    case 'plan':
    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'usage_update':
    case 'notice':
    case 'compaction_update':
    case 'compaction_summary_chunk':
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
