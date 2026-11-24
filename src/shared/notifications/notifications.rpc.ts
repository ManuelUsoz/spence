import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionNotification } from '../sessions/sessions.rpc';

/** Local-only stream of eligible in-app Session notifications emitted while the window is focused. */
export const NotificationsRpcs = RpcGroup.make(
  Rpc.make('Notifications.events', { success: SessionNotification, stream: true }),
);
