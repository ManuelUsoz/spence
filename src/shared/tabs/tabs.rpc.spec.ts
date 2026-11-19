import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { RpcSerialization } from 'effect/rpc';
import { ProjectId } from '../projects/projects.rpc';
import { layerPortSerialization } from '../rpc/message-port-protocol';
import { SessionId } from '../sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  RestoredWorkspace,
  TabActivation,
  TabId,
  WorkspaceState,
} from './tabs.rpc';

/** Encodes and decodes a value the way the wire does (`layerSchemaBinary`). */
const roundTrip = <
  S extends Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never },
>(
  schema: S,
  value: S['Type'],
) =>
  Effect.gen(function* () {
    const serialization = yield* RpcSerialization.RpcSerialization;
    const codec = serialization.codecFor(schema);
    const encoded = yield* Schema.encodeEffect(codec)(value);
    return yield* Schema.decodeUnknownEffect(codec)(encoded);
  }).pipe(Effect.provide(layerPortSerialization));

describe('tabs contract over layerSchemaBinary', () => {
  it.effect('round-trips WorkspaceState with splits, stacks, customTitle, and drafts', () =>
    Effect.gen(function* () {
      const p1 = ProjectId.make('proj-1');
      const p2 = ProjectId.make('proj-2');
      const tab1 = TabId.make('tab-1');
      const tab2 = TabId.make('tab-2');
      const splitPane = PaneId.make('pane-root');
      const leaf1 = PaneId.make('pane-1');
      const leaf2 = PaneId.make('pane-2');
      const leaf3 = PaneId.make('pane-3');
      const s1 = SessionId.make('sess-1');
      const s2 = SessionId.make('sess-2');

      const workspace: WorkspaceState = {
        activeProjectId: p1,
        projects: [
          {
            projectId: p1,
            activeTabId: tab1,
            tabs: [
              {
                id: tab1,
                customTitle: 'Investigate auth',
                focusedPanelId: PanelId.make('panel-1'),
                layout: {
                  rootPaneId: splitPane,
                  nodes: [
                    {
                      _tag: 'Split',
                      id: splitPane,
                      direction: 'horizontal',
                      ratio: 0.45,
                      first: leaf1,
                      second: leaf2,
                    },
                    {
                      _tag: 'Leaf',
                      id: leaf1,
                      panels: [
                        {
                          id: PanelId.make('panel-1'),
                          spec: { _tag: 'Session', sessionId: s1 },
                          collapsed: false,
                          heightShare: 0.6,
                        },
                        {
                          id: PanelId.make('panel-2'),
                          spec: { _tag: 'Changes', sessionId: s1 },
                          collapsed: true,
                          heightShare: 0.4,
                        },
                      ],
                    },
                    {
                      _tag: 'Leaf',
                      id: leaf2,
                      panels: [
                        {
                          id: PanelId.make('panel-3'),
                          spec: { _tag: 'Workers', sessionId: s1 },
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
          {
            projectId: p2,
            activeTabId: tab2,
            tabs: [
              {
                id: tab2,
                focusedPanelId: PanelId.make('panel-4'),
                layout: {
                  rootPaneId: leaf3,
                  nodes: [
                    {
                      _tag: 'Leaf',
                      id: leaf3,
                      panels: [
                        {
                          id: PanelId.make('panel-4'),
                          spec: { _tag: 'Session', sessionId: s2, draft: true },
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

      expect(yield* roundTrip(WorkspaceState, workspace)).toEqual(workspace);
    }),
  );

  it.effect('round-trips RestoredWorkspace and TabActivation', () =>
    Effect.gen(function* () {
      const p1 = ProjectId.make('proj-1');
      const s1 = SessionId.make('sess-1');
      const tab1 = TabId.make('tab-1');
      const pane1 = PaneId.make('pane-1');
      const panel1 = PanelId.make('panel-1');

      const restored: RestoredWorkspace = {
        workspace: {
          activeProjectId: p1,
          projects: [
            {
              projectId: p1,
              activeTabId: tab1,
              tabs: [
                {
                  id: tab1,
                  focusedPanelId: panel1,
                  layout: {
                    rootPaneId: pane1,
                    nodes: [
                      {
                        _tag: 'Leaf',
                        id: pane1,
                        panels: [
                          {
                            id: panel1,
                            spec: { _tag: 'Session', sessionId: s1 },
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
        sessions: [
          {
            id: s1,
            projectId: p1,
            title: { auto: 'Fix login', autoIsPlaceholder: false },
            attention: 'needsAnswer',
            running: true,
          },
        ],
      };

      const activation: TabActivation = {
        sessionId: s1,
        projectId: p1,
        title: { user: 'Login', autoIsPlaceholder: false },
      };

      expect(yield* roundTrip(RestoredWorkspace, restored)).toEqual(restored);
      expect(yield* roundTrip(TabActivation, activation)).toEqual(activation);
    }),
  );
});
