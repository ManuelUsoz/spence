import { Context, Effect, Layer, Option } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import {
  type Delivery,
  MAX_CROSS_DEVICE_HOPS,
  MessagingError,
  type SentProvenance,
} from '../../src/shared/messaging/messaging.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  MessagePart,
  MessageSender,
  SessionError,
  SessionId,
} from '../../src/shared/sessions/sessions.rpc';
import { DeviceIdentity } from '../devices/identity';
import { Sessions } from '../sessions/sessions';

export interface DeliverInput {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly provenance: SentProvenance;
}

export interface StartInput {
  readonly projectId: ProjectId;
  readonly text: string;
  readonly summary?: string;
  readonly provenance: SentProvenance;
}

export interface InboxShape {
  /**
   * Accepts a Message for one of this Device's Sessions. `sender` is the Paired device the call came over (none: this
   * Device's own window); it is what the Provenance names, whatever the payload says.
   */
  readonly deliver: (
    input: DeliverInput,
    sender: Option.Option<DeviceId>,
  ) => Effect.Effect<Delivery, MessagingError>;
  /** Starts a Session in one of this Device's Projects with that first Message. */
  readonly start: (
    input: StartInput,
    sender: Option.Option<DeviceId>,
  ) => Effect.Effect<SessionId, MessagingError>;
}

/** The receiving side of Cross-device messages, on every Device. Nothing is kept for later: it accepts or refuses. */
export class Inbox extends Context.Service<Inbox, InboxShape>()('messaging/Inbox') {}

/** What a refusal from the target Session means to the sender. */
const fromSessionError = (error: SessionError): MessagingError => {
  switch (error.reason) {
    case 'NotFound':
      return new MessagingError({ reason: 'NotFound', detail: error.detail });
    case 'Unsupported':
      return new MessagingError({ reason: 'Forbidden', detail: error.detail });
    case 'AgentNotInstalled':
    case 'AgentNeedsLogin':
    case 'AgentCantStart':
      return new MessagingError({ reason: 'Unavailable', detail: error.detail });
    case 'Busy':
    case 'NotRunning':
    case 'MemoryLost':
    case 'ExitUnconfirmed':
      return new MessagingError({ reason: 'Busy', detail: error.detail });
  }
};

/**
 * The receiver's gate, before anything reaches a Session. A person's Message always passes; an Agent's needs "Allow
 * Agents from this Device", which no Paired device has yet, so it is refused. Either is refused as a loop past
 * `MAX_CROSS_DEVICE_HOPS`, or when the target Session is already in its chain (the sender included).
 */
const admit = (
  provenance: SentProvenance,
  target: Option.Option<{ readonly deviceId: DeviceId; readonly sessionId: SessionId }>,
): Effect.Effect<void, MessagingError> => {
  if (provenance.by === 'agent') {
    return Effect.fail(
      new MessagingError({
        reason: 'Forbidden',
        detail: 'Agents from that Device are not allowed to message this Device.',
      }),
    );
  }
  if (provenance.hops > MAX_CROSS_DEVICE_HOPS) {
    return Effect.fail(
      new MessagingError({ reason: 'Loop', detail: 'The Message crossed too many Sessions.' }),
    );
  }
  if (
    Option.isSome(target) &&
    provenance.chain.some(
      (link) =>
        link.deviceId === target.value.deviceId && link.sessionId === target.value.sessionId,
    )
  ) {
    return Effect.fail(
      new MessagingError({
        reason: 'Loop',
        detail: 'The Message would come back to a Session it came from.',
      }),
    );
  }
  return Effect.void;
};

/** The first Message of a Session seeded by a Summary handoff: the summary, then what the person wrote. */
const seededParts = (text: string, summary: string | undefined): ReadonlyArray<MessagePart> =>
  summary === undefined || summary.trim() === ''
    ? [{ _tag: 'text', text }]
    : [
        { _tag: 'text', text },
        // Read by the Agent, never shown through i18n: the context the sending Session handed off.
        { _tag: 'text', text: `\n\nContext handed off from the sending Session:\n\n${summary}` },
      ];

export const layerInbox: Layer.Layer<Inbox, never, Sessions | DeviceIdentity> = Layer.effect(
  Inbox,
  Effect.gen(function* () {
    const sessions = yield* Sessions;
    const identity = yield* DeviceIdentity;

    /** The Provenance the receiving Session shows: the Device is the connection's, the rest as the sender says. */
    const senderOf = Effect.fnUntraced(function* (
      provenance: SentProvenance,
      sender: Option.Option<DeviceId>,
    ) {
      const local = yield* identity.get;
      const from: MessageSender = {
        sessionId: provenance.sessionId,
        title: provenance.sessionTitle,
        projectName: provenance.projectName,
        hops: provenance.hops,
        device: { id: Option.getOrElse(sender, () => local.id), name: provenance.deviceName },
        by: provenance.by,
      };
      return { local, from };
    });

    const deliver = Effect.fn('Inbox.deliver')(function* (
      input: DeliverInput,
      sender: Option.Option<DeviceId>,
    ) {
      const { local, from } = yield* senderOf(input.provenance, sender);
      yield* admit(
        input.provenance,
        Option.some({ deviceId: local.id, sessionId: input.sessionId }),
      );
      return yield* sessions
        .enqueueFrom(input.sessionId, [{ _tag: 'text', text: input.text }], from)
        .pipe(Effect.mapError(fromSessionError));
    });

    const start = Effect.fn('Inbox.start')(function* (
      input: StartInput,
      sender: Option.Option<DeviceId>,
    ) {
      const { from } = yield* senderOf(input.provenance, sender);
      yield* admit(input.provenance, Option.none());
      const sessionId = yield* sessions
        .create(input.projectId)
        .pipe(Effect.mapError(fromSessionError));
      yield* sessions
        .enqueueFrom(sessionId, seededParts(input.text, input.summary), from)
        .pipe(Effect.mapError(fromSessionError));
      return sessionId;
    });

    return Inbox.of({ deliver, start });
  }),
);
