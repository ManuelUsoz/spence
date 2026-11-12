import { shell } from 'electron';
import { Effect, Layer, Stream } from 'effect';
import { AgentsRpcs } from '../../src/shared/agents/agents.rpc';
import { Agents, layerAgents } from '../agents/agents';
import { AgentInstall, layerAgentInstall } from '../agents/install';
import { layerMergedPath, layerPathSources } from '../agents/merged-path';
import { layerStoreUserData } from '../store/store';

/** Opens a file in the system's viewer; a file that cannot be opened (e.g. not written yet) is only logged. */
const openPath = (path: string) =>
  Effect.promise(() => shell.openPath(path)).pipe(
    Effect.flatMap((error) =>
      error === '' ? Effect.void : Effect.logWarning(`Could not open ${path}: ${error}`),
    ),
  );

export const layerAgentsHandlers = AgentsRpcs.toLayer({
  'Agents.list': () => Agents.use((agents) => agents.list),
  'Agents.installCommand': ({ agentId }) => AgentInstall.use((install) => install.command(agentId)),
  'Agents.install': ({ agentId }) =>
    Stream.unwrap(AgentInstall.use((install) => Effect.succeed(install.install(agentId)))),
  'Agents.openInstallLog': () => AgentInstall.use((install) => openPath(install.logPath)),
}).pipe(
  Layer.provide(layerAgentInstall.pipe(Layer.provideMerge(layerAgents))),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerMergedPath),
  Layer.provide(layerPathSources),
);
