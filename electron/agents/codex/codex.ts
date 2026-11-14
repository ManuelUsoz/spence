import { AgentId } from '../../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../catalog';

export const CODEX_QUALIFIED_VERSION = '2.6.0';

/** Codex, through the `@agentclientprotocol/codex-acp` packaged adapter. */
export const codex: CatalogEntry = {
  id: AgentId.make('codex'),
  name: 'Codex',
  installKind: 'npm',
  package: '@agentclientprotocol/codex-acp',
  binary: 'codex-acp',
  args: [],
  registryId: 'codex-acp',
  qualification: { kind: 'exact', version: CODEX_QUALIFIED_VERSION },
  upgradeCommand: `npm install -g @agentclientprotocol/codex-acp@${CODEX_QUALIFIED_VERSION}`,
  imageLimits: { maxBase64Bytes: 5 * 1024 * 1024, maxDimensionPx: 8000, maxPerMessage: 20 },
  effort: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  permissionModes: {
    ask: { agentMode: 'read-only' },
    auto: { agentMode: 'auto', autoAllow: true },
  },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: false,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
  },
};
