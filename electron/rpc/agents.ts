import { Effect, Layer, Stream } from 'effect';
import { AgentsRpcs } from '../../src/shared/agents/agents.rpc';
import { Agents, layerAgents } from '../agents/agents';
import { layerMergedPathMain } from '../agents/e2e-agent';
import { AgentInstall, layerAgentInstall } from '../agents/install';
import { layerPathSources } from '../agents/merged-path';
import { layerAgentRuntimeMain } from '../agents/runtime';
import { layerSettingsMain } from '../settings/window';
import { layerStoreUserData } from '../store/store';

/** Production `Agents` layer shared across `AgentsRpcs` and `Sessions` so main builds it once. */
export const layerAgentsMain = layerAgents.pipe(
  Layer.provide(layerMergedPathMain),
  Layer.provide(layerPathSources),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerAgentRuntimeMain),
  Layer.provide(layerSettingsMain),
);

/** Production `AgentInstall` layer shared across `AgentsRpcs` and `MainRuntime` (quit cleanup). */
export const layerAgentInstallMain = layerAgentInstall.pipe(
  Layer.provideMerge(layerAgentsMain),
  Layer.provide(layerAgentRuntimeMain),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerMergedPathMain),
  Layer.provide(layerPathSources),
);

/** Unbound: needs `Agents` and `AgentInstall`, so a test Device can serve them over its own Store and PATH. */
export const layerAgentsHandlersWith = AgentsRpcs.toLayer({
  'Agents.list': () =>
    Agents.use((agents) => agents.list).pipe(
      Effect.tap((listed) =>
        Effect.logInfo(
          `Agents.list: ${listed.length} (${listed.filter((a) => a.installed).length} installed)`,
        ),
      ),
      Effect.tapError((error) => Effect.logWarning('Agents.list failed', error)),
    ),
  'Agents.rescan': () => Agents.use((agents) => agents.rescan),
  'Agents.install': ({ agentId }) =>
    Stream.unwrap(AgentInstall.use((install) => Effect.succeed(install.install(agentId)))),
  'Agents.cancelInstall': ({ agentId }) => AgentInstall.use((install) => install.cancel(agentId)),
  'Agents.installStatus': ({ agentId }) => AgentInstall.use((install) => install.status(agentId)),
  'Agents.openInstallLog': () => AgentInstall.use((install) => install.openLog),
});

export const layerAgentsHandlers = layerAgentsHandlersWith.pipe(
  Layer.provide(layerAgentInstallMain),
);
