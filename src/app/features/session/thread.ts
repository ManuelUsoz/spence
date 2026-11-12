import type {
  Compaction,
  LiveState,
  MessageId,
  MessagePart,
  Notice,
  Plan,
  SessionStreamItem,
  Step,
  StepKind,
  TranscriptItem,
  TurnId,
  TurnOutcome,
} from '../../../shared/sessions/sessions.rpc';

/** What a Turn is doing right now, for the Ticker. */
export type TurnActivity = 'starting' | 'thinking' | 'step' | 'writing';

/** A Turn's work beside its Messages: what the Ticker shows while it runs and the Receipt folds when it ends. */
export interface TurnWork {
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** In the order they started; an update replaces the Step with its id. */
  readonly steps: ReadonlyArray<Step>;
  /** Every Thought of the Turn, joined. */
  readonly thought: string;
  /** Time spent thinking, over the Thoughts that are over. */
  readonly thoughtMs: number;
  /** When the Thought being written started; null while the Agent is not thinking. */
  readonly thinkingSince: number | null;
  readonly activity: TurnActivity;
  /** The Turn's Plan, replaced whole; shown in the Dock, never in the thread. */
  readonly plan: Plan | null;
}

/** A Notice or Compaction, in the thread after the Message that came before it. */
export interface ThreadAside {
  readonly key: string;
  readonly afterMessage: MessageId | null;
  readonly item: Notice | Compaction;
}

/** One Message in the thread, its text parts joined. */
export interface ThreadMessage {
  readonly id: MessageId;
  readonly turnId: TurnId;
  readonly role: 'user' | 'agent';
  readonly text: string;
}

/** What the Session view shows: folded from `Session.events`. */
export interface Thread {
  readonly live: LiveState | null;
  readonly messages: ReadonlyArray<ThreadMessage>;
  /** The Turn that started and has not ended. */
  readonly running: TurnId | null;
  /** How each ended Turn ended. */
  readonly outcomes: ReadonlyMap<TurnId, TurnOutcome>;
  /** The last Transcript `seq` folded in: a resubscription asks for what came after it. */
  readonly lastSeq: number;
  /** Each Turn's Steps, Thought and Plan. */
  readonly work: ReadonlyMap<TurnId, TurnWork>;
  /** Notices and Compactions, in order. */
  readonly asides: ReadonlyArray<ThreadAside>;
}

export const emptyThread: Thread = {
  live: null,
  messages: [],
  running: null,
  outcomes: new Map(),
  lastSeq: 0,
  work: new Map(),
  asides: [],
};

const startWork = (at: number): TurnWork => ({
  startedAt: at,
  endedAt: null,
  steps: [],
  thought: '',
  thoughtMs: 0,
  thinkingSince: null,
  activity: 'starting',
  plan: null,
});

/** The Thought being written is over at `at`. */
const stopThinking = (work: TurnWork, at: number): TurnWork =>
  work.thinkingSince === null
    ? work
    : { ...work, thoughtMs: work.thoughtMs + (at - work.thinkingSince), thinkingSince: null };

const think = (work: TurnWork, at: number, text: string, separator: string): TurnWork => ({
  ...work,
  thought: work.thought === '' ? text : work.thought + separator + text,
  thinkingSince: work.thinkingSince ?? at,
  activity: 'thinking',
});

const putStep = (steps: ReadonlyArray<Step>, step: Step): ReadonlyArray<Step> =>
  steps.some((known) => known.id === step.id)
    ? steps.map((known) => (known.id === step.id ? step : known))
    : [...steps, step];

/** The Turn's work after one Transcript item that happened at `at`. */
const foldWork = (work: TurnWork, item: TranscriptItem, at: number): TurnWork => {
  switch (item._tag) {
    case 'Thought':
      return think(work, at, item.text, '\n\n');
    case 'ThoughtDelta':
      return think(work, at, item.text, '');
    case 'Step':
      return { ...stopThinking(work, at), steps: putStep(work.steps, item), activity: 'step' };
    case 'Message':
    case 'MessageDelta':
      return { ...stopThinking(work, at), activity: 'writing' };
    case 'Plan':
      return { ...work, plan: item };
    case 'TurnEnded':
      return { ...stopThinking(work, at), endedAt: at };
    case 'TurnStarted':
    case 'PermissionRequest':
    case 'Compaction':
    case 'Notice':
    case 'ContextCleared':
      return work;
  }
};

/** The aside list with a Notice or Compaction added, or a Compaction replaced in place. */
const putAside = (thread: Thread, item: Notice | Compaction, seq: number) => {
  const key = item._tag === 'Compaction' ? item.id : `notice-${seq}`;
  if (thread.asides.some((aside) => aside.key === key)) {
    return thread.asides.map((aside) => (aside.key === key ? { ...aside, item } : aside));
  }
  return [...thread.asides, { key, afterMessage: thread.messages.at(-1)?.id ?? null, item }];
};

/** Which Turn an item belongs to: its own, or (for items without one) the running Turn. */
const turnOf = (thread: Thread, item: TranscriptItem): TurnId | null => {
  switch (item._tag) {
    case 'TurnStarted':
    case 'TurnEnded':
    case 'Thought':
    case 'Step':
      return item.turnId;
    case 'Message':
      return item.role === 'agent' ? item.turnId : null;
    case 'MessageDelta':
      return thread.messages.some((message) => message.id === item.id && message.role === 'agent')
        ? thread.running
        : null;
    case 'ThoughtDelta':
    case 'Plan':
      return thread.running;
    case 'PermissionRequest':
    case 'Compaction':
    case 'Notice':
    case 'ContextCleared':
      return null;
  }
};

/** The thread with the item folded into its Turn's work. */
const withWork = (thread: Thread, item: TranscriptItem, at: number): Thread => {
  if (item._tag === 'TurnStarted') {
    return { ...thread, work: new Map(thread.work).set(item.turnId, startWork(at)) };
  }
  const turnId = turnOf(thread, item);
  const work = turnId === null ? undefined : thread.work.get(turnId);
  if (turnId === null || work === undefined) return thread;
  return { ...thread, work: new Map(thread.work).set(turnId, foldWork(work, item, at)) };
};

const textOf = (parts: ReadonlyArray<MessagePart>): string =>
  parts.map((part) => (part._tag === 'text' ? part.text : '')).join('');

/** Folds one stream item into the thread. A Transcript event at or below `lastSeq` was seen already. */
export const foldThread = (thread: Thread, streamed: SessionStreamItem): Thread => {
  if (streamed._tag === 'Live') return { ...thread, live: streamed.state };
  const { seq, at, item } = streamed.event;
  if (seq <= thread.lastSeq) return thread;
  const next = { ...thread, lastSeq: seq };
  switch (item._tag) {
    case 'TurnStarted':
      return { ...withWork(next, item, at), running: item.turnId };
    case 'TurnEnded':
      return {
        ...withWork(next, item, at),
        running: thread.running === item.turnId ? null : thread.running,
        outcomes: new Map(thread.outcomes).set(item.turnId, item.outcome),
      };
    case 'Message':
      return {
        ...withWork(next, item, at),
        messages: [
          ...thread.messages,
          { id: item.id, turnId: item.turnId, role: item.role, text: textOf(item.parts) },
        ],
      };
    case 'MessageDelta':
      return {
        ...withWork(next, item, at),
        messages: thread.messages.map((message) =>
          message.id === item.id ? { ...message, text: message.text + item.text } : message,
        ),
      };
    case 'Thought':
    case 'ThoughtDelta':
    case 'Step':
    case 'Plan':
      return withWork(next, item, at);
    case 'Notice':
    case 'Compaction':
      return { ...next, asides: putAside(thread, item, seq) };
    case 'PermissionRequest':
    case 'ContextCleared':
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

/** The work of `turnId`, if the thread has folded any. */
export const turnWork = (thread: Thread, turnId: TurnId): TurnWork | undefined =>
  thread.work.get(turnId);

/** The work of the Turn that is running, if any. */
export const runningWork = (thread: Thread): TurnWork | null => {
  const turnId = thread.running;
  if (turnId === null) return null;
  const work = thread.work.get(turnId);
  return work ?? null;
};

/** `true` when `index` is the last Message of its Turn. */
export const isLastMessageOfTurn = (thread: Thread, index: number): boolean => {
  const message = thread.messages[index];
  if (message === undefined) return false;
  const next = thread.messages[index + 1];
  return next === undefined || next.turnId !== message.turnId;
};

/** Milliseconds as a compact elapsed string: `mm:ss` when under an hour, else `h:mm:ss`. */
export const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours === 0 ? mmss : `${hours}:${mmss}`;
};

/** The target to show in the Ticker for a Step: file path, command, search text, etc. */
export const stepTarget = (step: Step): string => {
  switch (step.kind) {
    case 'read':
    case 'edit':
    case 'delete':
    case 'move':
      return step.files[0] ?? step.title;
    case 'execute':
    case 'search':
    case 'fetch':
    case 'other':
      return step.title;
  }
};

/** The current Plan entry: the first one that is not completed. */
export const currentPlanEntry = (plan: Plan): Plan['entries'][number] | undefined =>
  plan.entries.find((entry) => entry.status !== 'completed') ?? plan.entries.at(-1);

/** How many Plan entries are completed. */
export const completedPlanCount = (plan: Plan): number =>
  plan.entries.filter((entry) => entry.status === 'completed').length;

/** Lines in a diff, preserving repeated lines and their order. */
export const diffLines = (
  before: string | undefined,
  after: string,
): ReadonlyArray<{ mark: '-' | '+' | ' '; text: string }> => {
  const oldLines = before === undefined ? [] : before.split('\n');
  const newLines = after.split('\n');
  const lengths = Array.from({ length: oldLines.length + 1 }, () =>
    Array<number>(newLines.length + 1).fill(0),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      const row = lengths[i];
      if (row === undefined) continue;
      row[j] =
        oldLines[i] === newLines[j]
          ? 1 + (lengths[i + 1]?.[j + 1] ?? 0)
          : Math.max(lengths[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const result: { mark: '-' | '+' | ' '; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length || j < newLines.length) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine !== undefined && oldLine === newLine) {
      result.push({ mark: ' ', text: oldLine });
      i++;
      j++;
    } else if (
      oldLine !== undefined &&
      (newLine === undefined || (lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0))
    ) {
      result.push({ mark: '-', text: oldLine });
      i++;
    } else if (newLine !== undefined) {
      result.push({ mark: '+', text: newLine });
      j++;
    }
  }
  return result;
};

/** Added and removed line counts for a diff, shown as `+a −d`. */
export const diffStats = (
  before: string | undefined,
  after: string,
): { added: number; removed: number } => {
  const lines = diffLines(before, after);
  const added = lines.filter((line) => line.mark === '+').length;
  const removed = lines.filter((line) => line.mark === '-').length;
  return { added, removed };
};

/** All changed files across a Turn's Steps, with their diffs. */
export const changedFiles = (
  work: TurnWork,
): ReadonlyArray<{ path: string; diff: { before?: string; after: string } }> => {
  const files = new Map<string, { before?: string; after: string }>();
  for (const step of work.steps) {
    for (const diff of step.diffs) {
      const previous = files.get(diff.path);
      files.set(diff.path, previous === undefined ? diff : { ...previous, after: diff.after });
    }
  }
  return [...files].map(([path, diff]) => ({ path, diff }));
};

/** The kind of Step as a presentational label for tooltips / accessible names. */
export const stepKindLabel = (kind: StepKind): string => {
  switch (kind) {
    case 'read':
      return $localize`Reading`;
    case 'edit':
      return $localize`Editing`;
    case 'delete':
      return $localize`Deleting`;
    case 'move':
      return $localize`Moving`;
    case 'search':
      return $localize`Searching`;
    case 'execute':
      return $localize`Running`;
    case 'fetch':
      return $localize`Fetching`;
    case 'other':
      return $localize`Working`;
  }
};

/** A readable activity label for the Ticker's accessible name. */
export const activityLabel = (activity: TurnActivity): string => {
  switch (activity) {
    case 'starting':
      return $localize`Starting`;
    case 'thinking':
      return $localize`Thinking`;
    case 'step':
      return $localize`Working`;
    case 'writing':
      return $localize`Writing`;
  }
};

/** One visual row in the thread: a Message, a Ticker, an aside, a Receipt or an outcome line. */
export type ThreadRow =
  | { readonly type: 'message'; readonly message: ThreadMessage }
  | { readonly type: 'ticker'; readonly turnId: TurnId }
  | { readonly type: 'aside'; readonly aside: ThreadAside }
  | { readonly type: 'receipt'; readonly turnId: TurnId }
  | { readonly type: 'outcome'; readonly outcome: TurnOutcome };

/** The thread flattened into rows, in the order they appear on screen. */
export const threadRows = (thread: Thread): ReadonlyArray<ThreadRow> => {
  const rows: ThreadRow[] = [];
  for (let i = 0; i < thread.messages.length; i++) {
    const message = thread.messages[i];
    if (message === undefined) continue;
    rows.push({ type: 'message', message });
    if (message.role === 'user' && thread.running === message.turnId) {
      rows.push({ type: 'ticker', turnId: message.turnId });
    }
    for (const aside of thread.asides) {
      if (aside.afterMessage === message.id) rows.push({ type: 'aside', aside });
    }
    if (isLastMessageOfTurn(thread, i)) {
      const turnId = message.turnId;
      const outcome = thread.outcomes.get(turnId);
      if (outcome !== undefined && outcome._tag !== 'done') {
        rows.push({ type: 'outcome', outcome });
      }
      const work = thread.work.get(turnId);
      if (work !== undefined && work.endedAt !== null) {
        rows.push({ type: 'receipt', turnId });
      }
    }
  }
  return rows;
};
