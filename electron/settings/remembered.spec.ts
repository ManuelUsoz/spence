import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { PaneId, PanelId, TabId, type WorkspaceState } from '../../src/shared/tabs/tabs.rpc';
import { layerStore } from '../store/store';
import { layerRemembered, Remembered } from './remembered';

const withRemembered = <A, E>(
  body: (ctx: { readonly root: string }) => Effect.Effect<A, E, Remembered>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-remembered-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const layer = layerRemembered.pipe(Layer.provide(layerStore(root)));
    return yield* body({ root }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped);

const putState = (root: string, json: unknown) =>
  Effect.promise(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'state.json'), JSON.stringify(json));
  });

const readState = (root: string) =>
  Effect.promise(async (): Promise<unknown> =>
    JSON.parse(await readFile(path.join(root, 'state.json'), 'utf8')),
  );

describe('Remembered', () => {
  it.effect('starts empty and persists WorkspaceState at state.json version 3', () =>
    withRemembered(({ root }) =>
      Effect.gen(function* () {
        const remembered = yield* Remembered;
        expect(yield* remembered.workspace).toBeUndefined();
        expect(yield* remembered.legacyTabs).toBeUndefined();

        const p1 = ProjectId.make('p1');
        const workspace: WorkspaceState = {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: TabId.make('t1'),
              tabs: [
                {
                  id: TabId.make('t1'),
                  customTitle: 'Backend API',
                  focusedPanelId: PanelId.make('panel-1'),
                  layout: {
                    rootPaneId: PaneId.make('pane-1'),
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: PaneId.make('pane-1'),
                        panels: [
                          {
                            id: PanelId.make('panel-1'),
                            spec: { _tag: 'Session', sessionId: SessionId.make('s1') },
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

        yield* remembered.rememberWorkspace(workspace);
        expect(yield* remembered.workspace).toEqual(workspace);
        expect(yield* readState(root)).toMatchObject({
          version: 3,
          workspace,
        });
      }),
    ),
  );

  it.effect(
    'migrates v1 state.json tabs to legacyTabs while preserving agents/lastAgent, then clears legacyTabs on rememberWorkspace',
    () =>
      withRemembered(({ root }) =>
        Effect.gen(function* () {
          const claude = AgentId.make('claude');
          const s1 = SessionId.make('s1');
          const s2 = SessionId.make('s2');
          yield* putState(root, {
            version: 1,
            agents: { [claude]: { lastModel: 'opus', lastEffort: 'high' } },
            lastAgent: claude,
            tabs: { open: [s1, s2], active: s2 },
          });

          const remembered = yield* Remembered;
          expect(yield* remembered.legacyTabs).toEqual({ open: [s1, s2], active: s2 });
          expect(yield* remembered.workspace).toBeUndefined();
          expect(yield* remembered.lastAgent).toBe(claude);
          expect(yield* remembered.get(claude)).toEqual({ lastModel: 'opus', lastEffort: 'high' });

          const migratedFile = yield* readState(root);
          expect(migratedFile).toMatchObject({
            version: 3,
            lastAgent: claude,
            legacyTabs: { open: [s1, s2], active: s2 },
          });
          expect(migratedFile).not.toHaveProperty('tabs');

          const p1 = ProjectId.make('p1');
          const workspace: WorkspaceState = { activeProjectId: p1, projects: [] };
          yield* remembered.rememberWorkspace(workspace);
          expect(yield* remembered.legacyTabs).toBeUndefined();
          expect(yield* remembered.workspace).toEqual(workspace);
          const afterRemember = yield* readState(root);
          expect(afterRemember).not.toHaveProperty('legacyTabs');
        }),
      ),
  );

  it.effect(
    'migrates v2 state.json stacks by keeping expanded/focused Panels, promoting stacked Sessions to Tabs, and dropping Changes/Workers Panels',
    () =>
      withRemembered(({ root }) =>
        Effect.gen(function* () {
          const p1 = ProjectId.make('p1');
          const s1 = SessionId.make('s1');
          const s2 = SessionId.make('s2');
          const s3 = SessionId.make('s3');
          yield* putState(root, {
            version: 2,
            agents: {},
            workspace: {
              activeProjectId: p1,
              projects: [
                {
                  projectId: p1,
                  activeTabId: 't1',
                  tabs: [
                    {
                      id: 't1',
                      focusedPanelId: 'pan-2',
                      layout: {
                        rootPaneId: 'split-1',
                        nodes: [
                          {
                            _tag: 'Split',
                            id: 'split-1',
                            direction: 'horizontal',
                            ratio: 0.5,
                            first: 'pane-1',
                            second: 'pane-aux',
                          },
                          {
                            _tag: 'Leaf',
                            id: 'pane-1',
                            panels: [
                              {
                                id: 'pan-1',
                                spec: { _tag: 'Session', sessionId: s1 },
                                collapsed: true,
                                heightShare: 0.4,
                              },
                              {
                                id: 'pan-2',
                                spec: { _tag: 'Session', sessionId: s2 },
                                collapsed: false,
                                heightShare: 0.6,
                              },
                              {
                                id: 'pan-3',
                                spec: { _tag: 'Session', sessionId: s3 },
                                collapsed: false,
                                heightShare: 0.5,
                              },
                            ],
                          },
                          {
                            _tag: 'Leaf',
                            id: 'pane-aux',
                            panels: [
                              {
                                id: 'pan-changes',
                                spec: { _tag: 'Changes', sessionId: s1 },
                                collapsed: false,
                                heightShare: 1,
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          });

          const remembered = yield* Remembered;
          const ws = yield* remembered.workspace;
          expect(ws?.projects).toHaveLength(1);
          const tabs = ws?.projects[0]?.tabs ?? [];
          expect(tabs).toHaveLength(3);
          expect(tabs[0]?.id).toBe('t1');
          expect(tabs[0]?.focusedPanelId).toBe('pan-2');
          expect(tabs[0]?.layout.rootPaneId).toBe('pane-1');
          expect(tabs[1]?.layout.nodes[0]).toMatchObject({
            _tag: 'Leaf',
            panels: [{ id: 'pan-1', spec: { _tag: 'Session', sessionId: s1 } }],
          });
          expect(tabs[2]?.layout.nodes[0]).toMatchObject({
            _tag: 'Leaf',
            panels: [{ id: 'pan-3', spec: { _tag: 'Session', sessionId: s3 } }],
          });

          const saved = yield* readState(root);
          expect(saved).toMatchObject({ version: 3 });
        }),
      ),
  );

  it.effect('never overwrites a state.json from a newer Spence version', () =>
    withRemembered(({ root }) =>
      Effect.gen(function* () {
        yield* putState(root, { version: 99, agents: {} });
        const remembered = yield* Remembered;
        expect(yield* remembered.workspace).toBeUndefined();
        expect(yield* remembered.legacyTabs).toBeUndefined();

        yield* remembered.rememberWorkspace({ projects: [] });
        expect(yield* readState(root)).toEqual({ version: 99, agents: {} });
      }),
    ),
  );
});
