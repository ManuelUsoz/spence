import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Option, Stream } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type ProjectId } from '../../src/shared/projects/projects.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import {
  allTabLeaves,
  allTabPanels,
  allWorkspaceSessionIds,
} from '../../src/shared/tabs/workspace-layout';
import { fakeEntry, installFakeAgent, layerAcpClientWithFakeAgent } from '../acp/acpFakes';
import { layerAgentLifetime } from '../acp/acpLifetime';
import { layerAgents } from '../agents/agents';
import { layerPathSources, MergedPath } from '../agents/merged-path';
import { makeFakeBrowserHost } from '../browser/browser-host-fake';
import { layerBrowserService } from '../browser/browser-service';
import { FolderPicker, Folders } from '../projects/folders';
import { layerProjects, Projects } from '../projects/projects';
import { layerRemembered, Remembered } from '../settings/remembered';
import { layerSettings, WindowSettings } from '../settings/settings';
import { layerStore } from '../store/store';
import { layerDeleteQueue } from './delete-queue';
import { layerSessionStore } from './session-store';
import { AgentCatalog, makeAgentCatalog } from './session-agent';
import { layerSessions, Sessions } from './sessions';
import {
  TIMEOUT,
  PROJECT_FOLDER,
  text,
  untilTurnEnd,
  events,
  withTwoProjects,
} from './sessions-spec-fakes';

describe('Per-Project Tab workspace persistence and migration', () => {
  const buildOnRoot = (
    root: string,
    install: { readonly bin: string; readonly logs: string },
    folders: ReadonlyArray<string>,
  ) => {
    let pickIndex = 0;
    const store = layerStore(root);
    const sessionStore = layerSessionStore.pipe(Layer.provide(store));
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
        Layer.succeed(FolderPicker, {
          pick: Effect.sync(() => {
            const folder = folders[pickIndex] ?? folders[0];
            pickIndex += 1;
            return folder === undefined ? Option.none() : Option.some(folder);
          }),
        }),
      ),
    );
    const remembered = layerRemembered.pipe(Layer.provide(store));
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
    const acpClient = layerAcpClientWithFakeAgent(install);
    const agentsLayer = layerAgents.pipe(
      Layer.provide(Layer.succeed(MergedPath, { get: Effect.succeed(install.bin) })),
      Layer.provide(layerPathSources),
    );
    const deleteQueue = layerDeleteQueue.pipe(Layer.provide(Layer.mergeAll(store, acpClient)));
    return layerSessions.pipe(
      Layer.provideMerge(projects),
      Layer.provideMerge(sessionStore),
      Layer.provideMerge(remembered),
      Layer.provideMerge(deleteQueue),
      Layer.provideMerge(store),
      Layer.provideMerge(settings),
      Layer.provide(agentsLayer),
      Layer.provideMerge(layerAgentLifetime.pipe(Layer.provideMerge(acpClient))),
      Layer.provide(
        layerBrowserService.pipe(
          Layer.provide(makeFakeBrowserHost().layer),
          Layer.provide(settings),
        ),
      ),
      Layer.provide(Layer.succeed(AgentCatalog, makeAgentCatalog([fakeEntry()]))),
    );
  };

  it.live(
    'persists per-Project Tabs and custom titles across restart while dropping unprompted drafts on restart',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-persist-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const dirB = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-proj-b-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [PROJECT_FOLDER, dirB];

        const { p1, p2, s1, s2, draft } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const p1 = (yield* projects.add)!.id;
          const p2 = (yield* projects.add)!.id;

          const s1 = yield* sessions.create(p1);
          yield* sessions.prompt(s1, text('echo:one'));
          yield* untilTurnEnd(events(s1));

          const draft = yield* sessions.create(p1);

          const s2 = yield* sessions.create(p2);
          yield* sessions.prompt(s2, text('echo:two'));
          yield* untilTurnEnd(events(s2));

          const tab1 = TabId.make('t1');
          const tabDraft = TabId.make('t-draft');
          const tab2 = TabId.make('t2');
          const workspace: WorkspaceState = {
            activeProjectId: p2,
            projects: [
              {
                projectId: p1,
                activeTabId: tabDraft,
                tabs: [
                  {
                    id: tab1,
                    customTitle: 'Main work',
                    focusedPanelId: PanelId.make('pan-1'),
                    layout: {
                      rootPaneId: PaneId.make('pane-1'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-1'),
                          panels: [
                            {
                              id: PanelId.make('pan-1'),
                              spec: { _tag: 'Session', sessionId: s1 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    id: tabDraft,
                    focusedPanelId: PanelId.make('pan-draft'),
                    layout: {
                      rootPaneId: PaneId.make('pane-draft'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-draft'),
                          panels: [
                            {
                              id: PanelId.make('pan-draft'),
                              spec: { _tag: 'Session', sessionId: draft, draft: true },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
              {
                projectId: p2,
                activeTabId: tab2,
                tabs: [
                  {
                    id: tab2,
                    focusedPanelId: PanelId.make('pan-2'),
                    layout: {
                      rootPaneId: PaneId.make('pane-2'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-2'),
                          panels: [
                            {
                              id: PanelId.make('pan-2'),
                              spec: { _tag: 'Session', sessionId: s2 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };

          yield* sessions.setTabs(workspace);

          // In-process reload preserves the live draft AND protects all open Sessions from auto-archive.
          const protectedIds = yield* sessions.protectedFromAutoArchive;
          expect(protectedIds).toEqual(new Set([s1, s2, draft]));

          const sameProcess = yield* sessions.restoreTabs;
          expect([...allWorkspaceSessionIds(sameProcess.workspace)].sort()).toEqual(
            [s1, s2, draft].sort(),
          );
          expect(
            sameProcess.workspace.projects[0]?.tabs[1]?.layout.nodes[0]?._tag === 'Leaf'
              ? sameProcess.workspace.projects[0]?.tabs[1]?.layout.nodes[0]?.panels[0]?.spec
              : undefined,
          ).toEqual({ _tag: 'Session', sessionId: draft, draft: true });

          return { p1, p2, s1, s2, draft };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Cold restart: draft is absent, kept Tabs and customTitle for p1 and p2 restore cleanly.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const restored = yield* sessions.restoreTabs;
          expect(restored.workspace.activeProjectId).toBe(p2);
          expect(restored.workspace.projects).toHaveLength(2);
          expect([...allWorkspaceSessionIds(restored.workspace)].sort()).toEqual([s1, s2].sort());
          expect(allWorkspaceSessionIds(restored.workspace).has(draft)).toBe(false);
          expect(restored.workspace.projects[0]?.projectId).toBe(p1);
          expect(restored.workspace.projects[0]?.tabs[0]?.customTitle).toBe('Main work');
          expect(restored.workspace.projects[0]?.activeTabId).toBe(TabId.make('t1'));
          expect(restored.workspace.projects[1]?.projectId).toBe(p2);
          expect(restored.sessions.map((s) => s.id).sort()).toEqual([s1, s2].sort());
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'migrates v1 state.json legacy tabs to per-Project WorkspaceState once on cold restore',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-migrate-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const dirB = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-migrate-b-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [PROJECT_FOLDER, dirB];

        const { p1, p2, s1, s2, s3 } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const p1 = (yield* projects.add)!.id;
          const p2 = (yield* projects.add)!.id;

          const s1 = yield* sessions.create(p1);
          yield* sessions.prompt(s1, text('echo:one'));
          yield* untilTurnEnd(events(s1));

          const s2 = yield* sessions.create(p2);
          yield* sessions.prompt(s2, text('echo:two'));
          yield* untilTurnEnd(events(s2));

          const s3 = yield* sessions.create(p1);
          yield* sessions.prompt(s3, text('echo:three'));
          yield* untilTurnEnd(events(s3));

          return { p1, p2, s1, s2, s3 };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Write a v1 state.json with flat legacy tabs including a missing session ID.
        const missingId = SessionId.make('missing-session');
        yield* Effect.promise(() =>
          writeFile(
            path.join(root, 'state.json'),
            JSON.stringify({
              version: 1,
              agents: {},
              tabs: { open: [s1, s2, missingId, s3], active: s2 },
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const remembered = yield* Remembered;
          const restored = yield* sessions.restoreTabs;

          expect(restored.workspace.activeProjectId).toBe(p2);
          expect(restored.workspace.projects).toHaveLength(2);
          const proj1 = restored.workspace.projects.find((p) => p.projectId === p1);
          const proj2 = restored.workspace.projects.find((p) => p.projectId === p2);
          expect(proj1?.tabs.flatMap((t) => allTabPanels(t).map((p) => p.spec.sessionId))).toEqual([
            s1,
            s3,
          ]);
          expect(proj2?.tabs.flatMap((t) => allTabPanels(t).map((p) => p.spec.sessionId))).toEqual([
            s2,
          ]);
          expect(proj2?.activeTabId).toBe(proj2?.tabs[0]?.id);
          expect(proj1?.activeTabId).toBe(proj1?.tabs[0]?.id);

          // Migration persisted v2 workspace and cleared legacyTabs.
          expect(yield* remembered.legacyTabs).toBeUndefined();
          expect(yield* remembered.workspace).toEqual(restored.workspace);
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'immediately prunes deleted Sessions, sessionWallpapers, and removed Projects from live & persisted workspace',
    () =>
      withTwoProjects((p1, p2) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const projects = yield* Projects;
          const remembered = yield* Remembered;

          const s1 = yield* sessions.create(p1);
          yield* sessions.prompt(s1, text('echo:p1'));
          yield* untilTurnEnd(events(s1));

          const s2 = yield* sessions.create(p2);
          yield* sessions.prompt(s2, text('echo:p2'));
          yield* untilTurnEnd(events(s2));

          const tabP1 = TabId.make('tab-p1');
          const tabP2 = TabId.make('tab-p2');
          const workspace: WorkspaceState = {
            activeProjectId: p1,
            sessionWallpapers: {
              [s1]: 'cobalt-halftone',
              [s2]: 'amber-halftone',
            },
            projects: [
              {
                projectId: p1,
                activeTabId: tabP1,
                tabs: [
                  {
                    id: tabP1,
                    focusedPanelId: PanelId.make('panel-s1'),
                    layout: {
                      rootPaneId: PaneId.make('pane-p1'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-p1'),
                          panels: [
                            {
                              id: PanelId.make('panel-s1'),
                              spec: { _tag: 'Session', sessionId: s1 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
              {
                projectId: p2,
                activeTabId: tabP2,
                tabs: [
                  {
                    id: tabP2,
                    focusedPanelId: PanelId.make('panel-s2'),
                    layout: {
                      rootPaneId: PaneId.make('pane-p2'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-p2'),
                          panels: [
                            {
                              id: PanelId.make('panel-s2'),
                              spec: { _tag: 'Session', sessionId: s2 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };

          yield* sessions.setTabs(workspace);

          // Deleting s1 removes its Session panel, collapsing tabP1 and p1, and drops s1's wallpaper entry.
          yield* sessions.remove(s1);
          const afterRemove = yield* sessions.restoreTabs;
          expect(afterRemove.workspace.projects.map((p) => p.projectId)).toEqual([p2]);
          expect(afterRemove.workspace.sessionWallpapers).toEqual({ [s2]: 'amber-halftone' });
          expect((yield* remembered.workspace)?.projects.map((p) => p.projectId)).toEqual([p2]);

          // Removing p2 via Projects.remove + Sessions.cancelProject prunes p2 immediately while keeping activeProjectId p1.
          yield* projects.remove(p2);
          yield* sessions.cancelProject(p2);
          const afterCancelP2 = yield* sessions.restoreTabs;
          expect(afterCancelP2.workspace.projects).toEqual([]);
          expect(afterCancelP2.workspace.activeProjectId).toBe(p1);
          expect((yield* remembered.workspace)?.projects).toEqual([]);

          // Removing the active Project p1 clears activeProjectId as well.
          yield* projects.remove(p1);
          yield* sessions.cancelProject(p1);
          const afterCancelP1 = yield* sessions.restoreTabs;
          expect(afterCancelP1.workspace.activeProjectId).toBeUndefined();
          expect((yield* remembered.workspace)?.activeProjectId).toBeUndefined();
        }),
      ),
    TIMEOUT,
  );

  it.live(
    'persists and restores split Session Panes and sessionWallpapers across cold restart and prunes on Session delete',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-aux-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const dir = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-aux-proj-'))),
          (d) => Effect.promise(() => rm(d, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [dir];

        const { p1, s1, s2 } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const added = (yield* projects.add)!;
          const first = yield* sessions.create(added.id);
          yield* sessions.prompt(first, text('echo:one'));
          yield* untilTurnEnd(events(first));
          const second = yield* sessions.create(added.id);
          yield* sessions.prompt(second, text('echo:two'));
          yield* untilTurnEnd(events(second));

          const tabId = TabId.make('t-split');
          const splitId = PaneId.make('split-aux');
          const paneFirst = PaneId.make('pane-s1');
          const paneSecond = PaneId.make('pane-s2');
          const workspace: WorkspaceState = {
            activeProjectId: added.id,
            sessionWallpapers: {
              [first]: 'cobalt-halftone',
              [second]: 'emerald-halftone',
            },
            projects: [
              {
                projectId: added.id,
                activeTabId: tabId,
                tabs: [
                  {
                    id: tabId,
                    focusedPanelId: PanelId.make('pan-s1'),
                    layout: {
                      rootPaneId: splitId,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitId,
                          direction: 'horizontal',
                          ratio: 0.5,
                          first: paneFirst,
                          second: paneSecond,
                        },
                        {
                          _tag: 'Leaf',
                          id: paneFirst,
                          panels: [
                            {
                              id: PanelId.make('pan-s1'),
                              spec: { _tag: 'Session', sessionId: first },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: paneSecond,
                          panels: [
                            {
                              id: PanelId.make('pan-s2'),
                              spec: { _tag: 'Session', sessionId: second },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };
          yield* sessions.setTabs(workspace);
          return { p1: added.id, s1: first, s2: second };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Cold restart: split Panes and per-session wallpapers restore cleanly.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const remembered = yield* Remembered;
          const restored = yield* sessions.restoreTabs;
          const tab = restored.workspace.projects[0]?.tabs[0];
          expect(tab).toBeDefined();
          expect(allTabPanels(tab!).map((p) => p.spec)).toEqual([
            { _tag: 'Session', sessionId: s1 },
            { _tag: 'Session', sessionId: s2 },
          ]);
          expect(restored.workspace.sessionWallpapers).toEqual({
            [s1]: 'cobalt-halftone',
            [s2]: 'emerald-halftone',
          });

          // Deleting s1 prunes paneFirst and removes s1 from sessionWallpapers in live and disk state.
          yield* sessions.remove(s1);
          const afterDeleteLive = yield* sessions.restoreTabs;
          const afterDeleteDisk = yield* remembered.workspace;
          for (const ws of [afterDeleteLive.workspace, afterDeleteDisk]) {
            const t = ws?.projects[0]?.tabs[0];
            expect(t).toBeDefined();
            expect(allTabLeaves(t!)).toHaveLength(1);
            expect(allTabPanels(t!).map((p) => p.spec)).toEqual([
              { _tag: 'Session', sessionId: s2 },
            ]);
            expect(ws?.sessionWallpapers).toEqual({ [s2]: 'emerald-halftone' });
          }
          expect(restored.workspace.projects[0]?.projectId).toBe(p1);
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'activates only visible Session Panels in the active Project active Tab until switched',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-visible-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const dirB = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-vis-b-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [PROJECT_FOLDER, dirB];

        const { p1, p2, sVisible, sInactiveTab, sBackground } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const p1 = (yield* projects.add)!.id;
          const p2 = (yield* projects.add)!.id;

          const sVisible = yield* sessions.create(p1);
          yield* sessions.prompt(sVisible, text('echo:visible'));
          yield* untilTurnEnd(events(sVisible));

          const sInactiveTab = yield* sessions.create(p1);
          yield* sessions.prompt(sInactiveTab, text('echo:inactive'));
          yield* untilTurnEnd(events(sInactiveTab));

          const sBackground = yield* sessions.create(p2);
          yield* sessions.prompt(sBackground, text('echo:bg'));
          yield* untilTurnEnd(events(sBackground));

          return { p1, p2, sVisible, sInactiveTab, sBackground };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Fresh process: restore & apply workspace with 2 tabs in p1 and 1 in background p2.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const tab1 = TabId.make('t1');
          const tab1b = TabId.make('t1b');
          const tab2 = TabId.make('t2');
          const makeWs = (activeProjectId: ProjectId, activeTabP1: TabId): WorkspaceState => ({
            activeProjectId,
            projects: [
              {
                projectId: p1,
                activeTabId: activeTabP1,
                tabs: [
                  {
                    id: tab1,
                    focusedPanelId: PanelId.make('p-vis'),
                    layout: {
                      rootPaneId: PaneId.make('pane-1'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-1'),
                          panels: [
                            {
                              id: PanelId.make('p-vis'),
                              spec: { _tag: 'Session', sessionId: sVisible },
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    id: tab1b,
                    focusedPanelId: PanelId.make('p-inact'),
                    layout: {
                      rootPaneId: PaneId.make('pane-1b'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-1b'),
                          panels: [
                            {
                              id: PanelId.make('p-inact'),
                              spec: { _tag: 'Session', sessionId: sInactiveTab },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
              {
                projectId: p2,
                activeTabId: tab2,
                tabs: [
                  {
                    id: tab2,
                    focusedPanelId: PanelId.make('p-bg'),
                    layout: {
                      rootPaneId: PaneId.make('pane-2'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-2'),
                          panels: [
                            {
                              id: PanelId.make('p-bg'),
                              spec: { _tag: 'Session', sessionId: sBackground },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          });

          const watchActivation = Effect.fnUntraced(function* (id: SessionId) {
            const subscribed = yield* Deferred.make<void>();
            const started = yield* Deferred.make<void>();
            const ready = yield* Deferred.make<void>();
            let seenInitial = false;
            let sawStarting = false;
            yield* events(id).pipe(
              Stream.runForEach((item) =>
                Effect.gen(function* () {
                  if (item._tag !== 'Live') return;
                  if (!seenInitial) {
                    seenInitial = true;
                    yield* Deferred.succeed(subscribed, undefined);
                    return;
                  }
                  if (item.state.agentStatus === 'starting') {
                    sawStarting = true;
                    yield* Deferred.succeed(started, undefined);
                  } else if (sawStarting && item.state.agentStatus === 'ready') {
                    yield* Deferred.succeed(ready, undefined);
                  }
                }),
              ),
              Effect.forkScoped,
            );
            yield* Deferred.await(subscribed);
            return { started, ready };
          });

          const visibleWatch = yield* watchActivation(sVisible);
          const inactiveTabWatch = yield* watchActivation(sInactiveTab);
          const bgWatch = yield* watchActivation(sBackground);

          yield* sessions.setTabs(makeWs(p1, tab1));
          yield* Deferred.await(visibleWatch.started);
          yield* Deferred.await(visibleWatch.ready);

          expect(yield* Deferred.isDone(inactiveTabWatch.started)).toBe(false);
          expect(yield* Deferred.isDone(bgWatch.started)).toBe(false);

          // Switching active Project to p2 activates p2's active Session Panel.
          yield* sessions.setTabs(makeWs(p2, tab1));
          yield* Deferred.await(bgWatch.started);
          yield* Deferred.await(bgWatch.ready);
          expect(yield* Deferred.isDone(inactiveTabWatch.started)).toBe(false);

          // Switching back to p1 with tab1b active activates sInactiveTab.
          yield* sessions.setTabs(makeWs(p1, tab1b));
          yield* Deferred.await(inactiveTabWatch.started);
          yield* Deferred.await(inactiveTabWatch.ready);
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }),
    TIMEOUT,
  );

  it.live(
    'persists sessionWallpapers across cold restart (dropping draft entries) and prunes them cleanly on Session delete',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-wp-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [PROJECT_FOLDER];

        const tabId = TabId.make('tab-wp');
        const splitA = PaneId.make('split-a');
        const splitB = PaneId.make('split-b');
        const pane1 = PaneId.make('pane-wp-1');
        const pane2 = PaneId.make('pane-wp-2');
        const pane3 = PaneId.make('pane-wp-3');
        const panel1 = PanelId.make('panel-1');
        const panel2 = PanelId.make('panel-2');
        const panel3 = PanelId.make('panel-3');
        const panelDraft = PanelId.make('panel-draft');

        const { p1, s1, s2, s3 } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const p1 = (yield* projects.add)!.id;

          const s1 = yield* sessions.create(p1);
          yield* sessions.prompt(s1, text('echo:one'));
          yield* untilTurnEnd(events(s1));

          const s2 = yield* sessions.create(p1);
          yield* sessions.prompt(s2, text('echo:two'));
          yield* untilTurnEnd(events(s2));

          const s3 = yield* sessions.create(p1);
          yield* sessions.prompt(s3, text('echo:three'));
          yield* untilTurnEnd(events(s3));

          const draft = yield* sessions.create(p1);

          const workspace: WorkspaceState = {
            activeProjectId: p1,
            sessionWallpapers: {
              [s1]: 'cobalt-halftone',
              [s2]: 'amber-halftone',
              [s3]: 'emerald-halftone',
              [draft]: 'rose-halftone',
            },
            projects: [
              {
                projectId: p1,
                activeTabId: tabId,
                tabs: [
                  {
                    id: tabId,
                    focusedPanelId: panel3,
                    layout: {
                      rootPaneId: splitA,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitA,
                          direction: 'horizontal',
                          ratio: 0.4,
                          first: pane1,
                          second: splitB,
                        },
                        {
                          _tag: 'Split',
                          id: splitB,
                          direction: 'vertical',
                          ratio: 0.5,
                          first: pane2,
                          second: pane3,
                        },
                        {
                          _tag: 'Leaf',
                          id: pane1,
                          panels: [{ id: panel1, spec: { _tag: 'Session', sessionId: s1 } }],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane2,
                          panels: [{ id: panel2, spec: { _tag: 'Session', sessionId: s2 } }],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane3,
                          panels: [{ id: panel3, spec: { _tag: 'Session', sessionId: s3 } }],
                        },
                      ],
                    },
                  },
                  {
                    id: TabId.make('tab-draft'),
                    focusedPanelId: panelDraft,
                    layout: {
                      rootPaneId: PaneId.make('pane-draft'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-draft'),
                          panels: [
                            {
                              id: panelDraft,
                              spec: { _tag: 'Session', sessionId: draft, draft: true },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };

          yield* sessions.setTabs(workspace);
          return { p1, s1, s2, s3 };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Cold restart: draft & its wallpaper dropped; real wallpapers & split layout restored cleanly.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const remembered = yield* Remembered;
          const restored = yield* sessions.restoreTabs;
          expect(restored.workspace.projects[0]?.projectId).toBe(p1);
          const restoredTab = restored.workspace.projects[0]?.tabs[0];
          expect(restoredTab?.id).toBe(tabId);
          expect(allTabPanels(restoredTab!).map((p) => p.spec.sessionId)).toEqual([s1, s2, s3]);
          expect(restored.workspace.sessionWallpapers).toEqual({
            [s1]: 'cobalt-halftone',
            [s2]: 'amber-halftone',
            [s3]: 'emerald-halftone',
          });

          // Deleting s2 removes pane2 and s2's wallpaper in both live & disk state.
          yield* sessions.remove(s2);
          const afterRemove = yield* sessions.restoreTabs;
          expect(
            allTabPanels(afterRemove.workspace.projects[0]!.tabs[0]!).map((p) => p.spec.sessionId),
          ).toEqual([s1, s3]);
          expect(afterRemove.workspace.sessionWallpapers).toEqual({
            [s1]: 'cobalt-halftone',
            [s3]: 'emerald-halftone',
          });
          expect((yield* remembered.workspace)?.sessionWallpapers).toEqual({
            [s1]: 'cobalt-halftone',
            [s3]: 'emerald-halftone',
          });
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Second cold restart confirms pruned wallpapers and split survived on disk.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const restored = yield* sessions.restoreTabs;
          const tab = restored.workspace.projects[0]?.tabs[0];
          expect(allTabPanels(tab!).map((p) => p.spec.sessionId)).toEqual([s1, s3]);
          expect(restored.workspace.sessionWallpapers).toEqual({
            [s1]: 'cobalt-halftone',
            [s3]: 'emerald-halftone',
          });
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'persists nested horizontal & vertical binary split trees and split ratios per Project across restart, collapsing draft split Panes on disk',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-splits-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const dirB = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ws-splits-b-'))),
          (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
        );
        const install = yield* installFakeAgent;
        const folders = [PROJECT_FOLDER, dirB];

        const splitRoot = PaneId.make('split-root');
        const splitRight = PaneId.make('split-right');
        const splitDraft = PaneId.make('split-draft');
        const splitP2 = PaneId.make('split-p2');
        const pane1 = PaneId.make('pane-1');
        const pane2 = PaneId.make('pane-2');
        const pane3 = PaneId.make('pane-3');
        const pane4 = PaneId.make('pane-4');
        const paneDraft = PaneId.make('pane-draft');
        const pane5 = PaneId.make('pane-5');
        const pane6 = PaneId.make('pane-6');
        const tab1 = TabId.make('t1');
        const tab2 = TabId.make('t2');
        const tabP2 = TabId.make('t-p2');

        const { p1, p2, s1, s2, s3, s4, s5, s6 } = yield* Effect.gen(function* () {
          const projects = yield* Projects;
          const sessions = yield* Sessions;
          const p1 = (yield* projects.add)!.id;
          const p2 = (yield* projects.add)!.id;

          const makeKept = (projectId: ProjectId, msg: string) =>
            Effect.gen(function* () {
              const id = yield* sessions.create(projectId);
              yield* sessions.prompt(id, text(msg));
              yield* untilTurnEnd(events(id));
              return id;
            });

          const s1 = yield* makeKept(p1, 'echo:one');
          const s2 = yield* makeKept(p1, 'echo:two');
          const s3 = yield* makeKept(p1, 'echo:three');
          const s4 = yield* makeKept(p1, 'echo:four');
          const draft = yield* sessions.create(p1);
          const s5 = yield* makeKept(p2, 'echo:five');
          const s6 = yield* makeKept(p2, 'echo:six');

          const workspace: WorkspaceState = {
            activeProjectId: p1,
            projects: [
              {
                projectId: p1,
                activeTabId: tab1,
                tabs: [
                  {
                    id: tab1,
                    focusedPanelId: PanelId.make('pan-2'),
                    layout: {
                      rootPaneId: splitRoot,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitRoot,
                          direction: 'horizontal',
                          ratio: 0.35,
                          first: pane1,
                          second: splitRight,
                        },
                        {
                          _tag: 'Split',
                          id: splitRight,
                          direction: 'vertical',
                          ratio: 0.62,
                          first: pane2,
                          second: pane3,
                        },
                        {
                          _tag: 'Leaf',
                          id: pane1,
                          panels: [
                            {
                              id: PanelId.make('pan-1'),
                              spec: { _tag: 'Session', sessionId: s1 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane2,
                          panels: [
                            {
                              id: PanelId.make('pan-2'),
                              spec: { _tag: 'Session', sessionId: s2 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane3,
                          panels: [
                            {
                              id: PanelId.make('pan-3'),
                              spec: { _tag: 'Session', sessionId: s3 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                  {
                    id: tab2,
                    focusedPanelId: PanelId.make('pan-draft'),
                    layout: {
                      rootPaneId: splitDraft,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitDraft,
                          direction: 'horizontal',
                          ratio: 0.4,
                          first: pane4,
                          second: paneDraft,
                        },
                        {
                          _tag: 'Leaf',
                          id: pane4,
                          panels: [
                            {
                              id: PanelId.make('pan-4'),
                              spec: { _tag: 'Session', sessionId: s4 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: paneDraft,
                          panels: [
                            {
                              id: PanelId.make('pan-draft'),
                              spec: { _tag: 'Session', sessionId: draft, draft: true },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
              {
                projectId: p2,
                activeTabId: tabP2,
                tabs: [
                  {
                    id: tabP2,
                    focusedPanelId: PanelId.make('pan-5'),
                    layout: {
                      rootPaneId: splitP2,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitP2,
                          direction: 'vertical',
                          ratio: 0.72,
                          first: pane5,
                          second: pane6,
                        },
                        {
                          _tag: 'Leaf',
                          id: pane5,
                          panels: [
                            {
                              id: PanelId.make('pan-5'),
                              spec: { _tag: 'Session', sessionId: s5 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane6,
                          panels: [
                            {
                              id: PanelId.make('pan-6'),
                              spec: { _tag: 'Session', sessionId: s6 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };

          yield* sessions.setTabs(workspace);
          return { p1, p2, s1, s2, s3, s4, s5, s6 };
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);

        // Cold restart: split trees and ratios restore per Project; draft Pane collapses cleanly.
        yield* Effect.gen(function* () {
          const sessions = yield* Sessions;
          const restored = yield* sessions.restoreTabs;
          expect(restored.workspace.activeProjectId).toBe(p1);

          const proj1 = restored.workspace.projects.find((p) => p.projectId === p1)!;
          const restoredTab1 = proj1.tabs.find((t) => t.id === tab1)!;
          expect(restoredTab1.layout.rootPaneId).toBe(splitRoot);
          expect(restoredTab1.layout.nodes.find((n) => n.id === splitRoot)).toEqual({
            _tag: 'Split',
            id: splitRoot,
            direction: 'horizontal',
            ratio: 0.35,
            first: pane1,
            second: splitRight,
          });
          expect(restoredTab1.layout.nodes.find((n) => n.id === splitRight)).toEqual({
            _tag: 'Split',
            id: splitRight,
            direction: 'vertical',
            ratio: 0.62,
            first: pane2,
            second: pane3,
          });
          expect(allTabLeaves(restoredTab1).map((l) => l.panels[0]?.spec.sessionId)).toEqual([
            s1,
            s2,
            s3,
          ]);

          const restoredTab2 = proj1.tabs.find((t) => t.id === tab2)!;
          expect(restoredTab2.layout.rootPaneId).toBe(pane4);
          expect(allTabLeaves(restoredTab2).map((l) => l.panels[0]?.spec.sessionId)).toEqual([s4]);
          expect(restoredTab2.focusedPanelId).toBe(PanelId.make('pan-4'));

          const proj2 = restored.workspace.projects.find((p) => p.projectId === p2)!;
          const restoredTabP2 = proj2.tabs[0]!;
          expect(restoredTabP2.layout.rootPaneId).toBe(splitP2);
          expect(restoredTabP2.layout.nodes.find((n) => n.id === splitP2)).toEqual({
            _tag: 'Split',
            id: splitP2,
            direction: 'vertical',
            ratio: 0.72,
            first: pane5,
            second: pane6,
          });
          expect(allTabLeaves(restoredTabP2).map((l) => l.panels[0]?.spec.sessionId)).toEqual([
            s5,
            s6,
          ]);
        }).pipe(Effect.provide(buildOnRoot(root, install, folders)), Effect.scoped);
      }).pipe(Effect.scoped),
    TIMEOUT,
  );

  it.live(
    'prunes a deleted Session from a nested binary split tree, collapsing empty Panes and Tabs live & on disk',
    () =>
      withTwoProjects((p1) =>
        Effect.gen(function* () {
          const sessions = yield* Sessions;
          const remembered = yield* Remembered;

          const makeKept = (msg: string) =>
            Effect.gen(function* () {
              const id = yield* sessions.create(p1);
              yield* sessions.prompt(id, text(msg));
              yield* untilTurnEnd(events(id));
              return id;
            });

          const s1 = yield* makeKept('echo:one');
          const s2 = yield* makeKept('echo:two');
          const s3 = yield* makeKept('echo:three');

          const splitRoot = PaneId.make('split-root');
          const splitRight = PaneId.make('split-right');
          const pane1 = PaneId.make('pane-1');
          const pane2 = PaneId.make('pane-2');
          const pane3 = PaneId.make('pane-3');
          const tab1 = TabId.make('t-split-del');

          const workspace: WorkspaceState = {
            activeProjectId: p1,
            projects: [
              {
                projectId: p1,
                activeTabId: tab1,
                tabs: [
                  {
                    id: tab1,
                    focusedPanelId: PanelId.make('pan-2'),
                    layout: {
                      rootPaneId: splitRoot,
                      nodes: [
                        {
                          _tag: 'Split',
                          id: splitRoot,
                          direction: 'horizontal',
                          ratio: 0.38,
                          first: pane1,
                          second: splitRight,
                        },
                        {
                          _tag: 'Split',
                          id: splitRight,
                          direction: 'vertical',
                          ratio: 0.65,
                          first: pane2,
                          second: pane3,
                        },
                        {
                          _tag: 'Leaf',
                          id: pane1,
                          panels: [
                            {
                              id: PanelId.make('pan-1'),
                              spec: { _tag: 'Session', sessionId: s1 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane2,
                          panels: [
                            {
                              id: PanelId.make('pan-2'),
                              spec: { _tag: 'Session', sessionId: s2 },
                            },
                          ],
                        },
                        {
                          _tag: 'Leaf',
                          id: pane3,
                          panels: [
                            {
                              id: PanelId.make('pan-3'),
                              spec: { _tag: 'Session', sessionId: s3 },
                            },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          };

          yield* sessions.setTabs(workspace);

          // Deleting s2 collapses splitRight away, promotes pane3 into splitRoot.second, preserves ratio 0.38.
          yield* sessions.remove(s2);
          const afterS2Live = (yield* sessions.restoreTabs).workspace.projects[0]!.tabs[0]!;
          const afterS2Disk = (yield* remembered.workspace)!.projects[0]!.tabs[0]!;
          for (const tab of [afterS2Live, afterS2Disk]) {
            expect(tab.layout.rootPaneId).toBe(splitRoot);
            expect(tab.layout.nodes.find((n) => n.id === splitRoot)).toEqual({
              _tag: 'Split',
              id: splitRoot,
              direction: 'horizontal',
              ratio: 0.38,
              first: pane1,
              second: pane3,
            });
            expect(allTabLeaves(tab).map((l) => l.id)).toEqual([pane1, pane3]);
          }

          // Deleting s3 collapses splitRoot away and promotes pane1 to root.
          yield* sessions.remove(s3);
          const afterS3Live = (yield* sessions.restoreTabs).workspace.projects[0]!.tabs[0]!;
          const afterS3Disk = (yield* remembered.workspace)!.projects[0]!.tabs[0]!;
          for (const tab of [afterS3Live, afterS3Disk]) {
            expect(tab.layout.rootPaneId).toBe(pane1);
            expect(allTabLeaves(tab).map((l) => l.id)).toEqual([pane1]);
          }

          // Deleting s1 collapses the now-empty Tab away live and on disk.
          yield* sessions.remove(s1);
          expect((yield* sessions.restoreTabs).workspace.projects).toEqual([]);
          expect((yield* remembered.workspace)?.projects).toEqual([]);
        }),
      ),
    TIMEOUT,
  );
});
