import type { PermissionModeMap } from '../permission-modes';

/**
 * Claude's session modes (`@agentclientprotocol/claude-agent-acp`): Ask is `default` ("Always ask before making
 * changes"), Auto is Claude's own `auto` ("Claude handles permission decisions"); requests it still sends go to the
 * user. Its other modes (`acceptEdits`, `plan`, `bypassPermissions`) are not mapped.
 */
export const claudePermissionModes: PermissionModeMap = {
  ask: { agentMode: 'default' },
  auto: { agentMode: 'auto' },
};
