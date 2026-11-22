import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { AgentId, Effort, Model } from '../../src/shared/agents/agents.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { RestoredWorkspace, WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import { Store, type VersionedFile } from '../store/store';

/** What Spence remembers about one Agent. Never shown as a Setting. */
export const AgentMemory = Schema.Struct({
  lastModel: Schema.optional(Schema.String),
  lastEffort: Schema.optional(Effort),
  /** The Models the Agent offered last time it ran, so pins work without starting it. */
  models: Schema.optional(Schema.Array(Model)),
});
export type AgentMemory = typeof AgentMemory.Type;

/** Legacy v1 flat open-tab memory, kept once during v1 -> v2 migration for per-Project conversion. */
export const OpenTabs = Schema.Struct({
  open: Schema.Array(SessionId),
  active: Schema.optional(SessionId),
});
export type OpenTabs = typeof OpenTabs.Type;

const State = Schema.Struct({
  agents: Schema.Record(AgentId, AgentMemory),
  lastAgent: Schema.optional(AgentId),
  workspace: Schema.optional(WorkspaceState),
  legacyTabs: Schema.optional(OpenTabs),
  /** Remote Projects' Tab workspaces as stubs: never their Transcripts. */
  remoteWorkspace: Schema.optional(RestoredWorkspace),
});
type State = typeof State.Type;

/** Forward-only v1 -> v2 migration: moves flat legacy `tabs` into `legacyTabs` while keeping Agent memories intact. */
export const migrateV1ToV2 = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null) return body;
  const { tabs, ...rest } = body as { readonly tabs?: unknown; readonly [key: string]: unknown };
  return tabs === undefined ? rest : { ...rest, legacyTabs: tabs };
};

/** `<userData>/spence/state.json`. */
export const StateFile: VersionedFile<State> = {
  file: 'state.json',
  version: 2,
  migrations: [migrateV1ToV2],
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
  /** The per-Project Tab workspace remembered from the last run; undefined when nothing is remembered yet. */
  readonly workspace: Effect.Effect<WorkspaceState | undefined>;
  /** Legacy v1 open tabs awaiting one-time per-Project migration; undefined once migrated or absent. */
  readonly legacyTabs: Effect.Effect<OpenTabs | undefined>;
  /** Persists `workspace` and drops any remaining `legacyTabs`. */
  readonly rememberWorkspace: (workspace: WorkspaceState) => Effect.Effect<void>;
  /** The Remote Projects' Tab workspaces remembered from the last run; empty when none. */
  readonly remoteWorkspace: Effect.Effect<RestoredWorkspace>;
  readonly rememberRemoteWorkspace: (remote: RestoredWorkspace) => Effect.Effect<void>;
  /** The Agent that last ran a Turn; undefined when nothing is remembered. */
  readonly lastAgent: Effect.Effect<AgentId | undefined>;
  readonly rememberLastAgent: (agentId: AgentId) => Effect.Effect<void>;
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
      workspace: read.pipe(
        Semaphore.withPermit(lock),
        Effect.map((state) => state?.workspace),
      ),
      legacyTabs: read.pipe(
        Semaphore.withPermit(lock),
        Effect.map((state) => state?.legacyTabs),
      ),
      rememberWorkspace: (workspace) =>
        update(({ legacyTabs: _legacyTabs, ...state }) => ({ ...state, workspace })),
      remoteWorkspace: read.pipe(
        Semaphore.withPermit(lock),
        Effect.map(
          (state) => state?.remoteWorkspace ?? { workspace: { projects: [] }, sessions: [] },
        ),
      ),
      rememberRemoteWorkspace: (remoteWorkspace) =>
        update((state) => ({ ...state, remoteWorkspace })),
      lastAgent: read.pipe(
        Semaphore.withPermit(lock),
        Effect.map((state) => state?.lastAgent),
      ),
      rememberLastAgent: (agentId) => update((state) => ({ ...state, lastAgent: agentId })),
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
