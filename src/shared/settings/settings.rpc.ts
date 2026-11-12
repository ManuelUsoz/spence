import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { AgentId } from '../agents/agents.rpc';

/** The Language Setting: `system` follows the OS languages (see `pickLocale` in main). */
export const Language = Schema.Literals(['system', 'en', 'es']).annotate({
  identifier: 'Language',
});
export type Language = typeof Language.Type;

/** The Theme Setting: `system` follows the OS appearance live. */
export const Theme = Schema.Literals(['system', 'light', 'dark']).annotate({ identifier: 'Theme' });
export type Theme = typeof Theme.Type;

export const SidebarLayout = Schema.Literals(['oneProject', 'allProjects']).annotate({
  identifier: 'SidebarLayout',
});
export type SidebarLayout = typeof SidebarLayout.Type;

export const ProjectOrder = Schema.Struct({
  by: Schema.Literals(['lastUsed', 'name']),
  direction: Schema.Literals(['asc', 'desc']),
}).annotate({ identifier: 'ProjectOrder' });
export type ProjectOrder = typeof ProjectOrder.Type;

export const PermissionMode = Schema.Literals(['auto', 'ask']).annotate({
  identifier: 'PermissionMode',
});
export type PermissionMode = typeof PermissionMode.Type;

export const Effort = Schema.Literals(['low', 'medium', 'high', 'max']).annotate({
  identifier: 'Effort',
});
export type Effort = typeof Effort.Type;

/** Days a Session may stay idle before it is archived; `null` is off. */
export const AutoArchiveDays = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
  identifier: 'AutoArchiveDays',
});
export type AutoArchiveDays = typeof AutoArchiveDays.Type;

/** The value Auto-archive takes when the user turns it on. */
export const AUTO_ARCHIVE_DAYS_ON = 30;

/** A Model as the Agent names it; `id` is what a pin stores. */
export const Model = Schema.Struct({ id: Schema.String, name: Schema.String }).annotate({
  identifier: 'Model',
});
export type Model = typeof Model.Type;

/** An Agent's default Model: what it last ran with, or a pinned Model id. */
export const ModelChoice = Schema.Union([Schema.Literal('lastUsed'), Schema.String]).annotate({
  identifier: 'ModelChoice',
});
export type ModelChoice = typeof ModelChoice.Type;

/** An Agent's default Effort: what it last ran with, or a pinned level. */
export const EffortChoice = Schema.Union([Schema.Literal('lastUsed'), Effort]).annotate({
  identifier: 'EffortChoice',
});
export type EffortChoice = typeof EffortChoice.Type;

/** One Agent's defaults as stored in `settings.json`. */
export const AgentDefaults = Schema.Struct({
  model: ModelChoice,
  effort: EffortChoice,
}).annotate({ identifier: 'AgentDefaults' });
export type AgentDefaults = typeof AgentDefaults.Type;

/** One Catalog Agent's Settings, resolved: its defaults plus the Models it offered last time it ran. */
export const AgentSettings = Schema.Struct({
  model: ModelChoice,
  effort: EffortChoice,
  /** Empty when the Agent never ran. */
  models: Schema.Array(Model),
}).annotate({ identifier: 'AgentSettings' });
export type AgentSettings = typeof AgentSettings.Type;

/** Every Setting, fully resolved: defaults filled in, one entry per Catalog Agent. */
export const Settings = Schema.Struct({
  language: Language,
  theme: Theme,
  notifications: Schema.Boolean,
  sidebarLayout: SidebarLayout,
  projectOrder: ProjectOrder,
  defaultPermissionMode: PermissionMode,
  autoArchiveDays: AutoArchiveDays,
  agents: Schema.Record(AgentId, AgentSettings),
}).annotate({ identifier: 'Settings' });
export type Settings = typeof Settings.Type;

/** A change to Settings: only the keys given change; `agents` changes per Agent and per key. */
export const SettingsPatch = Schema.Struct({
  language: Schema.optional(Language),
  theme: Schema.optional(Theme),
  notifications: Schema.optional(Schema.Boolean),
  sidebarLayout: Schema.optional(SidebarLayout),
  projectOrder: Schema.optional(ProjectOrder),
  defaultPermissionMode: Schema.optional(PermissionMode),
  autoArchiveDays: Schema.optional(AutoArchiveDays),
  agents: Schema.optional(
    Schema.Record(
      AgentId,
      Schema.Struct({ model: Schema.optional(ModelChoice), effort: Schema.optional(EffortChoice) }),
    ),
  ),
}).annotate({ identifier: 'SettingsPatch' });
export type SettingsPatch = typeof SettingsPatch.Type;

/** `NewerVersion`: `settings.json` was written by a newer Spence; it is never overwritten. */
export class SettingsError extends Schema.TaggedError<SettingsError>()('SettingsError', {
  reason: Schema.Literals(['NewerVersion']),
  detail: Schema.String,
}) {}

export const SettingsRpcs = RpcGroup.make(
  Rpc.make('Settings.get', { success: Settings }),
  Rpc.make('Settings.update', {
    payload: { patch: SettingsPatch },
    success: Settings,
    error: SettingsError,
  }),
);
