import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { AgentId, Effort, Model } from '../agents/agents.rpc';
import { PermissionMode, ProjectId, Timestamp } from '../projects/projects.rpc';

/** The Language Setting: `system` follows the OS languages (see `pickLocale` in main). */
export const Language = Schema.Literals(['system', 'en', 'es']).annotate({
  identifier: 'Language',
});
export type Language = typeof Language.Type;

/** The Theme Setting: `system` follows the OS appearance live. */
export const Theme = Schema.Literals(['system', 'light', 'dark']).annotate({ identifier: 'Theme' });
export type Theme = typeof Theme.Type;

/** The shared image defaults to the first imported wallpaper when no ID is selected. */
export const DEFAULT_WALLPAPER_ID = '';

/** How Session chat backgrounds are chosen: per-Session gallery rotation, one shared image, or solid theme color. */
export const ChatBackgroundMode = Schema.Literals(['different', 'same', 'solid']).annotate({
  identifier: 'ChatBackgroundMode',
});
export type ChatBackgroundMode = typeof ChatBackgroundMode.Type;

/** A user-imported Session wallpaper stored as base64 image data in Settings. */
export const CustomWallpaper = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  data: Schema.String,
}).annotate({ identifier: 'CustomWallpaper' });
export type CustomWallpaper = typeof CustomWallpaper.Type;

/**
 * What the Composer's send does while a Turn runs: `queue` lines the Message up for when the Turn ends, `steer`
 * sends it now into the running Turn. The default of the Composer's send mode chip.
 */
export const SendMode = Schema.Literals(['queue', 'steer']).annotate({ identifier: 'SendMode' });
export type SendMode = typeof SendMode.Type;

/**
 * Which subagents an Agent launches from a Session: 'workers' are Spence Workers (the `delegate` tool of the Spence
 * MCP server: their own writable Sessions), 'native' leaves the Agent its own subagent tool.
 */
export const SubagentMode = Schema.Literals(['workers', 'native']).annotate({
  identifier: 'SubagentMode',
});
export type SubagentMode = typeof SubagentMode.Type;

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

export const WorkflowTarget = Schema.Struct({ agentId: AgentId, model: Schema.String }).annotate({
  identifier: 'WorkflowTarget',
});
export type WorkflowTarget = typeof WorkflowTarget.Type;

export const CoordinatorSettings = Schema.Struct({
  coordinator: Schema.optional(WorkflowTarget),
  worker: Schema.optional(WorkflowTarget),
  verifier: Schema.optional(WorkflowTarget),
}).annotate({ identifier: 'CoordinatorSettings' });
export type CoordinatorSettings = typeof CoordinatorSettings.Type;
export const WorkflowKind = Schema.Literals(['coordinate', 'divide-and-conquer']).annotate({
  identifier: 'WorkflowKind',
});
export type WorkflowKind = typeof WorkflowKind.Type;
export const DivideAndConquerSettings = Schema.Struct({
  planner: Schema.optional(WorkflowTarget),
  taskBreaker: Schema.optional(WorkflowTarget),
  implementer: Schema.optional(WorkflowTarget),
  verifier: Schema.optional(WorkflowTarget),
}).annotate({ identifier: 'DivideAndConquerSettings' });
export type DivideAndConquerSettings = typeof DivideAndConquerSettings.Type;

/** One stored "Always allow": Sessions of `from` may message Sessions of `to`. Directional, per Project pair. */
export const CrossProjectAccess = Schema.Struct({
  from: ProjectId,
  to: ProjectId,
  addedAt: Timestamp,
}).annotate({ identifier: 'CrossProjectAccess' });
export type CrossProjectAccess = typeof CrossProjectAccess.Type;

/**
 * The Settings that belong to the Device a Session runs on (spec: execution defaults): what its new Sessions start
 * with and when its idle ones are archived. A Device edits a Paired device's through `ExecutionSettingsRpcs`.
 */
const executionFields = {
  defaultPermissionMode: PermissionMode,
  defaultAgent: AgentDefault,
  autoArchiveDays: AutoArchiveDays,
  subagents: SubagentMode,
  agents: Schema.Record(AgentId, AgentSettings),
};

/** One Device's execution Settings, resolved: defaults filled in, one entry per Catalog Agent. */
export const ExecutionSettings = Schema.Struct(executionFields).annotate({
  identifier: 'ExecutionSettings',
});
export type ExecutionSettings = typeof ExecutionSettings.Type;

/**
 * Every Setting, fully resolved: defaults filled in, one entry per Catalog Agent. Language, Theme, notifications,
 * Project order and the cross-Project allow-list are the viewing Device's own and never reach a Paired device.
 */
export const Settings = Schema.Struct({
  coordinator: Schema.optional(CoordinatorSettings),
  divideAndConquer: Schema.optional(DivideAndConquerSettings),
  language: Language,
  theme: Theme,
  chatBackgroundMode: Schema.optional(ChatBackgroundMode),
  chatBackgroundId: Schema.optional(Schema.String),
  customWallpapers: Schema.optional(Schema.Array(CustomWallpaper)),
  notifications: Schema.Boolean,
  sendMode: SendMode,
  projectOrder: ProjectOrder,
  /** The Project pairs the user allowed to message each other; empty by default (cross-Project is off). */
  crossProjectAccess: Schema.Array(CrossProjectAccess),
  /** External Browser origins the user always allowed Agents to access; empty by default. */
  browserAllowedOrigins: Schema.Array(Schema.String),
  ...executionFields,
}).annotate({ identifier: 'Settings' });
export type Settings = typeof Settings.Type;

const executionPatchFields = {
  defaultPermissionMode: Schema.optional(PermissionMode),
  defaultAgent: Schema.optional(AgentDefault),
  autoArchiveDays: Schema.optional(AutoArchiveDays),
  subagents: Schema.optional(SubagentMode),
  agents: Schema.optional(
    Schema.Record(
      AgentId,
      Schema.Struct({
        model: Schema.optional(ModelDefault),
        effort: Schema.optional(EffortDefault),
      }),
    ),
  ),
};

/** A change to execution Settings: only the keys given change; `agents` changes per Agent and per key. */
export const ExecutionSettingsPatch = Schema.Struct(executionPatchFields).annotate({
  identifier: 'ExecutionSettingsPatch',
});
export type ExecutionSettingsPatch = typeof ExecutionSettingsPatch.Type;

/** A change to Settings: only the keys given change; `agents` changes per Agent and per key. */
export const SettingsPatch = Schema.Struct({
  coordinator: Schema.optional(CoordinatorSettings),
  divideAndConquer: Schema.optional(DivideAndConquerSettings),
  language: Schema.optional(Language),
  theme: Schema.optional(Theme),
  chatBackgroundMode: Schema.optional(ChatBackgroundMode),
  chatBackgroundId: Schema.optional(Schema.String),
  customWallpapers: Schema.optional(Schema.Array(CustomWallpaper)),
  notifications: Schema.optional(Schema.Boolean),
  sendMode: Schema.optional(SendMode),
  projectOrder: Schema.optional(ProjectOrder),
  /** Replaces the whole allow-list. */
  crossProjectAccess: Schema.optional(Schema.Array(CrossProjectAccess)),
  /** Replaces the whole Browser origin allow-list. */
  browserAllowedOrigins: Schema.optional(Schema.Array(Schema.String)),
  ...executionPatchFields,
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

/**
 * The execution Settings of a Device, Device-scoped: the window edits a Paired device's by naming it, and the
 * Device serves them to its Paired devices. `SettingsRpcs` (with the UI preferences) stays Local.
 */
export const ExecutionSettingsRpcs = RpcGroup.make(
  Rpc.make('ExecutionSettings.get', { success: ExecutionSettings }),
  Rpc.make('ExecutionSettings.update', {
    payload: { patch: ExecutionSettingsPatch },
    success: ExecutionSettings,
    error: SettingsError,
  }),
);
