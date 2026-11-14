import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { AgentId, Effort, Model } from '../agents/agents.rpc';
import { PermissionMode } from '../projects/projects.rpc';

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

/** Days a Session may stay idle before it is archived; `null` is off. */
export const AutoArchiveDays = Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
  identifier: 'AutoArchiveDays',
});
export type AutoArchiveDays = typeof AutoArchiveDays.Type;

/** The value Auto-archive takes when the user turns it on. */
export const AUTO_ARCHIVE_DAYS_ON = 30;

/**
 * An Agent's default Model for new Sessions: `'lastUsed'` (what it last ran with), or a pinned Model id. A plain
 * string, not a union of `'lastUsed'` and string: the binary wire format cannot tell such union members apart.
 */
export const ModelDefault = Schema.String.annotate({
  identifier: 'ModelDefault',
});
export type ModelDefault = typeof ModelDefault.Type;

/**
 * Default Agent for new Sessions: `'lastUsed'` (the Agent a Turn last started with), or a pinned `AgentId`. A plain
 * string, not a union of `'lastUsed'` and string: the binary wire format cannot tell such union members apart.
 */
export const AgentDefault = Schema.String.annotate({
  identifier: 'AgentDefault',
});
export type AgentDefault = typeof AgentDefault.Type;

/** An Agent's default Effort for new Sessions: what it last ran with, or a pinned level. */
export const EffortDefault = Schema.Union([Schema.Literal('lastUsed'), Effort]).annotate({
  identifier: 'EffortDefault',
});
export type EffortDefault = typeof EffortDefault.Type;

/** One Agent's defaults as stored in `settings.json`. */
export const AgentDefaults = Schema.Struct({
  model: ModelDefault,
  effort: EffortDefault,
}).annotate({ identifier: 'AgentDefaults' });
export type AgentDefaults = typeof AgentDefaults.Type;

/** One Catalog Agent's Settings, resolved: its defaults plus the Models it offered last time it ran. */
export const AgentSettings = Schema.Struct({
  model: ModelDefault,
  effort: EffortDefault,
  /** The Models it offered last time it ran; empty when it never ran (or offered none). */
  models: Schema.Array(Model),
  /** Whether the Agent has run in Spence. One never run can only use Last used (spec §8). */
  ran: Schema.Boolean,
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
  defaultAgent: AgentDefault,
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
  defaultAgent: Schema.optional(AgentDefault),
  autoArchiveDays: Schema.optional(AutoArchiveDays),
  agents: Schema.optional(
    Schema.Record(
      AgentId,
      Schema.Struct({
        model: Schema.optional(ModelDefault),
        effort: Schema.optional(EffortDefault),
      }),
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
