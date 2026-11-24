/**
 * `Notifications` RPC handlers over the real MessagePort transport with `layerSchemaBinary` serialization.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { DeviceId } from '../../src/shared/devices/devices.rpc';
import { NotificationsRpcs } from '../../src/shared/notifications/notifications.rpc';
import { ProjectId } from '../../src/shared/projects/projects.rpc';
import { DesktopRpcs } from '../../src/shared/rpc/desktop-rpcs';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { DeviceScopedRpcs, RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import {
  SessionId,
  TurnId,
  type SessionNotification,
} from '../../src/shared/sessions/sessions.rpc';
import { InAppNotifications, makeInAppNotifications } from '../sessions/in-app-notifications';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

describe('NotificationsRpcs over the MessagePort transport', () => {
  it('stays Local-only on DesktopRpcs and out of DeviceScopedRpcs / RemoteRpcs', () => {
    expect(DesktopRpcs.requests.has('Notifications.events')).toBe(true);
    expect(DeviceScopedRpcs.requests.has('Notifications.events')).toBe(false);
    expect(RemoteRpcs.requests.has('Notifications.events')).toBe(false);
  });

  it.live(
    'streams Local and Remote SessionNotifications emitted via InAppNotifications over MessagePort RPC',
    () =>
      Effect.gen(function* () {
        const p1 = ProjectId.make('proj-1');
        const p2 = ProjectId.make('proj-2');
        const s1 = SessionId.make('sess-1');
        const s2 = SessionId.make('sess-2');
        const d1 = DeviceId.make('dev-1');
        const t1 = TurnId.make('turn-1');
        const t2 = TurnId.make('turn-2');

        const subscribed = yield* Deferred.make<void>();
        const handlers = NotificationsRpcs.toLayer({
          'Notifications.events': () =>
            Stream.unwrap(
              InAppNotifications.use((notifications) => Effect.succeed(notifications.stream)),
            ),
        });

        const serverLayer = RpcServer.layer(NotificationsRpcs).pipe(
          Layer.provideMerge(layerIpcServer),
          Layer.provide(handlers),
          Layer.provideMerge(
            makeInAppNotifications(Deferred.succeed(subscribed, undefined).pipe(Effect.asVoid)),
          ),
        );

        const context = yield* Layer.build(serverLayer);
        const handoff = Context.get(context, RpcPortHandoff);
        const inApp = Context.get(context, InAppNotifications);
        const { port1, port2 } = new MessageChannel();
        handoff.bind(serverPort(port1));
        const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
        const client = yield* RpcClient.make(NotificationsRpcs).pipe(
          Effect.provideContext(protocol),
        );

        const expected: ReadonlyArray<SessionNotification> = [
          {
            sessionId: s1,
            projectId: p1,
            turnId: t1,
            cause: 'blocked',
            title: 'Fix login',
            sessionTitle: { auto: 'Fix login', autoIsPlaceholder: false },
          },
          {
            device: d1,
            sessionId: s2,
            projectId: p2,
            turnId: t2,
            cause: 'turnFinished',
            title: '',
            sessionTitle: { auto: '', autoIsPlaceholder: true },
          },
        ];

        const collectFiber = yield* client['Notifications.events']().pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped,
        );
        yield* Deferred.await(subscribed);

        for (const item of expected) {
          yield* inApp.publish(item);
        }

        const received = yield* Fiber.join(collectFiber);
        expect([...received]).toEqual(expected);
      }).pipe(Effect.scoped),
  );
});
