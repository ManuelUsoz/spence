import { Context, Effect, Layer, PubSub, Schema, Semaphore, Stream } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import {
  AgentDefault,
  AgentDefaults,
  AutoArchiveDays,
  ChatBackgroundMode,
  CrossProjectAccess,
  CoordinatorSettings,
  CustomWallpaper,
  DEFAULT_WALLPAPER_ID,
  DivideAndConquerSettings,
  FontPreset,
  Language,
  ProjectOrder,
  SendMode,
  SettingsError,
  SubagentMode,
  Theme,
  type ExecutionSettings,
  type Settings as SettingsValue,
  type SettingsPatch,
} from '../../src/shared/settings/settings.rpc';
import { PermissionMode } from '../../src/shared/projects/projects.rpc';
import { catalog } from '../agents/catalog';
import { Store, type LenientFile } from '../store/store';
import { Remembered } from './remembered';

type Stored = Omit<SettingsValue, 'agents'> & {
  readonly agents: Readonly<Record<AgentId, AgentDefaults>>;
};

const AGENT_DEFAULTS: AgentDefaults = { model: 'lastUsed', effort: 'lastUsed' };

/** `<userData>/spence/settings.json`: sparse, decoded key by key. */
export const SettingsFile: LenientFile<Stored> = {
  file: 'settings.json',
  version: 1,
  migrations: [],
  fields: {
    coordinator: Schema.optional(CoordinatorSettings),
    divideAndConquer: Schema.optional(DivideAndConquerSettings),
    language: Language,
    theme: Theme,
    fontPreset: Schema.optional(FontPreset),
    chatBackgroundMode: Schema.optional(ChatBackgroundMode),
    chatBackgroundId: Schema.optional(Schema.String),
    customWallpapers: Schema.optional(Schema.Array(CustomWallpaper)),
    notifications: Schema.Boolean,
    sendMode: SendMode,
    projectOrder: ProjectOrder,
    defaultPermissionMode: PermissionMode,
    defaultAgent: AgentDefault,
    autoArchiveDays: AutoArchiveDays,
    subagents: SubagentMode,
    crossProjectAccess: Schema.Array(CrossProjectAccess),
    browserAllowedOrigins: Schema.Array(Schema.String),
    agents: Schema.Record(AgentId, AgentDefaults),
  },
  defaults: {
    coordinator: {},
    divideAndConquer: {},
    language: 'system',
    theme: 'system',
    fontPreset: 'goeist',
    chatBackgroundMode: 'solid',
    chatBackgroundId: DEFAULT_WALLPAPER_ID,
    customWallpapers: [],
    notifications: true,
    sendMode: 'queue',
    projectOrder: { by: 'lastUsed', direction: 'desc' },
    defaultPermissionMode: 'auto',
    defaultAgent: 'claude',
    autoArchiveDays: null,
    subagents: 'workers',
    crossProjectAccess: [],
    browserAllowedOrigins: [],
    agents: {},
  },
};

/** The two Settings that act on the window. Production sets the native theme and reloads into a locale. */
export class WindowSettings extends Context.Service<
  WindowSettings,
  {
    readonly applyTheme: (theme: Theme) => Effect.Effect<void>;
    readonly applyLanguage: (language: Language) => Effect.Effect<void>;
  }
>()('settings/WindowSettings') {}

export interface SettingsShape {
  /** Every Setting, resolved: defaults filled in, one entry per Catalog Agent with its remembered Models. */
  readonly get: Effect.Effect<SettingsValue>;
  /** Stores the change, applies a changed Theme or Language to the window, and returns the new Settings. */
  readonly update: (patch: SettingsPatch) => Effect.Effect<SettingsValue, SettingsError>;
  /** Current Settings followed by every resolved update. */
  readonly changes: Stream.Stream<SettingsValue>;
}

/** The user's Settings. Main services read them here directly; the renderer through `Settings.get`. */
export class Settings extends Context.Service<Settings, SettingsShape>()('settings/Settings') {}

const normalizeBinaryPath = (value: string | null | undefined): string | undefined => {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const applyPatch = (
  stored: Stored,
  { agents, coordinator, divideAndConquer, ...rest }: SettingsPatch,
): Stored => {
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const merged = Object.entries(agents ?? {}).reduce<Record<AgentId, AgentDefaults>>(
    (acc, [id, change]) => {
      const agentId = AgentId.make(id);
      const current = acc[agentId] ?? AGENT_DEFAULTS;
      const model = change.model ?? current.model;
      const effort = change.effort ?? current.effort;
      const binaryPath =
        change.binaryPath === undefined
          ? normalizeBinaryPath(current.binaryPath)
          : normalizeBinaryPath(change.binaryPath);
      if (
        model === AGENT_DEFAULTS.model &&
        effort === AGENT_DEFAULTS.effort &&
        binaryPath === undefined
      ) {
        const restAgents = { ...acc };
        delete restAgents[agentId];
        return restAgents;
      }
      const next: AgentDefaults = {
        model,
        effort,
        ...(binaryPath === undefined ? {} : { binaryPath }),
      };
      return { ...acc, [agentId]: next };
    },
    { ...stored.agents },
  );
  return {
    ...stored,
    ...defined,
    agents: merged,
    ...(divideAndConquer === undefined
      ? {}
      : { divideAndConquer: { ...stored.divideAndConquer, ...divideAndConquer } }),
    ...(coordinator === undefined
      ? {}
      : { coordinator: { ...stored.coordinator, ...coordinator } }),
  };
};

export const layerSettings = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const store = yield* Store;
    const remembered = yield* Remembered;
    const window = yield* WindowSettings;
    const lock = yield* Semaphore.make(1);
    const changed = yield* PubSub.unbounded<SettingsValue>();

    const resolve = (stored: Stored) =>
      Effect.forEach(catalog, ({ id }) =>
        remembered.get(id).pipe(
          Effect.map((memory) => {
            const storedAgent = stored.agents[id] ?? AGENT_DEFAULTS;
            const binaryPath = normalizeBinaryPath(storedAgent.binaryPath);
            // An Agent that ran remembered the Models it offered, even none.
            const ran = memory.models !== undefined;
            return [
              id,
              {
                model: storedAgent.model,
                effort: storedAgent.effort,
                models: memory.models ?? [],
                ran,
                ...(binaryPath === undefined ? {} : { binaryPath }),
              },
            ] as const;
          }),
        ),
      ).pipe(
        Effect.map((agents): SettingsValue => ({ ...stored, agents: Object.fromEntries(agents) })),
      );

    const get = store.readLenient(SettingsFile).pipe(Effect.flatMap(resolve));

    const update = (patch: SettingsPatch) =>
      Effect.gen(function* () {
        const before = yield* store.readLenient(SettingsFile);
        const after = applyPatch(before, patch);
        yield* store
          .writeLenient(SettingsFile, after)
          .pipe(
            Effect.mapError(
              (error) => new SettingsError({ reason: 'NewerVersion', detail: error.detail }),
            ),
          );
        if (after.theme !== before.theme) yield* window.applyTheme(after.theme);
        if (after.language !== before.language) yield* window.applyLanguage(after.language);
        const resolved = yield* resolve(after);
        yield* PubSub.publish(changed, resolved);
        return resolved;
      }).pipe(Semaphore.withPermit(lock));

    const changes: Stream.Stream<SettingsValue> = Stream.unwrap(
      Effect.gen(function* () {
        const sub = yield* PubSub.subscribe(changed);
        const initial = yield* get.pipe(Effect.orDie);
        return Stream.concat(Stream.make(initial), Stream.fromSubscription(sub));
      }),
    );

    return { get, update, changes };
  }),
);

/** The execution Settings within `settings`: what a Paired device may read and change here. */
export const executionOf = ({
  defaultPermissionMode,
  defaultAgent,
  autoArchiveDays,
  subagents,
  agents,
}: SettingsValue): ExecutionSettings => ({
  defaultPermissionMode,
  defaultAgent,
  autoArchiveDays,
  subagents,
  agents,
});
