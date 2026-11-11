import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** Identifies a Catalog Agent; stored on every Session. */
export const AgentId = Schema.String.pipe(Schema.brand('AgentId'));
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

export const AgentsRpcs = RpcGroup.make(Rpc.make('Agents.list', { success: Schema.Array(Agent) }));
