import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { AgentId, Effort, Model } from '../../src/shared/agents/agents.rpc';
import { Store, type VersionedFile } from '../store/store';

/** What Spence remembers about one Agent. Never shown as a Setting. */
export const AgentMemory = Schema.Struct({
  lastModel: Schema.optional(Schema.String),
  lastEffort: Schema.optional(Effort),
  /** The Models the Agent offered last time it ran, so pins work without starting it. */
  models: Schema.optional(Schema.Array(Model)),
});
export type AgentMemory = typeof AgentMemory.Type;

const State = Schema.Struct({ agents: Schema.Record(AgentId, AgentMemory) });
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
}

/** What Spence merely remembers (`state.json`), as opposed to Settings. Main only. */
export class Remembered extends Context.Service<Remembered, RememberedShape>()(
  'settings/Remembered',
) {}

export const layerRemembered = Layer.effect(
  Remembered,
  Effect.gen(function* () {
    const store = yield* Store;
    const lock = yield* Semaphore.make(1);

    // An unreadable or newer state.json is only a memory: read it as empty and never overwrite it.
    const read = store
      .readVersioned(StateFile)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(`state.json: ${error.detail}`).pipe(Effect.as(undefined)),
        ),
      );

    const change = (agentId: AgentId, f: (memory: AgentMemory) => AgentMemory) =>
      Effect.gen(function* () {
        const state = yield* read;
        if (state === undefined) return;
        const memory = f(state.agents[agentId] ?? {});
        yield* store.writeVersioned(StateFile, { agents: { ...state.agents, [agentId]: memory } });
      }).pipe(Semaphore.withPermit(lock));

    return {
      get: (agentId) => read.pipe(Effect.map((state) => state?.agents[agentId] ?? {})),
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
