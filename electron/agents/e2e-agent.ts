import { Effect, Layer } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import type { CatalogEntry } from './catalog';
import { claude } from './claude/claude';
import { layerMergedPath, MergedPath } from './merged-path';
import type { PermissionModeMap } from './permission-modes';

/**
 * The folder holding the e2e fake Agent's `fake-agent` shim (`SPENCE_E2E_AGENT_BIN`). Read only when `SPENCE_E2E=1`;
 * a normal launch never honours it.
 */
export const e2eAgentBin = (env: NodeJS.ProcessEnv): string | undefined =>
  env['SPENCE_E2E'] === '1' ? env['SPENCE_E2E_AGENT_BIN'] : undefined;

/**
 * The fake Agent's Permission modes: like an Agent without an auto mode of its own, so in Auto main answers its
 * requests by policy.
 */
export const fakePermissionModes: PermissionModeMap = {
  ask: { agentMode: 'default' },
  auto: { agentMode: 'acceptEdits', autoAllow: true },
};

/** The fake Agent (`electron/acp/fakeAgent.mjs`) as e2e runs it. Never in the Catalog. */
export const e2eFakeAgent: CatalogEntry = {
  id: AgentId.make('fake'),
  name: 'Fake',
  installKind: 'npm',
  package: '@spence/fake-agent',
  binary: 'fake-agent',
  args: [],
  registryId: 'fake',
  qualification: { kind: 'exact', version: '1.0.0' },
  upgradeCommand: 'npm install -g @spence/fake-agent@1.0.0',
  imageLimits: claude.imageLimits,
  // Named like Claude's; the fake Agent offers low, medium and high only.
  effort: claude.effort,
  permissionModes: fakePermissionModes,
  capabilities: claude.capabilities,
};

/** This launch's e2e fake Agent folder, if any. */
export const e2eBin = e2eAgentBin(process.env);

/** The PATH main launches Agents on: the merged PATH, or under e2e the fake Agent's folder. */
export const layerMergedPathMain =
  e2eBin === undefined
    ? layerMergedPath
    : Layer.succeed(MergedPath, { get: Effect.succeed(e2eBin) });
