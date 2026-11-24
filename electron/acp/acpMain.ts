import { Layer } from 'effect';
import { layerMergedPathMain } from '../agents/e2e-agent';
import { layerPathSources } from '../agents/merged-path';
import { layerAgentRuntimeMain } from '../agents/runtime';
import { layerSettingsMain } from '../settings/window';
import { layerStoreUserData } from '../store/store';
import { layerAgentLogsUserData } from './acpAgentLog';
import { layerAgentLifetime } from './acpLifetime';
import { layerAcpClient } from './acpSessionManager';

/** The ACP client for the app: managed adapters + native Agents on the merged PATH (fake Agent under e2e), logs under `<userData>/spence/logs/agents/`. */
export const layerAcpClientMain = layerAcpClient.pipe(
  Layer.provide(layerAgentLogsUserData),
  Layer.provide(layerMergedPathMain),
  Layer.provide(layerPathSources),
  Layer.provide(layerStoreUserData),
  Layer.provide(layerAgentRuntimeMain),
  Layer.provide(layerSettingsMain),
);

/**
 * The app's `AgentLifetime` together with the `AcpClient` it governs. Provide this one value wherever either is
 * needed, so main runs exactly one of each (layers are memoized by reference).
 */
export const layerAgentLifetimeMain = layerAgentLifetime.pipe(
  Layer.provideMerge(layerAcpClientMain),
);
