import { Effect, Layer } from 'effect';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { claude } from '../agents/claude/claude';
import type { CatalogEntry } from '../agents/catalog';
import { layerMergedPath, layerPathSources, MergedPath } from '../agents/merged-path';
import { SessionAgent } from './sessions';

/**
 * The folder holding the e2e fake Agent's `fake-agent` shim (`SPENCE_E2E_AGENT_BIN`). Read only when `SPENCE_E2E=1`;
 * a normal launch never honours it.
 */
export const e2eAgentBin = (env: NodeJS.ProcessEnv): string | undefined =>
  env['SPENCE_E2E'] === '1' ? env['SPENCE_E2E_AGENT_BIN'] : undefined;

/** The fake Agent (`electron/acp/fakeAgent.mjs`) as e2e runs it. */
const fakeAgent: CatalogEntry = {
  id: AgentId.make('fake'),
  name: 'Fake',
  package: '@spence/fake-agent',
  binary: 'fake-agent',
  args: [],
  registryId: 'fake',
  imageLimits: claude.imageLimits,
};

const e2eBin = e2eAgentBin(process.env);

/**
 * The Agent new Sessions run with and the PATH it is found on: Claude on the merged PATH, or under e2e the fake Agent
 * in `SPENCE_E2E_AGENT_BIN`.
 */
export const layerSessionAgentLive =
  e2eBin === undefined
    ? Layer.mergeAll(Layer.succeed(SessionAgent, claude), layerMergedPath).pipe(
        Layer.provideMerge(layerPathSources),
      )
    : Layer.mergeAll(
        Layer.succeed(SessionAgent, fakeAgent),
        Layer.succeed(MergedPath, { get: Effect.succeed(e2eBin) }),
        layerPathSources,
      );
