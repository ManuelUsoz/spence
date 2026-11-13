import { Context, Effect, Layer, Stream } from 'effect';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  Attention,
  SessionChange,
  SessionId,
  SessionTitle,
} from '../../src/shared/sessions/sessions.rpc';
import { attentionNotificationCopy } from '../i18n/attention-notification';
import { pickLocale } from '../i18n/locale';
import { Settings } from '../settings/settings';
import { Sessions } from './sessions';
import { TabActivations } from './tab-activations';

export interface AttentionNotification {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly cause: Attention;
  readonly title: string;
  readonly sessionTitle: SessionTitle;
}

export interface NotificationChannelShape {
  readonly notify: (notification: AttentionNotification) => Effect.Effect<void>;
}

/** Delivers an Attention notification through the host (OS notifications in production, spy in tests). */
export class NotificationChannel extends Context.Service<
  NotificationChannel,
  NotificationChannelShape
>()('sessions/NotificationChannel') {}

/** Watches `Sessions.changes` and emits a notification once per transition into Attention. */
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

const resolveTitle = (title: SessionTitle): string =>
  title.user ?? (title.autoIsPlaceholder ? undefined : title.auto) ?? '';

/** Builds a `NotificationChannel` backed by a host window/notification implementation. */
export const makeOsNotificationChannel = (
  host: OsNotificationHost,
): Layer.Layer<NotificationChannel, never, Settings | TabActivations> =>
  Layer.effect(
    NotificationChannel,
    Effect.gen(function* () {
      const settings = yield* Settings;
      const activations = yield* TabActivations;

      return NotificationChannel.of({
        notify: Effect.fnUntraced(function* (notification) {
          const current = yield* settings.get;
          if (!current.notifications || host.isFocused()) return;

          const locale = pickLocale({
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
                sessionId: notification.sessionId,
                projectId: notification.projectId,
                title: notification.sessionTitle,
              });
            },
          });

          if (notification.cause === 'needsAnswer') {
            if (host.platform === 'win32') host.flashFrame();
            else if (host.platform === 'darwin') host.setDockBadge('•');
          }
        }),
      });
    }),
  );

export const layerNotifier = Layer.effect(
  Notifier,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const channel = yield* NotificationChannel;
    const lastAttention = new Map<SessionId, Attention>();

    const onChange = Effect.fnUntraced(function* (change: SessionChange) {
      const next = change.state.attention;
      if (next === undefined) {
        lastAttention.delete(change.sessionId);
        return;
      }
      if (lastAttention.get(change.sessionId) === next) return;
      lastAttention.set(change.sessionId, next);
      yield* channel
        .notify({
          sessionId: change.sessionId,
          projectId: change.projectId,
          cause: next,
          title: resolveTitle(change.state.title),
          sessionTitle: change.state.title,
        })
        .pipe(Effect.catchCause(() => Effect.void));
    });

    yield* Stream.runForEach(sessions.changes, onChange).pipe(Effect.forkScoped);

    return Notifier.of({});
  }),
);
