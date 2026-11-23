import { Context, Effect, Fiber, Layer, Stream } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import { NotificationDispatcher } from '../sessions/notifier';
import { DeviceConnections } from './connections';

/**
 * Watches the Sessions of every connected Remote device and forwards their changes through
 * `NotificationDispatcher`, clearing each Device's baseline on disconnect.
 */
export class RemoteNotifier extends Context.Service<RemoteNotifier, Record<string, never>>()(
  'lan/RemoteNotifier',
) {}

export const layerRemoteNotifier = Layer.effect(
  RemoteNotifier,
  Effect.gen(function* () {
    const connections = yield* DeviceConnections;
    const dispatcher = yield* NotificationDispatcher;
    const scope = yield* Effect.scope;
    const follows = new Map<DeviceId, Fiber.Fiber<void>>();

    const follow = Effect.fnUntraced(function* (id: DeviceId) {
      const client = yield* connections.client(id);
      return yield* dispatcher
        .observe(client['Session.changes'](), id)
        .pipe(Effect.ignore, Effect.forkIn(scope));
    });

    yield* connections.changes.pipe(
      Stream.runForEach(
        Effect.fnUntraced(function* (all) {
          const online = new Set(
            all.flatMap((connection) =>
              connection.status._tag === 'Online' ? [connection.id] : [],
            ),
          );
          for (const [id, fiber] of follows) {
            if (online.has(id)) continue;
            follows.delete(id);
            yield* Fiber.interrupt(fiber);
            yield* dispatcher.clearDevice(id);
          }
          for (const id of online) {
            if (follows.has(id)) continue;
            const fiber = yield* follow(id).pipe(Effect.option);
            if (fiber._tag === 'Some') follows.set(id, fiber.value);
          }
        }),
      ),
      Effect.forkScoped,
    );

    return RemoteNotifier.of({});
  }),
);
