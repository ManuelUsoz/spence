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

interface RawV2Panel {
  readonly id?: unknown;
  readonly spec?: {
    readonly _tag?: unknown;
    readonly sessionId?: unknown;
    readonly draft?: unknown;
  };
  readonly collapsed?: unknown;
}

interface RawV2Node {
  readonly _tag?: unknown;
  readonly id?: unknown;
  readonly first?: unknown;
  readonly second?: unknown;
  readonly panels?: ReadonlyArray<RawV2Panel>;
  readonly [key: string]: unknown;
}

interface RawV2Tab {
  readonly id?: unknown;
  readonly focusedPanelId?: unknown;
  readonly layout?: {
    readonly rootPaneId?: unknown;
    readonly nodes?: ReadonlyArray<RawV2Node>;
  };
  readonly [key: string]: unknown;
}

interface RawV2Project {
  readonly tabs?: ReadonlyArray<RawV2Tab>;
  readonly activeTabId?: unknown;
  readonly [key: string]: unknown;
}

const collapseRawLayout = (
  rootPaneId: unknown,
  nodes: ReadonlyArray<RawV2Node>,
): { readonly rootPaneId: string; readonly nodes: ReadonlyArray<RawV2Node> } | null => {
  if (typeof rootPaneId !== 'string') return null;
  const byId = new Map<string, RawV2Node>();
  for (const node of nodes) {
    if (typeof node.id === 'string') byId.set(node.id, node);
  }
  const visited = new Set<string>();
  const collected: Array<RawV2Node> = [];
  const visit = (id: string): string | null => {
    if (visited.has(id)) return null;
    visited.add(id);
    const node = byId.get(id);
    if (node === undefined) return null;
    if (node._tag === 'Leaf') {
      collected.push(node);
      return id;
    }
    if (
      node._tag === 'Split' &&
      typeof node.first === 'string' &&
      typeof node.second === 'string'
    ) {
      const first = visit(node.first);
      const second = visit(node.second);
      if (first === null && second === null) return null;
      if (first === null) return second;
      if (second === null) return first;
      collected.push({ ...node, first, second });
      return id;
    }
    return null;
  };
  const nextRoot = visit(rootPaneId);
  if (nextRoot === null) return null;
  return { rootPaneId: nextRoot, nodes: collected };
};

const isKeptV2Panel = (panel: RawV2Panel): boolean => {
  const tag = panel.spec?._tag;
  return tag !== 'Changes' && tag !== 'Workers';
};

const pickSurvivingPanel = (
  panels: ReadonlyArray<RawV2Panel>,
  focusedPanelId: unknown,
): RawV2Panel | undefined =>
  panels.find((p) => p.id === focusedPanelId && p.collapsed !== true) ??
  panels.find((p) => p.collapsed !== true) ??
  panels.find((p) => p.id === focusedPanelId) ??
  panels[0];

const migrateV2Workspace = (raw: unknown): unknown => {
  if (typeof raw !== 'object' || raw === null) return raw;
  const ws = raw as { readonly projects?: unknown; readonly [key: string]: unknown };
  if (!Array.isArray(ws.projects)) return raw;

  const projects = (ws.projects as ReadonlyArray<RawV2Project>).map((project) => {
    if (!Array.isArray(project.tabs)) return project;
    const usedTabIds = new Set(
      project.tabs.map((tab) => (typeof tab.id === 'string' ? tab.id : '')).filter(Boolean),
    );
    const seenSessions = new Set<string>();
    const nextTabs: Array<RawV2Tab> = [];
    const promotedTabs: Array<RawV2Tab> = [];

    for (const tab of project.tabs) {
      const nodes = tab.layout?.nodes;
      if (!Array.isArray(nodes)) {
        nextTabs.push(tab);
        continue;
      }
      const nextNodes: Array<RawV2Node> = [];
      const keptIds = new Set<string>();
      for (const node of nodes) {
        if (node._tag !== 'Leaf' || !Array.isArray(node.panels)) {
          nextNodes.push(node);
          continue;
        }
        const candidates = node.panels.filter((panel: RawV2Panel) => {
          if (!isKeptV2Panel(panel)) return false;
          const sid = panel.spec?.sessionId;
          return (
            panel.spec?._tag !== 'Session' || typeof sid !== 'string' || !seenSessions.has(sid)
          );
        });
        const primary = pickSurvivingPanel(candidates, tab.focusedPanelId);
        if (primary === undefined) continue;

        if (primary.spec?._tag === 'Session' && typeof primary.spec.sessionId === 'string') {
          seenSessions.add(primary.spec.sessionId);
        }
        if (typeof primary.id === 'string') keptIds.add(primary.id);

        for (const extra of candidates) {
          if (extra === primary) continue;
          const sid = extra.spec?.sessionId;
          if (
            extra.spec?._tag === 'Session' &&
            extra.spec.draft !== true &&
            typeof sid === 'string' &&
            !seenSessions.has(sid) &&
            typeof extra.id === 'string'
          ) {
            seenSessions.add(sid);
            let tabId = `migrated:${extra.id}`;
            let n = 1;
            while (usedTabIds.has(tabId)) {
              tabId = `migrated:${extra.id}:${n}`;
              n += 1;
            }
            usedTabIds.add(tabId);
            promotedTabs.push({
              id: tabId,
              focusedPanelId: extra.id,
              layout: {
                rootPaneId: `migrated-pane:${extra.id}`,
                nodes: [
                  {
                    _tag: 'Leaf',
                    id: `migrated-pane:${extra.id}`,
                    panels: [{ id: extra.id, spec: extra.spec }],
                  },
                ],
              },
            });
          }
        }

        nextNodes.push({
          ...node,
          panels: [{ id: primary.id, spec: primary.spec }],
        });
      }
      if (keptIds.size > 0) {
        const collapsed = collapseRawLayout(tab.layout?.rootPaneId, nextNodes);
        if (collapsed !== null) {
          const nextFocused =
            typeof tab.focusedPanelId === 'string' && keptIds.has(tab.focusedPanelId)
              ? tab.focusedPanelId
              : [...keptIds][0];
          nextTabs.push({
            ...tab,
            focusedPanelId: nextFocused,
            layout: collapsed,
          });
        }
      }
    }

    const tabs = [...nextTabs, ...promotedTabs];
    const activeValid = tabs.some((t) => t.id === project.activeTabId);
    const nextActiveTabId = activeValid ? project.activeTabId : tabs[0]?.id;
    return {
      ...project,
      tabs,
      ...(nextActiveTabId === undefined ? {} : { activeTabId: nextActiveTabId }),
    };
  });

  return {
    ...ws,
    projects: projects.filter((p) => !Array.isArray(p.tabs) || p.tabs.length > 0),
  };
};

/** Forward-only v2 -> v3 migration: drops Panel stacks (`collapsed`, `heightShare`) and promotes extra stacked Sessions into Tabs. */
export const migrateV2ToV3 = (body: unknown): unknown => {
  if (typeof body !== 'object' || body === null) return body;
  const typed = body as {
    readonly workspace?: unknown;
    readonly remoteWorkspace?: { readonly workspace?: unknown; readonly [key: string]: unknown };
    readonly [key: string]: unknown;
  };
  return {
    ...typed,
    ...(typed.workspace === undefined ? {} : { workspace: migrateV2Workspace(typed.workspace) }),
    ...(typed.remoteWorkspace === undefined
      ? {}
      : {
          remoteWorkspace: {
            ...typed.remoteWorkspace,
            ...(typed.remoteWorkspace.workspace === undefined
              ? {}
              : { workspace: migrateV2Workspace(typed.remoteWorkspace.workspace) }),
          },
        }),
  };
};

/** `<userData>/spence/state.json`. */
export const StateFile: VersionedFile<State> = {
  file: 'state.json',
  version: 3,
  migrations: [migrateV1ToV2, migrateV2ToV3],
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
