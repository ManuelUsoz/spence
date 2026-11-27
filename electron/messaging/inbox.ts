import { Context, Duration, Effect, Layer, Option, Stream } from 'effect';
import { randomBytes } from 'node:crypto';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';
import {
  type Accepted,
  MAX_CROSS_DEVICE_HOPS,
  MAX_RESULT_WAIT_MS,
  MessagingError,
  type SentProvenance,
  type Started,
  type TurnResult,
} from '../../src/shared/messaging/messaging.rpc';
import type { ProjectId } from '../../src/shared/projects/projects.rpc';
import type {
  MessagePart,
  MessageSender,
  SessionError,
  SessionId,
  TurnId,
} from '../../src/shared/sessions/sessions.rpc';
import { DeviceIdentity } from '../devices/identity';
import type { RemotePeer } from '../lan/remote-peer';
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

/** The Paired device a Message came over; none for this Device's own window. */
export type InboxSender = Option.Option<RemotePeer['Service']>;

export interface InboxShape {
  /**
   * Accepts a Message for one of this Device's Sessions. `sender` is the Paired device the call came over (none: this
   * Device's own window); it is what the Provenance names, whatever the payload says.
   */
  readonly deliver: (
    input: DeliverInput,
    sender: InboxSender,
  ) => Effect.Effect<Accepted, MessagingError>;
  /** Starts a Session in one of this Device's Projects with that first Message. */
  readonly start: (
    input: StartInput,
    sender: InboxSender,
  ) => Effect.Effect<Started, MessagingError>;
  /** Waits for the Turn behind an Agent's receipt to end, for the Device it was minted for only. */
  readonly result: (
    input: { readonly receipt: string; readonly timeoutMs: number },
    sender: InboxSender,
  ) => Effect.Effect<TurnResult, MessagingError>;
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
    case 'PullRequestUnavailable':
      return new MessagingError({ reason: 'Unavailable', detail: error.detail });
    case 'Busy':
    case 'NotRunning':
    case 'MemoryLost':
    case 'ExitUnconfirmed':
      return new MessagingError({ reason: 'Busy', detail: error.detail });
  }
};

/** Whether an Agent on the sending Device may reach this one: Allow Agents from this Device; this Device's own may. */
const agentsAllowed = (sender: InboxSender): Effect.Effect<boolean> =>
  Option.isSome(sender) ? sender.value.allowsAgents : Effect.succeed(true);

/**
 * The receiver's gate, before anything reaches a Session. A person's Message always passes; an Agent's needs Allow
 * Agents from this Device for the Paired device it came over. Either is refused as a loop past
 * `MAX_CROSS_DEVICE_HOPS`, or when the target Session is already in its chain (the sender included).
 */
const admit = Effect.fnUntraced(function* (
  provenance: SentProvenance,
  sender: InboxSender,
  target: Option.Option<{ readonly deviceId: DeviceId; readonly sessionId: SessionId }>,
) {
  if (provenance.by === 'agent' && !(yield* agentsAllowed(sender))) {
    return yield* new MessagingError({
      reason: 'Forbidden',
      detail: 'Agents from that Device are not allowed to message this Device.',
    });
  }
  return yield* checkLoop(provenance, target);
});

/** Refused as a loop past `MAX_CROSS_DEVICE_HOPS`, or when the target Session is already in the chain. */
const checkLoop = (
  provenance: SentProvenance,
  target: Option.Option<{ readonly deviceId: DeviceId; readonly sessionId: SessionId }>,
): Effect.Effect<void, MessagingError> => {
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

/** How many receipts this Device keeps (in memory only); the oldest goes first. */
const MAX_RECEIPTS = 1000;

/** The Turn behind a receipt, and the Device it was minted for. */
interface Receipt {
  readonly owner: DeviceId;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}

const unknownReceipt = () =>
  new MessagingError({ reason: 'NotFound', detail: 'No such result handle.' });

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
    const senderOf = Effect.fnUntraced(function* (provenance: SentProvenance, sender: InboxSender) {
      const local = yield* identity.get;
      const from: MessageSender = {
        sessionId: provenance.sessionId,
        title: provenance.sessionTitle,
        projectName: provenance.projectName,
        hops: provenance.hops,
        device: {
          id: Option.match(sender, { onNone: () => local.id, onSome: (peer) => peer.deviceId }),
          name: provenance.deviceName,
        },
        by: provenance.by,
        chain: provenance.chain,
        ...(provenance.by === 'agent' && provenance.permissionMode !== undefined
          ? { permissionMode: provenance.permissionMode }
          : {}),
      };
      return { local, from };
    });

    const receipts = new Map<string, Receipt>();

    /** A fresh receipt for the Turn an Agent's Message started, known only to the Device that sent it. */
    const mint = Effect.fnUntraced(function* (
      sender: InboxSender,
      sessionId: SessionId,
      turnId: TurnId,
    ) {
      const owner = yield* ownerOf(sender);
      const receipt = randomBytes(18).toString('base64url');
      receipts.set(receipt, { owner, sessionId, turnId });
      for (const oldest of receipts.keys()) {
        if (receipts.size <= MAX_RECEIPTS) break;
        receipts.delete(oldest);
      }
      return receipt;
    });

    const ownerOf = (sender: InboxSender) =>
      Option.match(sender, {
        onNone: () => Effect.map(identity.get, (local) => local.id),
        onSome: (peer) => Effect.succeed(peer.deviceId),
      });

    /** How the Turn ended and the final Message text of that Turn, from the Session's Transcript. */
    const turnEnd = (sessionId: SessionId, turnId: TurnId) =>
      Effect.suspend(() => {
        // The Turn's agent Messages by id, as they grow with their deltas; the last one is the final text.
        const texts = new Map<string, string>();
        let last: string | undefined;
        return sessions.events(sessionId).pipe(
          Stream.map((item): TurnResult | undefined => {
            if (item._tag !== 'Transcript') return undefined;
            const entry = item.event.item;
            if (entry._tag === 'Message' && entry.role === 'agent' && entry.turnId === turnId) {
              texts.set(
                entry.id,
                entry.parts.flatMap((part) => (part._tag === 'text' ? [part.text] : [])).join(''),
              );
              last = entry.id;
            } else if (entry._tag === 'MessageDelta' && texts.has(entry.id)) {
              texts.set(entry.id, (texts.get(entry.id) ?? '') + entry.text);
            } else if (entry._tag === 'TurnEnded' && entry.turnId === turnId) {
              const text = last === undefined ? '' : (texts.get(last) ?? '');
              return { _tag: 'Ended', outcome: entry.outcome, text };
            }
            return undefined;
          }),
          Stream.filter((ended): ended is TurnResult => ended !== undefined),
          Stream.runHead,
        );
      });

    const deliver = Effect.fn('Inbox.deliver')(function* (
      input: DeliverInput,
      sender: InboxSender,
    ): Effect.fn.Return<Accepted, MessagingError> {
      const { local, from } = yield* senderOf(input.provenance, sender);
      yield* admit(
        input.provenance,
        sender,
        Option.some({ deviceId: local.id, sessionId: input.sessionId }),
      );
      const parts: ReadonlyArray<MessagePart> = [{ _tag: 'text', text: input.text }];
      if (input.provenance.by === 'agent') {
        // An Agent's Message never waits in a Queue: a Session that is busy refuses it.
        const turnId = yield* sessions
          .prompt(input.sessionId, parts, from)
          .pipe(Effect.mapError(fromSessionError));
        return {
          delivery: 'started',
          receipt: yield* mint(sender, input.sessionId, turnId),
        };
      }
      const delivery = yield* sessions
        .enqueueFrom(input.sessionId, parts, from)
        .pipe(Effect.mapError(fromSessionError));
      return { delivery };
    });

    const start = Effect.fn('Inbox.start')(function* (
      input: StartInput,
      sender: InboxSender,
    ): Effect.fn.Return<Started, MessagingError> {
      const { from } = yield* senderOf(input.provenance, sender);
      yield* admit(input.provenance, sender, Option.none());
      const sessionId = yield* sessions
        .create(input.projectId)
        .pipe(Effect.mapError(fromSessionError));
      const parts = seededParts(input.text, input.summary);
      if (input.provenance.by === 'agent') {
        const turnId = yield* sessions
          .prompt(sessionId, parts, from)
          .pipe(Effect.mapError(fromSessionError));
        return { sessionId, receipt: yield* mint(sender, sessionId, turnId) };
      }
      yield* sessions.enqueueFrom(sessionId, parts, from).pipe(Effect.mapError(fromSessionError));
      return { sessionId };
    });

    const result = Effect.fn('Inbox.result')(function* (
      input: { readonly receipt: string; readonly timeoutMs: number },
      sender: InboxSender,
    ): Effect.fn.Return<TurnResult, MessagingError> {
      const found = receipts.get(input.receipt);
      if (found === undefined || found.owner !== (yield* ownerOf(sender)))
        return yield* unknownReceipt();
      const wait = Math.min(Math.max(input.timeoutMs, 0), MAX_RESULT_WAIT_MS);
      const ended = yield* turnEnd(found.sessionId, found.turnId).pipe(
        Effect.mapError(fromSessionError),
        Effect.timeoutOption(Duration.millis(wait)),
      );
      const pending: TurnResult = { _tag: 'Pending' };
      return Option.isSome(ended) && Option.isSome(ended.value) ? ended.value.value : pending;
    });

    return Inbox.of({ deliver, start, result });
  }),
);
