import { Layer } from 'effect';
import { AgentsRpcs } from '../../src/shared/agents/agents.rpc';
import { Agents, layerAgents } from '../agents/agents';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';

export const layerAgentsHandlers = AgentsRpcs.toLayer({
  'Agents.list': () => Agents.use((agents) => agents.list),
}).pipe(
  Layer.provide(layerAgents),
  Layer.provide(layerMergedPath),
  Layer.provide(layerPathSources),
);
