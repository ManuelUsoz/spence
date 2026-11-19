import { Effect, Option } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import {
  MessagingError,
  type SendingSession,
  type SentProvenance,
} from '../../src/shared/messaging/messaging.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { DeviceIdentity } from '../devices/identity';
import { DeviceConnections, type RemoteClient } from '../lan/connections';
import { Inbox } from './inbox';

/** A target Device this Device cannot reach now: the sender is told at once, nothing is kept to retry. */
const offline = (device: DeviceId) =>
  new MessagingError({ reason: 'Offline', detail: `Device ${device} is not connected.` });

/**
 * Where a person's Message goes: the Local device's own Inbox, or a connected Remote device's over its connection.
 * Failing to reach it (not connected, or the connection failing on the way) is `Offline`.
 */
const reach = Effect.fnUntraced(function* <A>(
  device: DeviceId | undefined,
  local: (inbox: Inbox['Service']) => Effect.Effect<A, MessagingError>,
  remote: (client: RemoteClient) => Effect.Effect<A, MessagingError | { readonly _tag: string }>,
) {
  const self = yield* DeviceIdentity.use((identity) => identity.get);
  if (device === undefined || device === self.id) return yield* Inbox.use(local);
  const client = yield* DeviceConnections.use((connections) => connections.client(device)).pipe(
    Effect.mapError(() => offline(device)),
  );
  return yield* remote(client).pipe(
    Effect.catchIf(
      (error): error is { readonly _tag: string } => !(error instanceof MessagingError),
      () => Effect.fail(offline(device)),
    ),
  );
});

/** A person's Provenance: hop 0, the sending Session alone in the chain, this Device's name. */
const personProvenance = Effect.fnUntraced(function* (from: SendingSession) {
  const self = yield* DeviceIdentity.use((identity) => identity.get);
  const provenance: SentProvenance = {
    by: 'person',
    deviceName: self.name,
    sessionId: from.sessionId,
    sessionTitle: from.title,
    projectName: from.projectName,
    hops: 0,
    chain: [{ deviceId: from.device ?? self.id, sessionId: from.sessionId }],
  };
  return provenance;
});

export interface SendInput {
  readonly from: SendingSession;
  readonly device?: DeviceId;
  readonly sessionId: SessionId;
  readonly text: string;
}

/** Sends a person's Message to a Session on any Device (Send to another Session). */
export const sendMessage = Effect.fn('Messaging.send')(function* (input: SendInput) {
  const provenance = yield* personProvenance(input.from);
  const payload = { sessionId: input.sessionId, text: input.text, provenance };
  return yield* reach(
    input.device,
    (inbox) => inbox.deliver(payload, Option.none()),
    (client) => client['Inbox.deliver'](payload),
  );
});

export interface StartInput {
  readonly from: SendingSession;
  readonly device?: DeviceId;
  readonly projectId: ProjectId;
  readonly text: string;
  readonly summary?: string;
}

/** Starts a Session in a Project on any Device with a person's first Message, optionally seeded by a summary. */
export const startSession = Effect.fn('Messaging.startSession')(function* (input: StartInput) {
  const provenance = yield* personProvenance(input.from);
  const payload = {
    projectId: input.projectId,
    text: input.text,
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    provenance,
  };
  return yield* reach(
    input.device,
    (inbox) => inbox.start(payload, Option.none()),
    (client) => client['Inbox.start'](payload),
  );
});
