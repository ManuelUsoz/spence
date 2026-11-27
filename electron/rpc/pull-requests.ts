import { Effect, Layer, Option, Stream } from 'effect';
import { PullRequestsRpcs } from '../../src/shared/pull-requests/pull-requests.rpc';
import { layerAcpClientMain } from '../acp/acpMain';
import { layerMergedPathMain } from '../agents/e2e-agent';
import { layerPathSources } from '../agents/merged-path';
import { layerSecretStorageLive } from '../devices/secret-storage-electron';
import { GitHostRegistry, makeGitHostRegistry } from '../git-hosts/git-host';
import { makeGitHubAdapter } from '../git-hosts/github-adapter';
import { layerGitHubHttpLive } from '../git-hosts/github-http';
import { HostAuth, layerGhCliLive, layerHostAuth } from '../git-hosts/host-auth';
import { layerPrStore } from '../git-hosts/pr-store';
import {
  layerLocalBranchCoordinatorLive,
  layerProjectGitInspectorLive,
  layerPullRequestsService,
  PullRequestsService,
  WorktreeSessionChecker,
} from '../git-hosts/pull-requests-service';
import { layerProjectsLive } from '../projects/projects';
import { Sessions } from '../sessions/sessions';
import { layerWindowFocus } from '../sessions/window-focus';
import { layerSettingsMain } from '../settings/window';
import { layerStoreUserData } from '../store/store';
import { layerBranchOrigins } from '../worktrees/branch-origins';
import { layerSessionsLive } from './sessions';

/** Production `HostAuth` layer for the Local device. */
export const layerHostAuthMain = layerHostAuth.pipe(
  Layer.provide(layerStoreUserData),
  Layer.provide(layerSecretStorageLive),
  Layer.provide(layerGitHubHttpLive),
  Layer.provide(
    layerGhCliLive.pipe(Layer.provide(layerMergedPathMain), Layer.provide(layerPathSources)),
  ),
);

/** Production `GitHostRegistry` layer for the Local device. */
export const layerGitHostRegistryMain = Layer.effect(
  GitHostRegistry,
  Effect.gen(function* () {
    const github = yield* makeGitHubAdapter;
    return makeGitHostRegistry([github]);
  }),
).pipe(Layer.provide(Layer.mergeAll(layerGitHubHttpLive, layerHostAuthMain)));

const layerPrStoreMain = layerPrStore.pipe(Layer.provide(layerStoreUserData));

const layerBranchOriginsMain = layerBranchOrigins.pipe(Layer.provide(layerStoreUserData));

const normalizeWtPath = (p: string): string =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const layerWorktreeSessionCheckerLive = Layer.effect(
  WorktreeSessionChecker,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    return {
      hasRunningSession: Effect.fnUntraced(function* (projectId, worktreePath) {
        const list = yield* sessions.list(projectId);
        const target = normalizeWtPath(worktreePath);
        for (const s of list) {
          if (s.archivedAt !== undefined) continue;
          if (s.status !== 'working' && s.status !== 'blocked') continue;
          const folder = yield* sessions
            .folderOf(s.id)
            .pipe(Effect.catch(() => Effect.succeed('')));
          if (folder.length > 0 && normalizeWtPath(folder) === target) {
            return true;
          }
        }
        return false;
      }),
    };
  }),
).pipe(Layer.provide(layerSessionsLive));

/** Production `PullRequestsService` layer for the Local device. */
export const layerPullRequestsServiceMain = layerPullRequestsService.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerProjectsLive,
      layerProjectGitInspectorLive,
      layerGitHostRegistryMain,
      layerHostAuthMain,
      layerPrStoreMain,
      layerWindowFocus,
      layerBranchOriginsMain,
      layerSettingsMain,
      layerAcpClientMain,
      layerLocalBranchCoordinatorLive.pipe(
        Layer.provide(layerMergedPathMain),
        Layer.provide(layerPathSources),
      ),
      layerWorktreeSessionCheckerLive,
    ),
  ),
);

const evictIfAccountChanged = Effect.fnUntraced(function* (
  prevHandle: string | null,
  nextHandle: string | null,
) {
  if ((prevHandle !== null && prevHandle !== nextHandle) || nextHandle === null) {
    const pr = yield* Effect.serviceOption(PullRequestsService);
    if (Option.isSome(pr)) {
      yield* pr.value.evictAll();
    }
  }
});

/** Unbound Pull requests & HostAuth RPC handlers (Local-only; never in `RemoteRpcs`). */
export const layerPullRequestsHandlersWith = PullRequestsRpcs.toLayer({
  'HostAuth.getAccounts': () => HostAuth.use((auth) => auth.getAccounts),
  'HostAuth.startDeviceFlow': ({ host }) => HostAuth.use((auth) => auth.startDeviceFlow(host)),
  'HostAuth.pollDeviceFlow': Effect.fnUntraced(function* ({ host, flowId, persistMode }) {
    const auth = yield* HostAuth;
    const before = yield* auth.getAccounts;
    const prevHandle = before.accounts.find((a) => a.host === host)?.handle ?? null;
    const result = yield* auth.pollDeviceFlow(host, flowId, persistMode);
    if (result.status === 'complete') {
      yield* evictIfAccountChanged(prevHandle, result.account.handle);
    }
    return result;
  }),
  'HostAuth.cancelDeviceFlow': ({ host, flowId }) =>
    HostAuth.use((auth) => auth.cancelDeviceFlow(host, flowId)),
  'HostAuth.connectPat': Effect.fnUntraced(function* ({ host, token, persistMode }) {
    const auth = yield* HostAuth;
    const before = yield* auth.getAccounts;
    const prevHandle = before.accounts.find((a) => a.host === host)?.handle ?? null;
    const account = yield* auth.connectPat(host, token, persistMode);
    yield* evictIfAccountChanged(prevHandle, account.handle);
    return account;
  }),
  'HostAuth.checkGhCli': ({ host }) => HostAuth.use((auth) => auth.checkGhCli(host)),
  'HostAuth.importGhCli': Effect.fnUntraced(function* ({ host, persistMode }) {
    const auth = yield* HostAuth;
    const before = yield* auth.getAccounts;
    const prevHandle = before.accounts.find((a) => a.host === host)?.handle ?? null;
    const account = yield* auth.importGhCli(host, persistMode);
    yield* evictIfAccountChanged(prevHandle, account.handle);
    return account;
  }),
  'HostAuth.verify': ({ host }) => HostAuth.use((auth) => auth.verify(host)),
  'HostAuth.disconnect': Effect.fnUntraced(function* ({ host }) {
    const auth = yield* HostAuth;
    yield* auth.disconnect(host);
    const pr = yield* Effect.serviceOption(PullRequestsService);
    if (Option.isSome(pr)) {
      yield* pr.value.evictAll();
    }
  }),
  'PullRequests.changes': () =>
    Stream.unwrap(PullRequestsService.use((svc) => Effect.succeed(svc.changes))),
  'PullRequests.setActiveView': ({ projectId, prPageOpen, activePrNumber }) =>
    PullRequestsService.use((svc) => svc.setActiveView({ projectId, prPageOpen, activePrNumber })),
  'PullRequests.getProjectState': ({ projectId }) =>
    PullRequestsService.use((svc) => svc.getProjectState(projectId)),
  'PullRequests.refreshProject': ({ projectId }) =>
    PullRequestsService.use((svc) => svc.refreshProject(projectId)),
  'PullRequests.lookupByNumber': ({ projectId, number }) =>
    PullRequestsService.use((svc) => svc.lookupByNumber(projectId, number)),
  'PullRequests.unpinNumber': ({ projectId, number }) =>
    PullRequestsService.use((svc) => svc.unpinNumber(projectId, number)),
  'PullRequests.getDetail': ({ projectId, number, bypassEtag }) =>
    PullRequestsService.use((svc) => svc.getDetail(projectId, number, bypassEtag)),
  'PullRequests.getDiff': ({ projectId, number }) =>
    PullRequestsService.use((svc) => svc.getDiff(projectId, number)),
  'PullRequests.prepareCreate': (input) =>
    PullRequestsService.use((svc) => svc.prepareCreate(input)),
  'PullRequests.draftCreate': (input) => PullRequestsService.use((svc) => svc.draftCreate(input)),
  'PullRequests.create': (input) => PullRequestsService.use((svc) => svc.create(input)),
  'PullRequests.merge': ({
    projectId,
    number,
    expectedHeadSha,
    method,
    commitTitle,
    commitMessage,
  }) =>
    PullRequestsService.use((svc) =>
      svc.merge({
        projectId,
        number,
        expectedHeadSha,
        method,
        ...(commitTitle !== undefined ? { commitTitle } : {}),
        ...(commitMessage !== undefined ? { commitMessage } : {}),
      }),
    ),
  'PullRequests.setAutoMerge': ({ projectId, number, enabled, method, expectedHeadSha }) =>
    PullRequestsService.use((svc) =>
      svc.setAutoMerge({
        projectId,
        number,
        enabled,
        ...(method !== undefined ? { method } : {}),
        ...(expectedHeadSha !== undefined ? { expectedHeadSha } : {}),
      }),
    ),
  'PullRequests.updateLocalBaseBranch': ({ projectId, baseRef }) =>
    PullRequestsService.use((svc) => svc.updateLocalBaseBranch(projectId, baseRef)),
  'PullRequests.switchToBaseBranch': ({ projectId, worktreePath, baseRef }) =>
    PullRequestsService.use((svc) => svc.switchToBaseBranch(projectId, worktreePath, baseRef)),
  'PullRequests.getPostMergeStatus': ({ projectId, baseRef, headRef }) =>
    PullRequestsService.use((svc) => svc.getPostMergeStatus(projectId, baseRef, headRef)),
  'PullRequests.update': (input) => PullRequestsService.use((svc) => svc.update(input)),
  'PullRequests.addComment': (input) => PullRequestsService.use((svc) => svc.addComment(input)),
  'PullRequests.editComment': (input) => PullRequestsService.use((svc) => svc.editComment(input)),
  'PullRequests.deleteComment': (input) =>
    PullRequestsService.use((svc) => svc.deleteComment(input)),
  'PullRequests.submitReview': (input) => PullRequestsService.use((svc) => svc.submitReview(input)),
  'PullRequests.deletePendingReview': (input) =>
    PullRequestsService.use((svc) => svc.deletePendingReview(input)),
  'PullRequests.resolveThread': (input) =>
    PullRequestsService.use((svc) => svc.resolveThread(input)),
  'PullRequests.unresolveThread': (input) =>
    PullRequestsService.use((svc) => svc.unresolveThread(input)),
});

/** Local-only Pull requests & HostAuth handlers wired to production `HostAuth` and `PullRequestsService`. */
export const layerPullRequestsHandlers = layerPullRequestsHandlersWith.pipe(
  Layer.provide(layerPullRequestsServiceMain),
);
