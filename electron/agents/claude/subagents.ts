import type { SubagentMode } from '../../../src/shared/settings/settings.rpc';

/** Claude Code's own subagent tool: `Agent`, formerly `Task`. */
const NATIVE_SUBAGENT_TOOLS = ['Agent', 'Task'];

const WORKERS_INSTRUCTION =
  'To hand work to a subagent, call the `delegate` tool of the `spence` MCP server (`mcp__spence__delegate`), ' +
  'never a built-in subagent tool. Spence shows each Worker as its own Session that the user can open and message.';

/**
 * The `_meta` the Claude adapter reads on `session/new`, `session/resume` and `session/load`. `workers` takes the
 * built-in subagent tool away and points the Agent at `delegate`; `native` sends the empty list, so a resumed
 * session does not keep an earlier restriction.
 */
export const claudeSessionMeta = (mode: SubagentMode): Readonly<Record<string, unknown>> =>
  mode === 'workers'
    ? {
        claudeCode: { options: { disallowedTools: NATIVE_SUBAGENT_TOOLS } },
        systemPrompt: { append: WORKERS_INSTRUCTION },
      }
    : { claudeCode: { options: { disallowedTools: [] } } };
