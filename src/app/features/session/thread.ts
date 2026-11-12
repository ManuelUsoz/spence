import type {
  ContextCleared,
  LiveState,
  MessageId,
  MessagePart,
  SessionStreamItem,
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

/** A divider marking where the Agent's memory started over. */
export interface ThreadDivider {
  /** The divider is shown before the Message at this index; `messages.length` means after the last one. */
  readonly beforeIndex: number;
  readonly reason: ContextCleared['reason'];
}

/** What the Session view shows: folded from `Session.events`. */
export interface Thread {
  readonly live: LiveState | null;
  readonly messages: ReadonlyArray<ThreadMessage>;
  /** The Turn that started and has not ended. */
  readonly running: TurnId | null;
  /** How each ended Turn ended. */
  readonly outcomes: ReadonlyMap<TurnId, TurnOutcome>;
  /** Dividers marking where the Agent's memory started over. */
  readonly dividers: ReadonlyArray<ThreadDivider>;
  /** The last Transcript `seq` folded in: a resubscription asks for what came after it. */
  readonly lastSeq: number;
}

export const emptyThread: Thread = {
  live: null,
  messages: [],
  running: null,
  outcomes: new Map(),
  dividers: [],
  lastSeq: 0,
};

const textOf = (parts: ReadonlyArray<MessagePart>): string =>
  parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');

/** Folds one stream item into the thread. A Transcript event at or below `lastSeq` was seen already. */
export const foldThread = (thread: Thread, streamed: SessionStreamItem): Thread => {
  if (streamed._tag === 'Live') return { ...thread, live: streamed.state };
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
    case 'ContextCleared':
      return {
        ...next,
        dividers: [
          ...thread.dividers,
          { beforeIndex: thread.messages.length, reason: item.reason },
        ],
      };
    // Kept in the Transcript; the thread shows them in later issues.
    case 'Thought':
    case 'ThoughtDelta':
    case 'Step':
    case 'Plan':
    case 'PermissionRequest':
    case 'Compaction':
    case 'Notice':
      return next;
  }
};

/** A run of Agent text: prose, inline code, or a fenced code block. */
export interface TextRun {
  readonly kind: 'prose' | 'code' | 'block';
  readonly text: string;
}

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
