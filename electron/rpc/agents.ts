import { Effect, Layer, Stream } from 'effect';
import { AgentsRpcs } from '../../src/shared/agents/agents.rpc';
import { Agents, layerAgents } from '../agents/agents';
import { AgentInstall, layerAgentInstall } from '../agents/install';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStoreUserData } from '../store/store';

/** Unbound: needs `Agents` and `AgentInstall`, so a test Device can serve them over its own Store and PATH. */
export const layerAgentsHandlersWith = AgentsRpcs.toLayer({
  'Agents.list': () => Agents.use((agents) => agents.list),
  'Agents.installCommand': ({ agentId }) => AgentInstall.use((install) => install.command(agentId)),
  'Agents.install': ({ agentId }) =>
    Stream.unwrap(AgentInstall.use((install) => Effect.succeed(install.install(agentId)))),
  'Agents.openInstallLog': () => AgentInstall.use((install) => install.openLog),
});

export const layerAgentsHandlers = layerAgentsHandlersWith.pipe(
  Layer.provide(layerAgentInstall.pipe(Layer.provideMerge(layerAgents))),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerMergedPath),
  Layer.provide(layerPathSources),
);
