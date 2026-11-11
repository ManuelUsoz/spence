// PROTOTYPE (throwaway, branch prototype/calm-thread): plays a scripted Session as if main were folding
// real ACP traffic. Timers only, no persistence, no RPC.
import { Injectable, computed, signal } from '@angular/core';
import type {
  AgentStatus,
  Entry,
  Part,
  StepEntry,
  ThreadState,
  TurnOutcome,
} from './prototype-model';
import { emptyThread, toBlocks } from './prototype-model';

export type Reducer = (s: ThreadState) => ThreadState;
export type Beat =
  | { readonly wait: number; readonly run: Reducer }
  | {
      readonly ask: string;
      readonly onAllow: readonly Beat[];
      readonly onReject: readonly Beat[];
    };

export interface Scenario {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** Applied instantly: earlier Turns already in the transcript. */
  readonly history: Reducer;
  readonly script: readonly Beat[];
  /** What the Agent bar's buttons do in this scenario. */
  readonly agentActions?: Partial<Record<'install' | 'login' | 'retry', readonly Beat[]>>;
}

// ---- reducers ----

export const r = {
  title:
    (title: string): Reducer =>
    (s) => ({ ...s, title }),
  agent:
    (agent: AgentStatus, agentDetail?: string): Reducer =>
    (s) => ({ ...s, agent, agentDetail }),
  draft:
    (composerDraft: string): Reducer =>
    (s) => ({ ...s, composerDraft }),
  startTurn:
    (turnId: string, user: readonly Part[], ago = 0): Reducer =>
    (s) => ({
      ...s,
      turns: [...s.turns, { id: turnId, startedAt: Date.now() - ago }],
      entries: [
        ...s.entries,
        { type: 'message', id: `${turnId}-u`, turnId, role: 'user', parts: user },
      ],
    }),
  endTurn:
    (turnId: string, outcome: TurnOutcome, ago = 0): Reducer =>
    (s) => ({
      ...s,
      turns: s.turns.map((t) => (t.id === turnId ? { ...t, endedAt: Date.now() - ago, outcome } : t)),
      entries: s.entries.map((e) => {
        if (!('turnId' in e) || e.turnId !== turnId) return e;
        if (e.type === 'step' && (e.status === 'running' || e.status === 'pending'))
          return { ...e, status: 'cancelled' as const };
        if (e.type === 'permission' && e.state.kind === 'pending')
          return { ...e, state: { kind: 'cancelled' as const } };
        if (e.type === 'thought' && !e.done) return { ...e, done: true, endedAt: Date.now() };
        return e;
      }),
    }),
  add:
    (entry: Entry): Reducer =>
    (s) => ({ ...s, entries: [...s.entries, entry] }),
  patch:
    (id: string, fn: (e: Entry) => Entry): Reducer =>
    (s) => ({ ...s, entries: s.entries.map((e) => (e.id === id ? fn(e) : e)) }),
  step:
    (id: string, patch: Partial<Omit<StepEntry, 'type' | 'id' | 'turnId'>>): Reducer =>
    (s) => ({
      ...s,
      entries: s.entries.map((e) => (e.id === id && e.type === 'step' ? { ...e, ...patch } : e)),
    }),
  appendText:
    (id: string, delta: string): Reducer =>
    (s) => ({
      ...s,
      entries: s.entries.map((e) => {
        if (e.id !== id) return e;
        if (e.type === 'thought') return { ...e, text: e.text + delta };
        if (e.type !== 'message') return e;
        const last = e.parts.at(-1);
        if (last?.kind === 'text')
          return { ...e, parts: [...e.parts.slice(0, -1), { kind: 'text' as const, text: last.text + delta }] };
        return { ...e, parts: [...e.parts, { kind: 'text' as const, text: delta }] };
      }),
    }),
  thoughtDone:
    (id: string): Reducer =>
    (s) => ({
      ...s,
      entries: s.entries.map((e) =>
        e.id === id && e.type === 'thought' ? { ...e, done: true, endedAt: Date.now() } : e,
      ),
    }),
  all:
    (...rs: Reducer[]): Reducer =>
    (s) =>
      rs.reduce((acc, f) => f(acc), s),
};

/** Splits text into word-ish chunks so it streams as deltas. */
export function stream(id: string, text: string, ms = 70): Beat[] {
  const chunks = text.match(/\S+\s*/g) ?? [text];
  const beats: Beat[] = [];
  for (let i = 0; i < chunks.length; i += 2) {
    beats.push({ wait: ms, run: r.appendText(id, chunks.slice(i, i + 2).join('')) });
  }
  return beats;
}

@Injectable()
export class ThreadPlayer {
  private readonly _state = signal<ThreadState>(emptyThread);
  private queue: Beat[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waitingFor: Extract<Beat, { ask: string }> | undefined;
  private scenario: Scenario | undefined;
  private followUps = 0;
  readonly speed = signal(1);
  /** Ticks every second while a Turn runs, so elapsed times move. */
  readonly now = signal(Date.now());
  private readonly clock = setInterval(() => this.now.set(Date.now()), 1000);

  readonly state = this._state.asReadonly();
  readonly blocks = computed(() => toBlocks(this._state()));
  readonly runningTurn = computed(() => this._state().turns.find((t) => t.outcome === undefined));
  readonly waiting = computed(() =>
    this._state().entries.some((e) => e.type === 'permission' && e.state.kind === 'pending'),
  );

  load(scenario: Scenario): void {
    this.halt();
    this.scenario = scenario;
    this.followUps = 0;
    this._state.set(scenario.history(emptyThread));
    this.queue = [...scenario.script];
    this.tick();
  }

  replay(): void {
    if (this.scenario) this.load(this.scenario);
  }

  answer(permissionId: string, optionId: string): void {
    const ask = this.waitingFor;
    const perm = this._state().entries.find((e) => e.id === permissionId);
    if (perm?.type !== 'permission' || perm.state.kind !== 'pending') return;
    const option = perm.options.find((o) => o.id === optionId);
    const allowed = option?.kind === 'allowOnce' || option?.kind === 'allowAlways';
    this.apply(
      r.all(
        r.patch(permissionId, (e) =>
          e.type === 'permission' ? { ...e, state: { kind: 'answered', optionId } } : e,
        ),
        allowed
          ? r.step(perm.stepId, { status: 'running', allowedBy: 'user' })
          : r.step(perm.stepId, { status: 'failed', rejected: true }),
      ),
    );
    if (ask?.ask === permissionId) {
      this.waitingFor = undefined;
      this.queue = [...(allowed ? ask.onAllow : ask.onReject), ...this.queue];
      this.tick();
    }
  }

  /** The composer's Stop: `Session.cancel`. Main cancels unfinished Steps and pending requests. */
  cancel(): void {
    const turn = this.runningTurn();
    if (!turn) return;
    this.halt();
    this.apply(r.endTurn(turn.id, { kind: 'cancelled' }));
  }

  agentAction(action: 'install' | 'login' | 'retry'): void {
    const beats = this.scenario?.agentActions?.[action];
    if (!beats) return;
    this.halt();
    this.queue = [...beats];
    this.tick();
  }

  /** Sending from the composer: a short canned Turn so the flow can be driven by hand. */
  send(text: string): void {
    if (this.runningTurn() || text.trim() === '') return;
    const id = `f${++this.followUps}`;
    const msg = `${id}-a`;
    this.halt();
    this.queue = [
      { wait: 0, run: r.all(r.draft(''), r.agent('ready'), r.startTurn(id, [{ kind: 'text', text }])) },
      {
        wait: 500,
        run: r.add({ type: 'step', id: `${id}-s1`, turnId: id, title: 'src/app/app.routes.ts', kind: 'read', status: 'running', files: ['src/app/app.routes.ts'], diffs: [] }),
      },
      { wait: 900, run: r.step(`${id}-s1`, { status: 'done' }) },
      { wait: 200, run: r.add({ type: 'message', id: msg, turnId: id, role: 'agent', parts: [] }) },
      ...stream(msg, 'Sure. I looked at the routes; nothing else needs to change for that.'),
      { wait: 200, run: r.endTurn(id, { kind: 'done' }) },
    ];
    this.tick();
  }

  destroy(): void {
    this.halt();
    clearInterval(this.clock);
  }

  private apply(f: Reducer): void {
    this._state.update(f);
  }

  private halt(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.waitingFor = undefined;
  }

  private tick(): void {
    if (this.timer !== undefined || this.waitingFor) return;
    const next = this.queue.shift();
    if (!next) return;
    if ('ask' in next) {
      this.waitingFor = next;
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.apply(next.run);
        this.tick();
      },
      next.wait / this.speed(),
    );
  }
}
