import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** Identifies a Catalog Agent; stored on every Session. */
export const AgentId = Schema.String.pipe(Schema.brand('AgentId')).annotate({
  identifier: 'AgentId',
});
export type AgentId = typeof AgentId.Type;

/** How hard the Agent thinks, in Spence's own vocabulary; an Agent may offer only some levels, or none. */
export const Effort = Schema.Literals(['low', 'medium', 'high', 'max']).annotate({
  identifier: 'Effort',
});
export type Effort = typeof Effort.Type;

/** A Model an Agent offers, named as the Agent names it; `id` is what Spence sends back and what a pin stores. */
export const Model = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Model' });
export type Model = typeof Model.Type;

/** What an Agent accepts as Images in one Message. */
export const ImageLimits = Schema.Struct({
  /** Largest Image, measured as its base64 payload. */
  maxBase64Bytes: Schema.Number,
  /** Longest side, in pixels. */
  maxDimensionPx: Schema.Number,
  maxPerMessage: Schema.Number,
}).annotate({ identifier: 'ImageLimits' });
export type ImageLimits = typeof ImageLimits.Type;

/** How an Agent's ACP integration is distributed and installed. */
export const InstallKind = Schema.Literals(['npm', 'native']).annotate({
  identifier: 'InstallKind',
});
export type InstallKind = typeof InstallKind.Type;

/** Whether the detected Agent version matches Spence's qualified baseline. */
export const VersionQualification = Schema.Literals(['qualified', 'unverified']).annotate({
  identifier: 'VersionQualification',
});
export type VersionQualification = typeof VersionQualification.Type;

/** Spence-owned Agent capability flags; ACP and vendor details stay in main. */
export const AgentCapabilities = Schema.Struct({
  models: Schema.Boolean,
  effort: Schema.Boolean,
  images: Schema.Boolean,
  askMode: Schema.Boolean,
  resume: Schema.Boolean,
  contextUsage: Schema.Boolean,
  supportsCompaction: Schema.Boolean,
  supportsIsolatedSummary: Schema.Boolean,
  modelChangePreservesContext: Schema.Boolean,
  /**
   * Whether the Agent can take Spence's MCP tools, and so the cross-device tools (`list_targets`, `send_message` to a
   * target handle, `start_session`, `await_result`). False only when its adapter demonstrably cannot: its Sessions are
   * then not offered them and the Agent picker says "No cross-device tools". Qualification never changes it.
   */
  crossDeviceTools: Schema.Boolean,
}).annotate({ identifier: 'AgentCapabilities' });
export type AgentCapabilities = typeof AgentCapabilities.Type;

/** Why a configured native `binaryPath` override failed validation. */
export const BinaryPathError = Schema.Literals(['notAbsolute', 'notLaunchable']).annotate({
  identifier: 'BinaryPathError',
});
export type BinaryPathError = typeof BinaryPathError.Type;

/** A Catalog Agent as the renderer sees it. */
export const Agent = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  installKind: InstallKind,
  /** The npm package of the Agent's ACP adapter when `installKind === 'npm'`, else `''`. */
  package: Schema.String,
  /** Whether the adapter (from Spence's managed folder) or native CLI resolves right now. */
  installed: Schema.Boolean,
  imageLimits: ImageLimits,
  capabilities: AgentCapabilities,
  /** Version (or minimum version) qualified by Spence for this Catalog entry. */
  qualifiedVersion: Schema.String,
  /** Installed version when known without spawning on startup (e.g. static `package.json` or cached check). */
  installedVersion: Schema.optionalKey(Schema.String),
  versionQualification: Schema.optionalKey(VersionQualification),
  /** Qualified package/upgrade hint shown for unverified or incompatible installs. */
  upgradeCommand: Schema.optionalKey(Schema.String),
  /** Official install guidance when `installKind === 'native'`. */
  installInstructions: Schema.optionalKey(Schema.String),
  /** Validation issue when a native `binaryPath` override is configured but cannot be used. */
  binaryPathError: Schema.optionalKey(BinaryPathError),
}).annotate({ identifier: 'Agent' });
export type Agent = typeof Agent.Type;

/** Why an install or setup did not succeed. */
export const InstallFailure = Schema.Literals([
  /** Downloading or extracting Spence's managed Node runtime failed. */
  'RuntimeDownloadFailed',
  /** The downloaded Node runtime failed SHA-256 verification. */
  'ChecksumMismatch',
  /** Could not write to Spence's managed folder or adapter prefix (EACCES / EPERM). */
  'PermissionDenied',
  /** npm could not be started, or exited non-zero for another reason. */
  'NpmFailed',
  /** Native Agent binary is not on the merged PATH, or installed adapter failed verification. */
  'NotOnPath',
]).annotate({ identifier: 'InstallFailure' });
export type InstallFailure = typeof InstallFailure.Type;

/** Phased progress of `Agents.install`: `downloadingRuntime` (when needed) -> `installingAdapter` -> terminal event. */
export const InstallEvent = Schema.Union([
  Schema.TaggedStruct('downloadingRuntime', {
    startedAt: Schema.optionalKey(Schema.Number),
  }),
  Schema.TaggedStruct('installingAdapter', {
    startedAt: Schema.optionalKey(Schema.Number),
  }),
  Schema.TaggedStruct('succeeded', {}),
  Schema.TaggedStruct('cancelled', {}),
  Schema.TaggedStruct('failed', {
    reason: InstallFailure,
    /** One line from npm (or Spence) on what went wrong; shown verbatim, never translated. */
    detail: Schema.String,
    /** Where the full install output was written. */
    logPath: Schema.String,
  }),
]).annotate({ identifier: 'InstallEvent' });
export type InstallEvent = typeof InstallEvent.Type;

/** Active phase of a background Agent setup job. */
export const InstallPhase = Schema.Literals([
  'preparing',
  'downloadingRuntime',
  'installingAdapter',
]).annotate({ identifier: 'InstallPhase' });
export type InstallPhase = typeof InstallPhase.Type;

/** Snapshot of whether a background Agent setup job is currently active in main. */
export const InstallStatus = Schema.Union([
  Schema.TaggedStruct('idle', {}),
  Schema.TaggedStruct('installing', {
    phase: InstallPhase,
    startedAt: Schema.Number,
  }),
]).annotate({ identifier: 'InstallStatus' });
export type InstallStatus = typeof InstallStatus.Type;

const AgentRef = { agentId: AgentId };

export const AgentsRpcs = RpcGroup.make(
  Rpc.make('Agents.list', { success: Schema.Array(Agent) }),
  /** Invalidates and recomputes Merged PATH before re-inspecting every Catalog Agent. */
  Rpc.make('Agents.rescan', { success: Schema.Array(Agent) }),
  Rpc.make('Agents.install', { payload: AgentRef, success: InstallEvent, stream: true }),
  Rpc.make('Agents.cancelInstall', { payload: AgentRef }),
  Rpc.make('Agents.installStatus', { payload: AgentRef, success: InstallStatus }),
  /** Opens the install log in the system's viewer. Main knows the path; the renderer never names a file. */
  Rpc.make('Agents.openInstallLog'),
);
