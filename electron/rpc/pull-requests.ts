import { Layer } from 'effect';
import { PullRequestsRpcs } from '../../src/shared/pull-requests/pull-requests.rpc';
import { layerMergedPathMain } from '../agents/e2e-agent';
import { layerPathSources } from '../agents/merged-path';
import { layerSecretStorageLive } from '../devices/secret-storage-electron';
import { layerGitHubHttpLive } from '../git-hosts/github-http';
import { HostAuth, layerGhCliLive, layerHostAuth } from '../git-hosts/host-auth';
import { layerStoreUserData } from '../store/store';

/** Production `HostAuth` layer for the Local device. */
export const layerHostAuthMain = layerHostAuth.pipe(
  Layer.provide(layerStoreUserData),
  Layer.provide(layerSecretStorageLive),
  Layer.provide(layerGitHubHttpLive),
  Layer.provide(
    layerGhCliLive.pipe(Layer.provide(layerMergedPathMain), Layer.provide(layerPathSources)),
  ),
);

/** Unbound Pull requests & HostAuth RPC handlers (Local-only; never in `RemoteRpcs`). */
export const layerPullRequestsHandlersWith = PullRequestsRpcs.toLayer({
  'HostAuth.getAccounts': () => HostAuth.use((auth) => auth.getAccounts),
  'HostAuth.startDeviceFlow': ({ host }) => HostAuth.use((auth) => auth.startDeviceFlow(host)),
  'HostAuth.pollDeviceFlow': ({ host, flowId, persistMode }) =>
    HostAuth.use((auth) => auth.pollDeviceFlow(host, flowId, persistMode)),
  'HostAuth.cancelDeviceFlow': ({ host, flowId }) =>
    HostAuth.use((auth) => auth.cancelDeviceFlow(host, flowId)),
  'HostAuth.connectPat': ({ host, token, persistMode }) =>
    HostAuth.use((auth) => auth.connectPat(host, token, persistMode)),
  'HostAuth.checkGhCli': ({ host }) => HostAuth.use((auth) => auth.checkGhCli(host)),
  'HostAuth.importGhCli': ({ host, persistMode }) =>
    HostAuth.use((auth) => auth.importGhCli(host, persistMode)),
  'HostAuth.verify': ({ host }) => HostAuth.use((auth) => auth.verify(host)),
  'HostAuth.disconnect': ({ host }) => HostAuth.use((auth) => auth.disconnect(host)),
});

/** Local-only Pull requests & HostAuth handlers wired to production `HostAuth`. */
export const layerPullRequestsHandlers = layerPullRequestsHandlersWith.pipe(
  Layer.provide(layerHostAuthMain),
);
