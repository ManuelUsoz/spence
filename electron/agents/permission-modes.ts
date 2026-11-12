import type { PermissionMode } from '../../src/shared/projects/projects.rpc';
import type { PermissionOption } from '../../src/shared/sessions/sessions.rpc';

/** What one Permission mode is for an Agent: the Agent's own session mode, and whether main answers for the user. */
export interface PermissionModeMapping {
  /** The id of the Agent's session mode (ACP `session/set_mode`). */
  readonly agentMode: string;
  /**
   * For an Agent without an auto mode of its own: main answers every Permission request `allow_once`, recorded
   * `by: policy`. Main's own answers are only ever "once".
   */
  readonly autoAllow?: boolean;
}

/** Spence's Permission modes onto one Agent's session modes; a plain `Record` per Agent in `electron/agents/<agent>/`. */
export type PermissionModeMap = Readonly<Record<PermissionMode, PermissionModeMapping>>;

/** The option main picks for the user under `mapping`: the first allow-once one, when the mode auto-allows. */
export const policyAnswer = (
  mapping: PermissionModeMapping,
  options: ReadonlyArray<PermissionOption>,
): PermissionOption | undefined =>
  mapping.autoAllow === true ? options.find((option) => option.kind === 'allowOnce') : undefined;
