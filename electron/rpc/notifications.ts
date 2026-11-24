import { Effect, Layer, Stream } from 'effect';
import { NotificationsRpcs } from '../../src/shared/notifications/notifications.rpc';
import { InAppNotifications, layerInAppNotifications } from '../sessions/in-app-notifications';

export const layerNotificationsHandlers = NotificationsRpcs.toLayer({
  'Notifications.events': () =>
    Stream.unwrap(InAppNotifications.use((notifications) => Effect.succeed(notifications.stream))),
}).pipe(Layer.provide(layerInAppNotifications));
