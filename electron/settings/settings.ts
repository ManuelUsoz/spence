import { Context, Effect, Layer, Schema, Semaphore } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import {
  AgentDefault,
  AgentDefaults,
  AutoArchiveDays,
  CrossProjectAccess,
  FILES_TREE_DEFAULT,
  FilesTreeWidth,
  Language,
  ProjectOrder,
  SettingsError,
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
    language: Language,
    theme: Theme,
    notifications: Schema.Boolean,
    projectOrder: ProjectOrder,
    filesTreeWidth: FilesTreeWidth,
    defaultPermissionMode: PermissionMode,
    defaultAgent: AgentDefault,
    autoArchiveDays: AutoArchiveDays,
    crossProjectAccess: Schema.Array(CrossProjectAccess),
    agents: Schema.Record(AgentId, AgentDefaults),
  },
  defaults: {
    language: 'system',
    theme: 'system',
    notifications: true,
    projectOrder: { by: 'lastUsed', direction: 'desc' },
    filesTreeWidth: FILES_TREE_DEFAULT,
    defaultPermissionMode: 'auto',
    defaultAgent: 'claude',
    autoArchiveDays: null,
    crossProjectAccess: [],
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
}

/** The user's Settings. Main services read them here directly; the renderer through `Settings.get`. */
export class Settings extends Context.Service<Settings, SettingsShape>()('settings/Settings') {}

const applyPatch = (stored: Stored, { agents, ...rest }: SettingsPatch): Stored => {
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const merged = Object.entries(agents ?? {}).reduce<Record<AgentId, AgentDefaults>>(
    (acc, [id, change]) => {
      const agentId = AgentId.make(id);
      const current = acc[agentId] ?? AGENT_DEFAULTS;
      const next: AgentDefaults = {
        model: change.model ?? current.model,
        effort: change.effort ?? current.effort,
      };
      return { ...acc, [agentId]: next };
    },
    { ...stored.agents },
  );
  return { ...stored, ...defined, agents: merged };
};

export const layerSettings = Layer.effect(
  Settings,
  Effect.gen(function* () {
    const store = yield* Store;
    const remembered = yield* Remembered;
    const window = yield* WindowSettings;
    const lock = yield* Semaphore.make(1);

    const resolve = (stored: Stored) =>
      Effect.forEach(catalog, ({ id }) =>
        remembered.get(id).pipe(
          Effect.map((memory) => {
            const { model, effort } = stored.agents[id] ?? AGENT_DEFAULTS;
            // An Agent that ran remembered the Models it offered, even none.
            const ran = memory.models !== undefined;
            return [id, { model, effort, models: memory.models ?? [], ran }] as const;
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
        return yield* resolve(after);
      }).pipe(Semaphore.withPermit(lock));

    return { get, update };
  }),
);

/** The execution Settings within `settings`: what a Paired device may read and change here. */
export const executionOf = ({
  defaultPermissionMode,
  defaultAgent,
  autoArchiveDays,
  agents,
}: SettingsValue): ExecutionSettings => ({
  defaultPermissionMode,
  defaultAgent,
  autoArchiveDays,
  agents,
});
