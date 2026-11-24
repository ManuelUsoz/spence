import { DestroyRef, Injectable, inject } from '@angular/core';
import { toast } from '@ui/toast';
import { Effect, Schedule, Stream } from 'effect';
import type { NotificationCause, SessionNotification } from '../../../shared/sessions/sessions.rpc';
import { DesktopApi } from '../../core/desktop-api';
import { EffectRuntime } from '../../core/effect-runtime';
import { Tabs, titleOf } from '../../core/tabs';
import { SettingsState } from './settings-state';

const RESUBSCRIBE_AFTER = '500 millis';

const followNotifications = (onNotification: (notification: SessionNotification) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Notifications.events']().pipe(
      Stream.runForEach((notification) => Effect.sync(() => onNotification(notification))),
    );
  }).pipe(Effect.retry(Schedule.spaced(RESUBSCRIBE_AFTER)));

const resolvedTitle = (notification: SessionNotification): string => {
  if (notification.title.trim() !== '') return notification.title;
  if (notification.sessionTitle.autoImageCount !== undefined) {
    return titleOf(notification.sessionTitle) ?? $localize`New Session`;
  }
  return $localize`New Session`;
};

const causeDescription = (cause: NotificationCause): string => {
  switch (cause) {
    case 'blocked':
      return $localize`Waiting for your answer`;
    case 'turnFinished':
      return $localize`Turn finished`;
    case 'error':
      return $localize`Stopped with an error`;
  }
};

/**
 * Subscribes to main's Local-only `Notifications.events` stream while the Shell is mounted and renders
 * auto-dismissing in-app toasts with an **Open** action that jumps to the target Session and Turn.
 */
@Injectable()
export class SessionNotifications {
  private readonly runtime = inject(EffectRuntime);
  private readonly tabs = inject(Tabs);
  private readonly settings = inject(SettingsState);
  private readonly aborts = new AbortController();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(
      followNotifications((notification) => this.show(notification)),
      { signal: this.aborts.signal },
    );
  }

  private show(notification: SessionNotification): void {
    toast(resolvedTitle(notification), {
      description: causeDescription(notification.cause),
      testId: 'session-notification-toast',
      action: {
        label: $localize`Open`,
        onClick: () => this.open(notification),
      },
    });
  }

  private open(notification: SessionNotification): void {
    this.settings.set(false);
    this.tabs.open({
      id: notification.sessionId,
      projectId: notification.projectId,
      title:
        notification.title.trim() !== '' ? notification.title : titleOf(notification.sessionTitle),
      ...(notification.device === undefined ? {} : { device: notification.device }),
    });
    if (notification.turnId !== undefined) {
      this.tabs.requestTurnScroll(notification.sessionId, notification.turnId);
    }
  }
}
