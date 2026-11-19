import { Effect, Layer } from 'effect';
import { InboxRpcs, MessagingRpcs } from '../../src/shared/messaging/messaging.rpc';
import { layerDeviceIdentityLive } from '../devices/identity';
import { currentPeer } from '../lan/remote-peer';
import { Inbox, layerInbox } from '../messaging/inbox';
import { sendMessage, startSession } from '../messaging/messaging';
import { layerSessionsLive } from './sessions';

/** Unbound: needs `Inbox`, `DeviceIdentity` and `DeviceConnections`, so a test Device can serve it. Local-only. */
export const layerMessagingHandlersWith = MessagingRpcs.toLayer({
  'Messaging.send': (input) => sendMessage(input),
  'Messaging.startSession': (input) => startSession(input),
});

/**
 * Unbound: needs `Inbox`. Served to Paired devices only (`RemoteRpcs`): the sender is the connection's `RemotePeer`,
 * read per call.
 */
export const layerInboxHandlersWith = InboxRpcs.toLayer({
  'Inbox.deliver': (input) =>
    Effect.flatMap(currentPeer, (peer) => Inbox.use((inbox) => inbox.deliver(input, peer))),
  'Inbox.start': (input) =>
    Effect.flatMap(currentPeer, (peer) => Inbox.use((inbox) => inbox.start(input, peer))),
});

/** The app's one Inbox, over the same (memoized) Sessions the Sessions handlers drive. */
export const layerInboxLive = layerInbox.pipe(
  Layer.provide(layerSessionsLive),
  Layer.provide(layerDeviceIdentityLive),
);

export const layerInboxHandlers = layerInboxHandlersWith.pipe(Layer.provide(layerInboxLive));

/** Needs `DeviceConnections` from the runtime, next to the Devices handlers. */
export const layerMessagingHandlers = layerMessagingHandlersWith.pipe(
  Layer.provide(Layer.merge(layerInboxLive, layerDeviceIdentityLive)),
);
