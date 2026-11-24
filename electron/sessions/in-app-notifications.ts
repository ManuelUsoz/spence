import { Context, Effect, Layer, PubSub, Stream } from 'effect';
import type { SessionNotification } from '../../src/shared/sessions/sessions.rpc';
import { layerSettingsMain } from '../settings/window';
import { Settings } from '../settings/settings';
import {
  layerNotificationDispatcherLive,
  NotificationDispatcher,
  type NotificationChannelShape,
} from './notifier';
import { layerWindowFocus, WindowFocus } from './window-focus';

export interface InAppNotificationsShape {
  readonly publish: (notification: SessionNotification) => Effect.Effect<void>;
  readonly stream: Stream.Stream<SessionNotification>;
}

/** In-app toast notifications emitted by main for a focused Spence window. */
export class InAppNotifications extends Context.Service<
  InAppNotifications,
  InAppNotificationsShape
>()('sessions/InAppNotifications') {}

/** Builds the `InAppNotifications` service, optionally running `onSubscribed` after a stream subscribes. */
export const makeInAppNotifications = (
  onSubscribed?: Effect.Effect<void>,
): Layer.Layer<InAppNotifications> =>
  Layer.effect(
    InAppNotifications,
    Effect.gen(function* () {
      const bus = yield* PubSub.unbounded<SessionNotification>();
      return InAppNotifications.of({
        publish: (notification) => PubSub.publish(bus, notification).pipe(Effect.asVoid),
        stream: Stream.unwrap(
          PubSub.subscribe(bus).pipe(
            Effect.tap(() => onSubscribed ?? Effect.void),
            Effect.map((subscription) => Stream.fromSubscription(subscription)),
          ),
        ),
      });
    }),
  );

export const layerInAppNotifications = makeInAppNotifications();

/**
 * Registers the in-app notification channel with `NotificationDispatcher` for the enclosing scope,
 * delivering eligible `SessionNotification` events only when `settings.notifications` is on and
 * the window is focused.
 */
export const layerInAppNotificationChannel = Layer.effectDiscard(
  Effect.gen(function* () {
    const dispatcher = yield* NotificationDispatcher;
    const inApp = yield* InAppNotifications;
    const settings = yield* Settings;
    const windowFocus = yield* WindowFocus;

    const channel: NotificationChannelShape = {
      notify: Effect.fnUntraced(function* (notification, context) {
        const current = yield* settings.get;
        if (!current.notifications) return;
        const focused = context?.windowFocused ?? (yield* windowFocus.isFocused);
        if (!focused) return;
        yield* inApp.publish(notification);
      }),
    };

    yield* dispatcher.registerChannel(channel);
  }),
);

/** App-lifetime in-app notification channel sharing memoized dispatcher, settings, focus, and stream. */
export const layerInAppNotificationChannelLive = layerInAppNotificationChannel.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerNotificationDispatcherLive,
      layerInAppNotifications,
      layerSettingsMain,
      layerWindowFocus,
    ),
  ),
);
