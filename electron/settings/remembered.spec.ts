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
  it.effect('starts empty and persists WorkspaceState at state.json version 2', () =>
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
        };

        yield* remembered.rememberWorkspace(workspace);
        expect(yield* remembered.workspace).toEqual(workspace);
        expect(yield* readState(root)).toMatchObject({
          version: 2,
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
            version: 2,
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
