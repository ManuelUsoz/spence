import { AgentId } from '../../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../catalog';

/** Claude, through Anthropic's adapter maintained by the ACP project. The `claude` CLI itself is never used. */
export const claude: CatalogEntry = {
  id: AgentId.make('claude'),
  name: 'Claude',
  package: '@agentclientprotocol/claude-agent-acp',
  binary: 'claude-agent-acp',
  args: [],
  registryId: 'claude-acp',
  imageLimits: { maxBase64Bytes: 5 * 1024 * 1024, maxDimensionPx: 8000, maxPerMessage: 20 },
};
