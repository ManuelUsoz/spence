import { Effect, Layer, Option } from 'effect';
import { fakeEntry, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { layerAgentLifetime } from '../acp/acpLifetime';
import { layerAgents } from '../agents/agents';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { layerReservationCoordinator } from '../source-control/reservation-coordinator';
import { layerWorktreesStub } from '../worktrees/worktrees';
import { layerDeleteQueue } from './delete-queue';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessionStore } from './session-store';
import { layerSessions } from './sessions';

/**
 * Sessions as main composes them, over the Store in `root`, with the fake Agent (launched with `args`) as the
 * Sessions' Agent and a folder picker that answers `projectFolder`. One build is one run of the app: build it again
 * over the same `root` to restart. Exposes `Sessions`, `SessionStore`, `Projects`, `Remembered`, `AgentLifetime` and
 * `AcpClient`.
 */
export const layerSessionsWithFakeAgent = (options: {
  readonly root: string;
  readonly install: { readonly bin: string; readonly logs: string };
  readonly projectFolder: string;
  readonly args?: ReadonlyArray<string>;
}) => {
  const store = layerStore(options.root);
  const sessionStore = layerSessionStore.pipe(Layer.provide(store));
  const remembered = layerRemembered.pipe(Layer.provide(store));
  const projects = layerProjects.pipe(
    Layer.provide(sessionStore),
    Layer.provide(store),
    Layer.provide(
      Layer.succeed(Folders, {
        platform: process.platform,
        realPath: (folder) => Effect.succeed(Option.some(folder)),
        exists: () => Effect.succeed(true),
      }),
    ),
    Layer.provide(
      Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(options.projectFolder)) }),
    ),
    Layer.provide(layerWorktreesStub),
  );
  const settings = layerSettings.pipe(
    Layer.provide(remembered),
    Layer.provide(
      Layer.succeed(WindowSettings, {
        applyTheme: () => Effect.void,
        applyLanguage: () => Effect.void,
      }),
    ),
    Layer.provide(store),
  );
  const acpClient = layerAcpClientWithFakeAgent(options.install);
  const agents = layerAgents.pipe(
    Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(options.install.bin) })),
    Layer.provide(layerPathSources),
  );
  const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
  return layerSessions.pipe(
    Layer.provideMerge(projects),
    Layer.provideMerge(sessionStore),
    Layer.provideMerge(remembered),
    Layer.provideMerge(deleteQueue),
    Layer.provide(settings),
    Layer.provide(agents),
    Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
    Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry(options.args)]))),
    Layer.provide(layerWorktreesStub),
    Layer.provideMerge(layerReservationCoordinator),
  );
};
