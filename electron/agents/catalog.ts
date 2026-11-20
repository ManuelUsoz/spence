import type {
  AgentCapabilities,
  AgentId,
  Effort,
  ImageLimits,
  InstallKind,
  Model,
} from '../../src/shared/agents/agents.rpc';
import { antigravity } from './antigravity/antigravity';
import { claude } from './claude/claude';
import { codex } from './codex/codex';
import type { SubagentMode } from '../../src/shared/settings/settings.rpc';
import type { PermissionModeMap } from './permission-modes';
import type { VersionSpec } from './version';

/**
 * How an Agent's `thought_level` config option names Spence's Effort levels. A level whose value the Agent does not
 * offer in a session is shown disabled.
 */
export type EffortMap = Readonly<Record<Effort, string>>;

/** Adapter-specific `_meta` of `session/new`, `session/resume` and `session/load`. */
export type SessionMeta = Readonly<Record<string, unknown>>;

/** Required admission gates verified for an Agent before sessions can run. */
export interface AdmissionGates {
  readonly supportsAuto: boolean;
  readonly supportsCancel: boolean;
  readonly supportsAuthDetection: boolean;
}

/** An Agent Spence knows how to launch, via packaged ACP adapter (`npm`) or native ACP CLI (`native`). */
export interface CatalogEntry {
  readonly id: AgentId;
  readonly name: string;
  readonly installKind: InstallKind;
  /** npm package of the ACP adapter when `installKind === 'npm'`, else `''`. */
  readonly package: string;
  /** Optional version-pinned package specifier passed to `npm install -g` (defaults to `package`). */
  readonly installPackage?: string;
  /** Binary name resolved on the merged PATH (`claude-agent-acp`, `codex-acp`, or native `agy`). */
  readonly binary: string;
  /** Constant launch arguments; validated again when the command line is built. */
  readonly args: ReadonlyArray<string>;
  /** The Agent's id in the ACP Registry. Reference only: Spence never launches from the registry. */
  readonly registryId: string;
  readonly qualification: VersionSpec;
  readonly upgradeCommand?: string;
  readonly installInstructions?: string;
  readonly loginInstructions?: string;
  readonly imageLimits: ImageLimits;
  /** Spence's Effort levels as the Agent's values (`electron/agents/<agent>/`). */
  readonly effort: EffortMap;
  /** How Spence's Permission modes map onto the Agent's own session modes. */
  readonly permissionModes: PermissionModeMap;
  readonly capabilities: AgentCapabilities;
  /** The `_meta` the adapter reads when a session opens, for the Subagents Setting (Agents without one omit it). */
  readonly sessionMeta?: (mode: SubagentMode) => SessionMeta;
  /** True when the Agent steers a normal prompt sent mid-Turn, instead of advertising `_session/steering`. */
  readonly nativeSteering?: boolean;
  /** Required admission gates (defaults to all `true` when omitted). */
  readonly admission?: Partial<AdmissionGates>;
  /** Filters models ineligible for a `spence` client, returning an optional limitation note. */
  readonly filterModels?: (models: ReadonlyArray<Model>) => {
    readonly models: ReadonlyArray<Model>;
    readonly excludedNote?: string;
  };
}

/** The hand-written Catalog of multi-Agent integrations. */
export const catalog: ReadonlyArray<CatalogEntry> = [claude, codex, antigravity];

/** What `agentId`’s adapter should read in `_meta` when a session opens for `mode`; nothing for most Agents. */
export const sessionMetaFor = (agentId: AgentId, mode: SubagentMode): SessionMeta | undefined =>
  catalog.find((entry) => entry.id === agentId)?.sessionMeta?.(mode);
