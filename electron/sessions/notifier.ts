import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { Context, Deferred, Effect, Layer, Queue, type Scope, Stream } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import type { SessionChange, SessionNotification } from '../../src/shared/sessions/sessions.rpc';
import { attentionNotificationCopy } from '../i18n/attention-notification';
import { e2eLocale, pickLocale } from '../i18n/locale';
import { Settings } from '../settings/settings';
import type {
  NotificationWorkerInput,
  NotificationWorkerOutput,
  WorkerSessionSnapshot,
} from './notification-worker';
import { SessionVisibility } from './session-visibility';
import { Sessions } from './sessions';
import { TabActivations } from './tab-activations';
import { WindowFocus } from './window-focus';

/** Context describing window focus at the moment a notification is dispatched to channels. */
export interface NotificationDeliveryContext {
  readonly windowFocused: boolean;
}

export interface NotificationChannelShape {
  readonly notify: (
    notification: SessionNotification,
    context?: NotificationDeliveryContext,
  ) => Effect.Effect<void>;
}

/** Delivers an eligible Session notification through a registered channel (OS banner, in-app toast, or voice). */
export class NotificationChannel extends Context.Service<
  NotificationChannel,
  NotificationChannelShape
>()('sessions/NotificationChannel') {}

export interface NotificationDispatcherShape {
  /** Forwards a Session change stream (Local or Remote `device`) to the Worker-thread evaluator. */
  readonly observe: (
    changes: Stream.Stream<SessionChange, unknown>,
    device?: DeviceId,
  ) => Effect.Effect<void, unknown>;
  /** Clears tracked state for a disconnected Remote device so reconnection starts from a fresh baseline. */
  readonly clearDevice: (device: DeviceId) => Effect.Effect<void>;
  /** Registers an additional notification channel for the lifetime of the given `Scope`. */
  readonly registerChannel: (
    channel: NotificationChannelShape,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Waits until all messages previously posted to the Worker thread have been processed and dispatched. */
  readonly sync: Effect.Effect<void>;
}

/**
 * Evaluates Session notification transitions and suppression rules in a dedicated Worker thread and
 * fans out eligible `SessionNotification` events to registered channels.
 */
export class NotificationDispatcher extends Context.Service<
  NotificationDispatcher,
  NotificationDispatcherShape
>()('sessions/NotificationDispatcher') {}

/** Watches `Sessions.changes` and routes Local Session transitions through `NotificationDispatcher`. */
export class Notifier extends Context.Service<Notifier, Record<string, never>>()(
  'sessions/Notifier',
) {}

export interface OsNotificationHost {
  readonly platform: NodeJS.Platform;
  readonly systemLanguages: () => readonly string[];
  readonly isFocused: () => boolean;
  readonly focusWindow: () => void;
  readonly flashFrame: () => void;
  readonly setDockBadge: (badge: string) => void;
  readonly showNotification: (options: {
    readonly title: string;
    readonly body: string;
    readonly onClick: () => void;
  }) => void;
}

const resolveNotificationWorkerPath = (): string => {
  const bundled = path.join(__dirname, 'notification-worker.js');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(__dirname, 'notification-worker.ts');
};

const toWorkerSnapshot = (change: SessionChange): WorkerSessionSnapshot => ({
  sessionId: change.sessionId,
  projectId: change.projectId,
  status: change.state.status,
  ...(change.state.lastTurn === undefined ? {} : { lastTurn: change.state.lastTurn }),
  ...(change.state.runningTurn === undefined ? {} : { runningTurn: change.state.runningTurn }),
  ...(change.state.parentSessionId === undefined
    ? {}
    : { parentSessionId: change.state.parentSessionId }),
  ...(change.state.archived === undefined ? {} : { archived: change.state.archived }),
  title: change.state.title,
});

/** Builds a `NotificationChannel` backed by a host window/notification implementation. */
export const makeOsNotificationChannel = (
  host: OsNotificationHost,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Layer.Layer<NotificationChannel, never, Settings | TabActivations> =>
  Layer.effect(
    NotificationChannel,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const activations = yield* TabActivations;

      return NotificationChannel.of({
        notify: Effect.fnUntraced(function* (notification, context) {
          const current = yield* settings.get;
          if (!current.notifications || context?.windowFocused === true || host.isFocused()) return;

          const locale =
            e2eLocale(env) ??
            pickLocale({
              override: current.language === 'system' ? undefined : current.language,
              systemLanguages: host.systemLanguages(),
            });
          const copy = attentionNotificationCopy(locale);
          const title = notification.title !== '' ? notification.title : copy.fallbackTitle;
          const body = copy.body(notification.cause);

          host.showNotification({
            title,
            body,
            onClick: () => {
              host.focusWindow();
              activations.emit({
                ...(notification.device === undefined ? {} : { device: notification.device }),
                sessionId: notification.sessionId,
                projectId: notification.projectId,
                title: notification.sessionTitle,
                ...(notification.turnId === undefined ? {} : { turnId: notification.turnId }),
              });
            },
          });

          if (notification.cause === 'blocked') {
            if (host.platform === 'win32') host.flashFrame();
            else if (host.platform === 'darwin') host.setDockBadge('•');
          }
        }),
      });
    }),
  );

export const layerNotificationDispatcher = Layer.effect(
  NotificationDispatcher,
  Effect.gen(function* () {
    const settings = yield* Settings;
    const visibility = yield* SessionVisibility;
    const windowFocus = yield* WindowFocus;
    const defaultChannel = yield* Effect.serviceOption(NotificationChannel);

    const channels = new Set<NotificationChannelShape>();
    if (defaultChannel._tag === 'Some') {
      channels.add(defaultChannel.value);
    }

    const inbox = yield* Queue.unbounded<NotificationWorkerOutput>();
    const pendingSyncs = new Map<number, Deferred.Deferred<void>>();
    let nextSyncId = 0;

    const worker = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const instance = new Worker(resolveNotificationWorkerPath());
        instance.on('message', (message: NotificationWorkerOutput) => {
          Queue.offerUnsafe(inbox, message);
        });
        instance.on('error', (error) => {
          console.error('Notification worker failed', error);
        });
        return instance;
      }),
      Effect.fnUntraced(function* (instance) {
        for (const deferred of pendingSyncs.values()) {
          yield* Deferred.succeed(deferred, undefined);
        }
        pendingSyncs.clear();
        yield* Effect.promise(() => instance.terminate()).pipe(Effect.ignore);
      }),
    );

    const post = (message: NotificationWorkerInput): void => {
      worker.postMessage(message);
    };

    // Seed initial state synchronously before callers can push Session changes.
    const initialSettings = yield* settings.get;
    post({ type: 'settings', notificationsEnabled: initialSettings.notifications });
    const initialFocused = yield* windowFocus.isFocused;
    post({ type: 'focus', focused: initialFocused });
    const initialVisible = yield* visibility.current;
    post({ type: 'visibility', visible: initialVisible });

    yield* settings.changes.pipe(
      Stream.runForEach((current) =>
        Effect.sync(() => post({ type: 'settings', notificationsEnabled: current.notifications })),
      ),
      Effect.forkScoped,
    );

    yield* windowFocus.changes.pipe(
      Stream.runForEach((focused) => Effect.sync(() => post({ type: 'focus', focused }))),
      Effect.forkScoped,
    );

    yield* visibility.changes.pipe(
      Stream.runForEach((visible) => Effect.sync(() => post({ type: 'visibility', visible }))),
      Effect.forkScoped,
    );

    yield* Queue.take(inbox).pipe(
      Effect.flatMap(
        Effect.fnUntraced(function* (message: NotificationWorkerOutput) {
          if (message.type === 'synced') {
            const deferred = pendingSyncs.get(message.id);
            if (deferred !== undefined) {
              pendingSyncs.delete(message.id);
              yield* Deferred.succeed(deferred, undefined);
            }
            return;
          }
          const context: NotificationDeliveryContext = { windowFocused: message.windowFocused };
          for (const channel of [...channels]) {
            yield* channel
              .notify(message.notification, context)
              .pipe(Effect.catchCause(() => Effect.void));
          }
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return NotificationDispatcher.of({
      observe: (changes, device) =>
        Stream.runForEach(changes, (change) =>
          Effect.sync(() =>
            post({
              type: 'change',
              ...(device === undefined ? {} : { device }),
              snapshot: toWorkerSnapshot(change),
            }),
          ),
        ),
      clearDevice: (device) => Effect.sync(() => post({ type: 'deviceDisconnected', device })),
      registerChannel: (channel) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            channels.add(channel);
          }),
          () =>
            Effect.sync(() => {
              channels.delete(channel);
            }),
        ),
      sync: Effect.gen(function* () {
        const id = ++nextSyncId;
        const deferred = yield* Deferred.make<void>();
        pendingSyncs.set(id, deferred);
        post({ type: 'sync', id });
        yield* Deferred.await(deferred);
      }),
    });
  }),
);

export const layerNotifier = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const dispatcher = yield* NotificationDispatcher;
    yield* dispatcher.observe(sessions.changes).pipe(Effect.ignore, Effect.forkScoped);
    return Notifier.of({});
  }),
);
