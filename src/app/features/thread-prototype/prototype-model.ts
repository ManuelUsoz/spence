// PROTOTYPE (throwaway, branch prototype/calm-thread): the calm thread, issue #12.
// Shapes mirror the `sessions` contract decided in "Session contract the renderer sees" (#7),
// already folded by main into whole items. Nothing here talks to main.

export type StepKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export type Part =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'link';
      readonly uri: string;
      readonly name: string;
      readonly title?: string;
      readonly size?: number;
    }
  | { readonly kind: 'image'; readonly mimeType: string; readonly name: string }
  | { readonly kind: 'audio'; readonly mimeType: string; readonly seconds: number }
  | {
      readonly kind: 'resource';
      readonly uri: string;
      readonly mimeType?: string;
      readonly text: string;
    };

export interface DiffLine {
  readonly op: ' ' | '+' | '-';
  readonly text: string;
}
export interface Diff {
  readonly path: string;
  readonly isNew: boolean;
  readonly lines: readonly DiffLine[];
}

export interface PermissionOption {
  readonly id: string;
  readonly label: string;
  readonly kind: 'allowOnce' | 'allowAlways' | 'rejectOnce' | 'rejectAlways';
}

export type PlanStatus = 'pending' | 'inProgress' | 'completed';

export type Entry =
  | {
      readonly type: 'message';
      readonly id: string;
      readonly turnId: string;
      readonly role: 'user' | 'agent';
      readonly parts: readonly Part[];
    }
  | {
      readonly type: 'thought';
      readonly id: string;
      readonly turnId: string;
      readonly text: string;
      readonly done: boolean;
      readonly startedAt: number;
      readonly endedAt?: number;
    }
  | {
      readonly type: 'step';
      readonly id: string;
      readonly turnId: string;
      readonly title: string;
      readonly kind: StepKind;
      readonly status: StepStatus;
      readonly files: readonly string[];
      readonly diffs: readonly Diff[];
      readonly output?: string;
      /** Answered by main under Auto (`by: policy`): folded into the Step, never its own item. */
      readonly allowedBy?: 'policy' | 'user';
      readonly rejected?: boolean;
    }
  | {
      readonly type: 'plan';
      readonly id: string;
      readonly turnId: string;
      readonly entries: readonly { readonly content: string; readonly status: PlanStatus }[];
    }
  | {
      readonly type: 'permission';
      readonly id: string;
      readonly turnId: string;
      readonly stepId: string;
      readonly options: readonly PermissionOption[];
      readonly state:
        | { readonly kind: 'pending' }
        | { readonly kind: 'answered'; readonly optionId: string }
        | { readonly kind: 'cancelled' };
    }
  | {
      readonly type: 'compaction';
      readonly id: string;
      readonly turnId?: string;
      readonly status: 'running' | 'done' | 'failed' | 'cancelled';
      readonly summary: string;
    }
  | {
      readonly type: 'notice';
      readonly id: string;
      readonly turnId?: string;
      readonly severity: 'info' | 'warning' | 'error';
      readonly title: string;
      readonly description?: string;
    }
  | { readonly type: 'cleared'; readonly id: string; readonly reason: 'user' | 'lost' };

export type TurnOutcome =
  | { readonly kind: 'done' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'cutShort'; readonly limit: 'maxTokens' | 'maxTurnRequests' }
  | {
      readonly kind: 'failed';
      readonly reason: 'agentStopped' | 'agentError';
      readonly detail: string;
      readonly stderrTail?: string;
    };

export interface Turn {
  readonly id: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outcome?: TurnOutcome;
}

export type AgentStatus =
  | 'ready'
  | 'starting'
  | 'notInstalled'
  | 'installing'
  | 'needsLogin'
  | 'loggingIn'
  | 'cantStart'
  | 'stopped';

export interface ThreadState {
  readonly title: string;
  readonly agent: AgentStatus;
  readonly agentDetail?: string;
  readonly turns: readonly Turn[];
  readonly entries: readonly Entry[];
  /** Text a failed Message returned to the composer. */
  readonly composerDraft: string;
}

export const emptyThread: ThreadState = {
  title: 'New session',
  agent: 'ready',
  turns: [],
  entries: [],
  composerDraft: '',
};

/** A Turn with its entries, in transcript order, as every variant reads it. */
export interface TurnBlock {
  readonly kind: 'turn';
  readonly turn: Turn;
  readonly user?: Extract<Entry, { type: 'message' }>;
  readonly entries: readonly Entry[];
}
export interface LooseBlock {
  readonly kind: 'loose';
  readonly entry: Entry;
}
export type Block = TurnBlock | LooseBlock;

export function toBlocks(state: ThreadState): readonly Block[] {
  const blocks: Block[] = [];
  const byTurn = new Map<string, { user?: Extract<Entry, { type: 'message' }>; entries: Entry[] }>();
  for (const turn of state.turns) byTurn.set(turn.id, { entries: [] });
  const order: (string | Entry)[] = [];
  for (const entry of state.entries) {
    const turnId = 'turnId' in entry ? entry.turnId : undefined;
    const bucket = turnId === undefined ? undefined : byTurn.get(turnId);
    if (turnId === undefined || bucket === undefined) {
      order.push(entry);
      continue;
    }
    if (!order.includes(turnId)) order.push(turnId);
    if (entry.type === 'message' && entry.role === 'user') bucket.user = entry;
    else bucket.entries.push(entry);
  }
  for (const item of order) {
    if (typeof item !== 'string') {
      blocks.push({ kind: 'loose', entry: item });
      continue;
    }
    const turn = state.turns.find((t) => t.id === item);
    const bucket = byTurn.get(item);
    if (turn === undefined || bucket === undefined) continue;
    blocks.push({ kind: 'turn', turn, user: bucket.user, entries: bucket.entries });
  }
  return blocks;
}

// ---- small view helpers shared by every variant (vocabulary, not layout) ----

export type StepEntry = Extract<Entry, { type: 'step' }>;
export type PlanEntry = Extract<Entry, { type: 'plan' }>;
export type PermissionEntry = Extract<Entry, { type: 'permission' }>;
export type ThoughtEntry = Extract<Entry, { type: 'thought' }>;
export type MessageEntry = Extract<Entry, { type: 'message' }>;

export const verbs: Record<StepKind, { live: string; past: string }> = {
  read: { live: 'Reading', past: 'Read' },
  edit: { live: 'Editing', past: 'Edited' },
  delete: { live: 'Deleting', past: 'Deleted' },
  move: { live: 'Moving', past: 'Moved' },
  search: { live: 'Searching', past: 'Searched' },
  execute: { live: 'Running', past: 'Ran' },
  fetch: { live: 'Fetching', past: 'Fetched' },
  other: { live: 'Working', past: 'Did' },
};

export function stepsOf(entries: readonly Entry[]): readonly StepEntry[] {
  return entries.filter((e): e is StepEntry => e.type === 'step');
}
export function planOf(entries: readonly Entry[]): PlanEntry | undefined {
  return entries.find((e): e is PlanEntry => e.type === 'plan');
}
export function pendingPermission(entries: readonly Entry[]): PermissionEntry | undefined {
  return entries.find(
    (e): e is PermissionEntry => e.type === 'permission' && e.state.kind === 'pending',
  );
}
export function changedFiles(steps: readonly StepEntry[]): readonly Diff[] {
  const map = new Map<string, Diff>();
  for (const s of steps) for (const d of s.diffs) map.set(d.path, d);
  return [...map.values()];
}
export function diffStat(d: Diff): { add: number; del: number } {
  return {
    add: d.lines.filter((l) => l.op === '+').length,
    del: d.lines.filter((l) => l.op === '-').length,
  };
}
export function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}
/** "5 steps · 2 files changed" — the folded line every variant can fall back on. */
export function foldSummary(steps: readonly StepEntry[]): string {
  const files = changedFiles(steps);
  const n = steps.length;
  const parts = [`${n} ${n === 1 ? 'step' : 'steps'}`];
  if (files.length > 0) {
    const created = files.filter((f) => f.isNew).length;
    if (created === files.length)
      parts.push(`${created} new ${created === 1 ? 'file' : 'files'}`);
    else parts.push(`${files.length} ${files.length === 1 ? 'file' : 'files'} changed`);
  }
  const failed = steps.filter((s) => s.status === 'failed').length;
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}
export function elapsed(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export function outcomeLine(o: TurnOutcome): string {
  switch (o.kind) {
    case 'done':
      return 'Done';
    case 'cancelled':
      return 'Stopped';
    case 'refused':
      return 'The Agent declined to continue';
    case 'cutShort':
      return o.limit === 'maxTokens'
        ? 'Cut short: the reply hit the Model’s length limit'
        : 'Cut short: the Agent hit its limit of requests for one Turn';
    case 'failed':
      return o.reason === 'agentStopped' ? 'The Agent stopped unexpectedly' : 'The Agent reported an error';
  }
}
