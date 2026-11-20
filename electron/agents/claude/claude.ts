import { AgentId } from '../../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../catalog';
import { claudeEffort } from './effort';
import { claudePermissionModes } from './permission-modes';
import { claudeSessionMeta } from './subagents';

export const CLAUDE_QUALIFIED_VERSION = '0.106.0';

/** Claude, through Anthropic's adapter maintained by the ACP project. The `claude` CLI itself is never used. */
export const claude: CatalogEntry = {
  id: AgentId.make('claude'),
  name: 'Claude',
  installKind: 'npm',
  package: '@agentclientprotocol/claude-agent-acp',
  binary: 'claude-agent-acp',
  args: [],
  registryId: 'claude-acp',
  qualification: { kind: 'exact', version: CLAUDE_QUALIFIED_VERSION },
  upgradeCommand: `npm install -g @agentclientprotocol/claude-agent-acp@${CLAUDE_QUALIFIED_VERSION}`,
  imageLimits: { maxBase64Bytes: 5 * 1024 * 1024, maxDimensionPx: 8000, maxPerMessage: 20 },
  effort: claudeEffort,
  permissionModes: claudePermissionModes,
  sessionMeta: claudeSessionMeta,
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: true,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
    crossDeviceTools: true,
  },
};
