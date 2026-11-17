import { AgentId, type Model } from '../../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from '../catalog';

export const ANTIGRAVITY_QUALIFIED_VERSION = '1.2.0';

const INELIGIBLE_THIRD_PARTY_PREFIXES = ['claude-', 'gpt-', 'o1', 'o3', 'o4'] as const;

const isEligibleForSpence = (model: Model): boolean => {
  const lower = model.id.toLowerCase();
  return !INELIGIBLE_THIRD_PARTY_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

/** Antigravity, launched natively via `agy acp`. Missing `agy` surfaces Google's official install instructions. */
export const antigravity: CatalogEntry = {
  id: AgentId.make('antigravity'),
  name: 'Antigravity',
  installKind: 'native',
  package: '',
  binary: 'agy',
  args: ['acp'],
  registryId: 'antigravity',
  qualification: { kind: 'min', version: ANTIGRAVITY_QUALIFIED_VERSION },
  upgradeCommand: 'Update Google Antigravity (`agy` 1.2+)',
  installInstructions:
    'Install Google Antigravity from antigravity.google so `agy` is on your PATH, then click Re-scan.',
  loginInstructions:
    'Sign in with your Google account in Google Antigravity, then click Log in or try again.',
  imageLimits: { maxBase64Bytes: 5 * 1024 * 1024, maxDimensionPx: 8000, maxPerMessage: 20 },
  effort: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
  permissionModes: {
    auto: { agentMode: 'auto', autoAllow: true },
  },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: false,
    resume: true,
    contextUsage: true,
    supportsCompaction: false,
    supportsIsolatedSummary: false,
    modelChangePreservesContext: false,
  },
  // Antigravity steers a normal `session/prompt` sent while a turn runs.
  nativeSteering: true,
  filterModels: (models) => {
    const eligible = models.filter(isEligibleForSpence);
    return eligible.length < models.length
      ? {
          models: eligible,
          excludedNote: 'Third-party models in Antigravity are unavailable for Spence clients.',
        }
      : { models: eligible };
  },
};
