import type { AgentId, Effort, ImageLimits } from '../../src/shared/agents/agents.rpc';
import { claude } from './claude/claude';

/**
 * How an Agent's `thought_level` config option names Spence's Effort levels. A level whose value the Agent does not
 * offer in a session is shown disabled.
 */
export type EffortMap = Readonly<Record<Effort, string>>;

/** An Agent Spence knows how to launch: always through its official `@agentclientprotocol/*` adapter. */
export interface CatalogEntry {
  readonly id: AgentId;
  readonly name: string;
  /** npm package of the ACP adapter. */
  readonly package: string;
  /** The adapter's binary name, resolved on the merged PATH. Vendor CLIs are never probed. */
  readonly binary: string;
  /** Constant launch arguments; validated again when the command line is built. */
  readonly args: ReadonlyArray<string>;
  /** The Agent's id in the ACP Registry. Reference only: Spence never launches from the registry. */
  readonly registryId: string;
  readonly imageLimits: ImageLimits;
  /** Spence's Effort levels as the Agent's values (`electron/agents/<agent>/`). */
  readonly effort: EffortMap;
}

/** The hand-written Catalog. v1: Claude only. */
export const catalog: ReadonlyArray<CatalogEntry> = [claude];
