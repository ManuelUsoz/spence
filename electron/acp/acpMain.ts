import { Layer } from 'effect';
import { layerMergedPathMain } from '../agents/e2e-agent';
import { layerPathSources } from '../agents/merged-path';
import { layerAgentLogsUserData } from './acpAgentLog';
import { layerAgentLifetime } from './acpLifetime';
import { layerAcpClient } from './acpSessionManager';

/** The ACP client for the app: Agents on the merged PATH (the fake Agent under e2e), logs under `<userData>/spence/logs/agents/`. */
export const layerAcpClientMain = layerAcpClient.pipe(
  Layer.provide(layerAgentLogsUserData),
  Layer.provide(layerMergedPathMain),
  Layer.provide(layerPathSources),
);

/**
 * The app's `AgentLifetime` together with the `AcpClient` it governs. Provide this one value wherever either is
 * needed, so main runs exactly one of each (layers are memoized by reference).
 */
export const layerAgentLifetimeMain = layerAgentLifetime.pipe(
  Layer.provideMerge(layerAcpClientMain),
);
