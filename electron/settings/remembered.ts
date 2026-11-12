import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { AgentId, Effort, Model } from '../../src/shared/agents/agents.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { Store, type VersionedFile } from '../store/store';

/** What Spence remembers about one Agent. Never shown as a Setting. */
export const AgentMemory = Schema.Struct({
  lastModel: Schema.optional(Schema.String),
  lastEffort: Schema.optional(Effort),
  /** The Models the Agent offered last time it ran, so pins work without starting it. */
  models: Schema.optional(Schema.Array(Model)),
});
export type AgentMemory = typeof AgentMemory.Type;

/** The Sessions open in Tabs, in strip order, and the active one: restored at the next launch. */
export const OpenTabs = Schema.Struct({
  open: Schema.Array(SessionId),
  active: Schema.optional(SessionId),
});
export type OpenTabs = typeof OpenTabs.Type;

const State = Schema.Struct({
  agents: Schema.Record(AgentId, AgentMemory),
  tabs: Schema.optional(OpenTabs),
});
type State = typeof State.Type;

/** `<userData>/spence/state.json`. */
export const StateFile: VersionedFile<State> = {
  file: 'state.json',
  version: 1,
  migrations: [],
  schema: State,
  initial: () => ({ agents: {} }),
};

export interface RememberedShape {
  /** What is remembered about an Agent; empty when nothing is, or `state.json` cannot be read. */
  readonly get: (agentId: AgentId) => Effect.Effect<AgentMemory>;
  /** Remembers the Model and Effort an Agent last ran with. */
  readonly rememberLast: (
    agentId: AgentId,
    last: { readonly model?: string; readonly effort?: Effort },
  ) => Effect.Effect<void>;
  /** Remembers the Models an Agent offers. */
  readonly rememberModels: (agentId: AgentId, models: ReadonlyArray<Model>) => Effect.Effect<void>;
  /** The Tabs open when Spence last ran; none when nothing is remembered. */
  readonly tabs: Effect.Effect<OpenTabs>;
  readonly rememberTabs: (tabs: OpenTabs) => Effect.Effect<void>;
}

/** What Spence merely remembers (`state.json`), as opposed to Settings. Main only. */
export class Remembered extends Context.Service<Remembered, RememberedShape>()(
  'settings/Remembered',
) {}

export const layerRemembered = Layer.effect(
  Remembered,
  Effect.gen(function* () {
    const store = yield* Store;
    // Windows cannot replace state.json while another read has it open; guard reads and updates together.
    const lock = yield* Semaphore.make(1);

    // An unreadable or newer state.json is only a memory: read it as empty and never overwrite it.
    const read = store
      .readVersioned(StateFile)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`state.json: ${error.detail}`).pipe(Effect.as(undefined)),
        ),
      );

    const update = (f: (state: State) => State) =>
      Effect.gen(function* () {
        const state = yield* read;
        if (state === undefined) return;
        yield* store.writeVersioned(StateFile, f(state));
      }).pipe(Semaphore.withPermit(lock));

    const change = (agentId: AgentId, f: (memory: AgentMemory) => AgentMemory) =>
      update((state) => ({
        ...state,
        agents: { ...state.agents, [agentId]: f(state.agents[agentId] ?? {}) },
      }));

    return {
      tabs: read.pipe(
        Semaphore.withPermit(lock),
        Effect.map((state) => state?.tabs ?? { open: [] }),
      ),
      rememberTabs: (tabs) => update((state) => ({ ...state, tabs })),
      get: (agentId) =>
        read.pipe(
          Semaphore.withPermit(lock),
          Effect.map((state) => state?.agents[agentId] ?? {}),
        ),
      rememberLast: (agentId, { model, effort }) =>
        change(agentId, (memory) => ({
          ...memory,
          ...(model === undefined ? {} : { lastModel: model }),
          ...(effort === undefined ? {} : { lastEffort: effort }),
        })),
      rememberModels: (agentId, models) => change(agentId, (memory) => ({ ...memory, models })),
    };
  }),
);
