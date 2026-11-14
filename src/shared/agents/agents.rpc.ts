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
}).annotate({ identifier: 'AgentCapabilities' });
export type AgentCapabilities = typeof AgentCapabilities.Type;

/** A Catalog Agent as the renderer sees it. */
export const Agent = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  installKind: InstallKind,
  /** The npm package of the Agent's ACP adapter when `installKind === 'npm'`, else `''`. */
  package: Schema.String,
  /** Whether the adapter or native CLI resolves on the merged PATH right now. */
  installed: Schema.Boolean,
  imageLimits: ImageLimits,
  capabilities: AgentCapabilities,
  /** Version (or minimum version) qualified by Spence for this Catalog entry. */
  qualifiedVersion: Schema.String,
  /** Installed version when known without spawning on startup (e.g. static `package.json` or cached check). */
  installedVersion: Schema.optionalKey(Schema.String),
  versionQualification: Schema.optionalKey(VersionQualification),
  /** Qualified install/upgrade command shown for unverified or incompatible installs. */
  upgradeCommand: Schema.optionalKey(Schema.String),
  /** Official install guidance when `installKind === 'native'`. */
  installInstructions: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Agent' });
export type Agent = typeof Agent.Type;

/** How a Catalog Agent's adapter is installed, and whether that can run here. */
export const InstallCommand = Schema.Struct({
  /** The exact command Spence runs, e.g. `npm install -g @agentclientprotocol/claude-agent-acp`. */
  command: Schema.String,
  /** Whether `npm` resolves on the merged PATH; without it only the command is offered. */
  npmFound: Schema.Boolean,
}).annotate({ identifier: 'InstallCommand' });
export type InstallCommand = typeof InstallCommand.Type;

/** Why an install did not end with the adapter on the merged PATH. */
export const InstallFailure = Schema.Literals([
  /** No `npm` on the merged PATH. */
  'NoNpm',
  /** npm could not write to its global folder (EACCES / EPERM). */
  'PermissionDenied',
  /** npm could not be started, or exited non-zero for another reason. */
  'NpmFailed',
  /** npm succeeded, but the adapter still does not resolve on the merged PATH. */
  'NotOnPath',
]).annotate({ identifier: 'InstallFailure' });
export type InstallFailure = typeof InstallFailure.Type;

/** Progress of `Agents.install`: `started`, then exactly one of `succeeded` or `failed`. */
export const InstallEvent = Schema.Union([
  Schema.TaggedStruct('started', {}),
  Schema.TaggedStruct('succeeded', {}),
  Schema.TaggedStruct('failed', {
    reason: InstallFailure,
    /** One line from npm (or Spence) on what went wrong; shown verbatim, never translated. */
    detail: Schema.String,
    /** Where npm's full output was written. */
    logPath: Schema.String,
  }),
]).annotate({ identifier: 'InstallEvent' });
export type InstallEvent = typeof InstallEvent.Type;

const AgentRef = { agentId: AgentId };

export const AgentsRpcs = RpcGroup.make(
  Rpc.make('Agents.list', { success: Schema.Array(Agent) }),
  Rpc.make('Agents.installCommand', { payload: AgentRef, success: InstallCommand }),
  Rpc.make('Agents.install', { payload: AgentRef, success: InstallEvent, stream: true }),
  /** Opens the install log in the system's viewer. Main knows the path; the renderer never names a file. */
  Rpc.make('Agents.openInstallLog'),
);
