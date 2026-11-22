/**
 * `Tabs` RPC handlers over the real MessagePort transport with `layerSchemaBinary` serialization.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type RestoredWorkspace,
  type TabActivation,
  type WorkspaceState,
} from '../../src/shared/tabs/tabs.rpc';
import { layerTabActivations, TabActivations } from '../sessions/tab-activations';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

describe('TabsRpcs over the MessagePort transport', () => {
  it.live('round-trips Tabs.restore, Tabs.update, and Tabs.activations', () =>
    Effect.gen(function* () {
      const p1 = ProjectId.make('proj-1');
      const s1 = SessionId.make('sess-1');
      const tab1 = TabId.make('tab-1');
      const pane1 = PaneId.make('pane-1');
      const panel1 = PanelId.make('panel-1');

      const expectedWorkspace: WorkspaceState = {
        activeProjectId: p1,
        projects: [
          {
            projectId: p1,
            activeTabId: tab1,
            tabs: [
              {
                id: tab1,
                customTitle: 'Auth fix',
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

      const restoredPayload: RestoredWorkspace = {
        workspace: expectedWorkspace,
        sessions: [
          {
            id: s1,
            projectId: p1,
            title: { auto: 'Fix login', autoIsPlaceholder: false },
            attention: 'needsAnswer',
          },
        ],
      };

      const activation: TabActivation = {
        sessionId: s1,
        projectId: p1,
        title: { auto: 'Fix login', autoIsPlaceholder: false },
      };

      let updated: WorkspaceState | undefined;
      const handlers = TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed(restoredPayload),
        'Tabs.update': ({ workspace }) =>
          Effect.sync(() => {
            updated = workspace;
          }),
        'Tabs.activations': () => Stream.make(activation),
      });

      const context = yield* Layer.build(
        RpcServer.layer(TabsRpcs).pipe(Layer.provideMerge(layerIpcServer), Layer.provide(handlers)),
      );
      const handoff = Context.get(context, RpcPortHandoff);
      const { port1, port2 } = new MessageChannel();
      handoff.bind(serverPort(port1));
      const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
      const client = yield* RpcClient.make(TabsRpcs).pipe(Effect.provideContext(protocol));

      expect(yield* client['Tabs.restore']()).toEqual(restoredPayload);
      yield* client['Tabs.update']({ workspace: expectedWorkspace });
      expect(updated).toEqual(expectedWorkspace);
      const streamed = yield* client['Tabs.activations']().pipe(Stream.runCollect);
      expect([...streamed]).toEqual([activation]);
    }).pipe(Effect.scoped),
  );

  it.live(
    'delivers cross-Project TabActivations emitted via TabActivations over MessagePort RPC',
    () =>
      Effect.gen(function* () {
        const p1 = ProjectId.make('proj-1');
        const p2 = ProjectId.make('proj-2');
        const s1 = SessionId.make('sess-1');
        const s2 = SessionId.make('sess-2');

        const handlerEntered = yield* Deferred.make<void>();
        const handlers = TabsRpcs.toLayer({
          'Tabs.restore': () => Effect.die('unused'),
          'Tabs.update': () => Effect.die('unused'),
          'Tabs.activations': () =>
            Stream.unwrap(
              TabActivations.use((activations) =>
                Deferred.succeed(handlerEntered, undefined).pipe(Effect.as(activations.stream)),
              ),
            ),
        });

        const serverLayer = RpcServer.layer(TabsRpcs).pipe(
          Layer.provideMerge(layerIpcServer),
          Layer.provide(handlers),
          Layer.provideMerge(layerTabActivations),
        );

        const context = yield* Layer.build(serverLayer);
        const handoff = Context.get(context, RpcPortHandoff);
        const tabActivations = Context.get(context, TabActivations);
        const { port1, port2 } = new MessageChannel();
        handoff.bind(serverPort(port1));
        const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
        const client = yield* RpcClient.make(TabsRpcs).pipe(Effect.provideContext(protocol));

        const expected: ReadonlyArray<TabActivation> = [
          { sessionId: s1, projectId: p1, title: { auto: 'App fix', autoIsPlaceholder: false } },
          { sessionId: s2, projectId: p2, title: { user: 'API task', autoIsPlaceholder: false } },
        ];

        const collectFiber = yield* client['Tabs.activations']().pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        // Wait for the RPC handler to attach to the PubSub before emitting.
        yield* Deferred.await(handlerEntered);
        yield* Effect.sleep('20 millis');

        for (const item of expected) tabActivations.emit(item);

        const received = yield* Fiber.join(collectFiber);
        expect([...received]).toEqual(expected);
      }).pipe(Effect.scoped),
  );
});
