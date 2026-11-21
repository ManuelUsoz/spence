import { Effect, Layer, Option } from 'effect';
import { fakeEntry } from '../acp/acpFakes';
import { layerAgentLogs } from '../acp/acpAgentLog';
import { layerAcpClient } from '../acp/acpSessionManager';
import type { CatalogEntry } from '../agents/catalog';
import { layerAgentLifetime } from '../acp/acpLifetime';
import { layerAgents } from '../agents/agents';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects } from '../projects/projects';
import { layerRemembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { layerDeleteQueue } from './delete-queue';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessionStore } from './session-store';
import { layerSessions } from './sessions';

/**
 * Sessions as main composes them, over the Store in `root`, with the fake Agent (launched with `args`) as the
 * Sessions' Agent and a folder picker that answers `projectFolder`. One build is one run of the app: build it again
 * over the same `root` to restart. Exposes `Sessions`, `SessionStore`, `Projects`, `Settings`, `Remembered`, `AgentLifetime` and
 * `AcpClient`.
 */
export const layerSessionsWithFakeAgent = (options: {
  readonly root: string;
  readonly install: { readonly bin: string; readonly logs: string };
  readonly projectFolder: string;
  readonly args?: ReadonlyArray<string>;
  /** The disk Projects see; by default every folder exists as given. */
  readonly folders?: Layer.Layer<Folders>;
  /** The Catalog; the fake Agent alone by default. */
  readonly catalog?: ReadonlyArray<CatalogEntry>;
  /** The merged PATH Agents are found on; `install.bin` (the fake Agent) by default. */
  readonly path?: string;
}) => {
  const mergedPath = Layer.succeed(MergedPath, {
    get: Effect.succeed(options.path ?? options.install.bin),
  });
  const store = layerStore(options.root);
  const sessionStore = layerSessionStore.pipe(Layer.provide(store));
  const remembered = layerRemembered.pipe(Layer.provide(store));
  const projects = layerProjects.pipe(
    Layer.provide(sessionStore),
    Layer.provide(store),
    Layer.provide(
      options.folders ??
        Layer.succeed(Folders, {
          platform: process.platform,
          realPath: (folder) => Effect.succeed(Option.some(folder)),
          exists: () => Effect.succeed(true),
        }),
    ),
    Layer.provide(
      Layer.succeed(FolderPicker, { pick: Effect.succeed(Option.some(options.projectFolder)) }),
    ),
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
  const acpClient = layerAcpClient.pipe(
    Layer.provide(layerAgentLogs(options.install.logs)),
    Layer.provide(mergedPath),
    Layer.provide(layerPathSources),
  );
  const agents = layerAgents.pipe(Layer.provide(mergedPath), Layer.provide(layerPathSources));
  const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
  return layerSessions.pipe(
    Layer.provideMerge(projects),
    Layer.provideMerge(sessionStore),
    Layer.provideMerge(remembered),
    Layer.provideMerge(deleteQueue),
    Layer.provideMerge(settings),
    Layer.provide(agents),
    Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
    Layer.provide(
      Layer.succeed(AgentCatalog, makeAgentCatalog(options.catalog ?? [fakeEntry(options.args)])),
    ),
  );
};
