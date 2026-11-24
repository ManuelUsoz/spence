import { parentPort } from 'node:worker_threads';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  LastTurn,
  NotificationCause,
  SessionId,
  SessionNotification,
  SessionStatus,
  SessionTitle,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import type { VisibleSessionTarget } from '../../src/shared/tabs/workspace-layout';

/** Minimal structured-cloneable Session change slice evaluated off the main thread. */
export interface WorkerSessionSnapshot {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly status: SessionStatus;
  readonly lastTurn?: LastTurn;
  readonly runningTurn?: TurnId;
  readonly parentSessionId?: SessionId;
  readonly archived?: boolean;
  readonly title: SessionTitle;
}

export type NotificationWorkerInput =
  | { readonly type: 'settings'; readonly notificationsEnabled: boolean }
  | { readonly type: 'focus'; readonly focused: boolean }
  | { readonly type: 'visibility'; readonly visible: ReadonlyArray<VisibleSessionTarget> }
  | { readonly type: 'deviceDisconnected'; readonly device: DeviceId }
  | {
      readonly type: 'change';
      readonly device?: DeviceId;
      readonly snapshot: WorkerSessionSnapshot;
    }
  | { readonly type: 'sync'; readonly id: number };

export type NotificationWorkerOutput =
  | {
      readonly type: 'notify';
      readonly windowFocused: boolean;
      readonly notification: SessionNotification;
    }
  | { readonly type: 'synced'; readonly id: number };

interface TrackedSession {
  readonly status: SessionStatus;
  readonly lastSettledTurnId: TurnId | undefined;
}

const sessionKey = (device: DeviceId | undefined, sessionId: SessionId): string =>
  device === undefined ? `local:${sessionId}` : `remote:${device}:${sessionId}`;

const resolveTitle = (title: SessionTitle): string =>
  title.user ?? (title.autoIsPlaceholder ? undefined : title.auto) ?? '';

const tracked = new Map<string, TrackedSession>();
let visibleKeys = new Set<string>();
let windowFocused = false;
let notificationsEnabled = true;

const evaluateChange = (
  device: DeviceId | undefined,
  snapshot: WorkerSessionSnapshot,
): NotificationWorkerOutput | null => {
  const key = sessionKey(device, snapshot.sessionId);
  const prev = tracked.get(key);
  const settled = snapshot.lastTurn;

  tracked.set(key, {
    status: snapshot.status,
    lastSettledTurnId: settled?.turnId,
  });

  let cause: NotificationCause | undefined;
  if (snapshot.status === 'blocked') {
    if (prev?.status !== 'blocked') {
      cause = 'blocked';
    }
  } else if (snapshot.status === 'error') {
    if (prev?.status !== 'error') {
      cause = 'error';
    }
  } else if (
    prev !== undefined &&
    settled !== undefined &&
    settled.turnId !== prev.lastSettledTurnId &&
    (settled.outcome === 'done' ||
      settled.outcome === 'refused' ||
      settled.outcome === 'cutShort') &&
    snapshot.parentSessionId === undefined
  ) {
    cause = 'turnFinished';
  }

  if (cause === undefined) return null;
  if (snapshot.archived === true) return null;
  if (!notificationsEnabled) return null;
  if (windowFocused && visibleKeys.has(key)) return null;

  const turnId =
    cause === 'turnFinished' ? settled?.turnId : (snapshot.runningTurn ?? settled?.turnId);

  return {
    type: 'notify',
    windowFocused,
    notification: {
      ...(device === undefined ? {} : { device }),
      sessionId: snapshot.sessionId,
      projectId: snapshot.projectId,
      ...(turnId === undefined ? {} : { turnId }),
      cause,
      title: resolveTitle(snapshot.title),
      sessionTitle: snapshot.title,
    },
  };
};

if (parentPort !== null) {
  const port = parentPort;
  port.on('message', (message: NotificationWorkerInput) => {
    switch (message.type) {
      case 'settings':
        notificationsEnabled = message.notificationsEnabled;
        return;
      case 'focus':
        windowFocused = message.focused;
        return;
      case 'visibility':
        visibleKeys = new Set(
          message.visible.map((target) => sessionKey(target.device, target.sessionId)),
        );
        return;
      case 'deviceDisconnected': {
        const prefix = `remote:${message.device}:`;
        for (const key of tracked.keys()) {
          if (key.startsWith(prefix)) tracked.delete(key);
        }
        return;
      }
      case 'change': {
        const output = evaluateChange(message.device, message.snapshot);
        if (output !== null) port.postMessage(output);
        return;
      }
      case 'sync':
        port.postMessage({ type: 'synced', id: message.id } satisfies NotificationWorkerOutput);
        return;
    }
  });
}
