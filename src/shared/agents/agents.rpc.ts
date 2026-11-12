import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** Identifies a Catalog Agent; stored on every Session. */
export const AgentId = Schema.String.pipe(Schema.brand('AgentId')).annotate({
  identifier: 'AgentId',
});
export type AgentId = typeof AgentId.Type;

/** What an Agent accepts as Images in one Message. */
export const ImageLimits = Schema.Struct({
  /** Largest Image, measured as its base64 payload. */
  maxBase64Bytes: Schema.Number,
  /** Longest side, in pixels. */
  maxDimensionPx: Schema.Number,
  maxPerMessage: Schema.Number,
}).annotate({ identifier: 'ImageLimits' });
export type ImageLimits = typeof ImageLimits.Type;

/** A Catalog Agent as the renderer sees it. */
export const Agent = Schema.Struct({
  id: AgentId,
  name: Schema.String,
  /** The npm package of the Agent's ACP adapter, e.g. for the install command. */
  package: Schema.String,
  /** Whether the adapter resolves on the merged PATH right now. */
  installed: Schema.Boolean,
  imageLimits: ImageLimits,
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
