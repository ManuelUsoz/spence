import type { PermissionMode } from '../../../shared/projects/projects.rpc';
import type {
  LiveState,
  MessageId,
  MessagePart,
  PermissionOption,
  PermissionRequestId,
  PermissionState,
  SessionStreamItem,
  StepId,
  StepKind,
  StepStatus,
  TurnId,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';

/** One Message in the thread, its text parts joined. */
export interface ThreadMessage {
  readonly id: MessageId;
  readonly turnId: TurnId;
  readonly role: 'user' | 'agent';
  readonly text: string;
}

/** A Step the Agent took, kept for the Receipt. */
export interface ThreadStep {
  readonly turnId: TurnId;
  readonly id: StepId;
  readonly title: string;
  readonly kind: StepKind;
  readonly status: StepStatus;
}

/** A Permission request about a Step, as shown in the Dock and recorded on the Receipt. */
export interface ThreadPermission {
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly id: PermissionRequestId;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly state: PermissionState;
}

/** What the Session view shows: folded from `Session.events`. */
export interface Thread {
  readonly live: LiveState | null;
  /** The Session's current Permission mode, from the live state. */
  readonly permissionMode: PermissionMode | null;
  readonly messages: ReadonlyArray<ThreadMessage>;
  /** The Turn that started and has not ended. */
  readonly running: TurnId | null;
  /** How each ended Turn ended. */
  readonly outcomes: ReadonlyMap<TurnId, TurnOutcome>;
  /** Steps seen so far, latest version by id. */
  readonly steps: ReadonlyArray<ThreadStep>;
  /** Permission requests seen so far, latest version by id. */
  readonly permissions: ReadonlyArray<ThreadPermission>;
  /** The last Transcript `seq` folded in: a resubscription asks for what came after it. */
  readonly lastSeq: number;
}

export const emptyThread: Thread = {
  live: null,
  permissionMode: null,
  messages: [],
  running: null,
  outcomes: new Map(),
  steps: [],
  permissions: [],
  lastSeq: 0,
};

const textOf = (parts: ReadonlyArray<MessagePart>): string =>
  parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');

const replaceStep = (
  steps: ReadonlyArray<ThreadStep>,
  step: ThreadStep,
): ReadonlyArray<ThreadStep> => {
  const index = steps.findIndex((existing) => existing.id === step.id);
  if (index === -1) return [...steps, step];
  const next = [...steps];
  next[index] = step;
  return next;
};

const replacePermission = (
  permissions: ReadonlyArray<ThreadPermission>,
  request: ThreadPermission,
): ReadonlyArray<ThreadPermission> => {
  const index = permissions.findIndex((existing) => existing.id === request.id);
  if (index === -1) return [...permissions, request];
  const next = [...permissions];
  next[index] = request;
  return next;
};

/** Folds one stream item into the thread. A Transcript event at or below `lastSeq` was seen already. */
export const foldThread = (thread: Thread, streamed: SessionStreamItem): Thread => {
  if (streamed._tag === 'Live') {
    return {
      ...thread,
      live: streamed.state,
      permissionMode: streamed.state.options.permissionMode,
    };
  }
  const { seq, item } = streamed.event;
  if (seq <= thread.lastSeq) return thread;
  const next = { ...thread, lastSeq: seq };
  switch (item._tag) {
    case 'TurnStarted':
      return { ...next, running: item.turnId };
    case 'TurnEnded':
      return {
        ...next,
        running: thread.running === item.turnId ? null : thread.running,
        outcomes: new Map(thread.outcomes).set(item.turnId, item.outcome),
      };
    case 'Message':
      return {
        ...next,
        messages: [
          ...thread.messages,
          { id: item.id, turnId: item.turnId, role: item.role, text: textOf(item.parts) },
        ],
      };
    case 'MessageDelta':
      return {
        ...next,
        messages: thread.messages.map((message) =>
          message.id === item.id ? { ...message, text: message.text + item.text } : message,
        ),
      };
    case 'Step':
      return {
        ...next,
        steps: replaceStep(thread.steps, {
          turnId: item.turnId,
          id: item.id,
          title: item.title,
          kind: item.kind,
          status: item.status,
        }),
      };
    case 'PermissionRequest':
      return {
        ...next,
        permissions: replacePermission(thread.permissions, {
          turnId: item.turnId,
          stepId: item.stepId,
          id: item.id,
          options: item.options,
          state: item.state,
        }),
      };
    // Kept in the Transcript; the thread shows them in later issues.
    case 'Thought':
    case 'ThoughtDelta':
    case 'Plan':
    case 'Compaction':
    case 'Notice':
    case 'ContextCleared':
      return next;
  }
};

/** A run of Agent text: prose, inline code, or a fenced code block. */
export interface TextRun {
  readonly kind: 'prose' | 'code' | 'block';
  readonly text: string;
}

export const permissionMark = (
  step: ThreadStep,
  permissions: ReadonlyArray<ThreadPermission>,
): 'auto' | 'rejected' | null => {
  const request = permissions.find((permission) => permission.stepId === step.id);
  if (request === undefined) return null;
  const { state } = request;
  if (state._tag === 'answered') {
    if (state.by === 'policy') return 'auto';
    const selected = request.options.find((option) => option.id === state.optionId);
    if (
      selected !== undefined &&
      (selected.kind === 'rejectOnce' || selected.kind === 'rejectAlways')
    ) {
      return 'rejected';
    }
  }
  if (state._tag === 'cancelled') return 'rejected';
  return null;
};

/** Splits Agent text into prose and code, by Markdown's backtick fences and inline code spans. */
export const textRuns = (text: string): ReadonlyArray<TextRun> =>
  text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/)
    .filter((piece) => piece !== '')
    .map((piece): TextRun => {
      if (piece.startsWith('```')) {
        const body = piece.replace(/^```[^\n]*\n?/, '').replace(/```$/, '');
        return { kind: 'block', text: body.replace(/\n$/, '') };
      }
      if (piece.length > 1 && piece.startsWith('`') && piece.endsWith('`')) {
        return { kind: 'code', text: piece.slice(1, -1) };
      }
      return { kind: 'prose', text: piece };
    });
