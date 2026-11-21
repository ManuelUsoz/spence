import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { DeviceId } from '../devices/devices.rpc';
import { PermissionMode, ProjectId } from '../projects/projects.rpc';
import { ChainLink, SessionId, TurnOutcome } from '../sessions/sessions.rpc';

/**
 * Why a Cross-device message (or a Session started on another Device) was not accepted. Nothing is queued for later:
 * - `Offline`: the target Device is not connected, or the connection failed.
 * - `Busy`: the target Session cannot take a Message now (an Agent-sent one while a Turn runs, or a Session that
 *   needs the user first). A person's Message to a busy Session is queued as usual instead.
 * - `NotFound`: no such Session or Project on the target Device.
 * - `Forbidden`: the target refuses this sender (a read-only Worker, or Agents not allowed from that Device).
 * - `Loop`: the Message has crossed too many Sessions, or would come back to one already in its chain.
 * - `Unavailable`: the target's Agent cannot run (not installed, needs login, cannot start).
 */
export class MessagingError extends Schema.TaggedError<MessagingError>()('MessagingError', {
  reason: Schema.Literals(['Offline', 'Busy', 'NotFound', 'Forbidden', 'Loop', 'Unavailable']),
  detail: Schema.String,
}) {}

/** Whether an accepted Message started a Turn at once or waits in the target Session's Queue. */
export const Delivery = Schema.Literals(['started', 'queued']).annotate({
  identifier: 'Delivery',
});
export type Delivery = typeof Delivery.Type;

/**
 * A Message the target Device accepted. `receipt` is set for an Agent's Message only: a token the target minted for
 * the sending Device, to await the outcome of the Turn the Message started (`Inbox.result`).
 */
export const Accepted = Schema.Struct({
  delivery: Delivery,
  receipt: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Accepted' });
export type Accepted = typeof Accepted.Type;

/** A Session the target Device started with the first Message; `receipt` as in `Accepted`. */
export const Started = Schema.Struct({
  sessionId: SessionId,
  receipt: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'Started' });
export type Started = typeof Started.Type;

/**
 * The outcome of the Turn an Agent's Message started on another Device: how it ended and the final Message text of
 * that Turn, or `Pending` while it still runs when the wait is over.
 */
export const TurnResult = Schema.Union([
  Schema.TaggedStruct('Ended', { outcome: TurnOutcome, text: Schema.String }),
  Schema.TaggedStruct('Pending', {}),
]).annotate({ identifier: 'TurnResult' });
export type TurnResult = typeof TurnResult.Type;

/** The longest one `Inbox.result` call waits. */
export const MAX_RESULT_WAIT_MS = 300_000;

/** Who sent a Cross-device message: a person from a Spence action, or an Agent through its tools. */
export const SentBy = Schema.Literals(['person', 'agent']).annotate({ identifier: 'SentBy' });
export type SentBy = typeof SentBy.Type;

export { ChainLink } from '../sessions/sessions.rpc';

/** The most Session-to-Session hops a Message may have taken before it is refused as a loop. */
export const MAX_CROSS_DEVICE_HOPS = 3;

/**
 * Provenance as the sending Device declares it. The receiving Device takes the sender's Device id from the
 * connection it arrived on, never from here; the name is only what the sender calls itself.
 */
export const SentProvenance = Schema.Struct({
  by: SentBy,
  deviceName: Schema.String,
  sessionId: SessionId,
  sessionTitle: Schema.String,
  projectName: Schema.String,
  /** How many Session-to-Session hops led to this Message; a person's Message starts at 0. */
  hops: Schema.Number,
  /** The Sessions this Message (and the Turns that led to it) came through, the sender last. */
  chain: Schema.Array(ChainLink),
  /** The sending Session's Permission mode when its Agent asked to send; shown to the receiver, never applied there. */
  permissionMode: Schema.optionalKey(PermissionMode),
}).annotate({ identifier: 'SentProvenance' });
export type SentProvenance = typeof SentProvenance.Type;

/** The open Session a person sends from, as the window knows it. */
export const SendingSession = Schema.Struct({
  /** The Device the Session lives on; absent for the Local device. */
  device: Schema.optionalKey(DeviceId),
  sessionId: SessionId,
  title: Schema.String,
  projectName: Schema.String,
}).annotate({ identifier: 'SendingSession' });
export type SendingSession = typeof SendingSession.Type;

/**
 * What the window asks for. Local-only (never in `RemoteRpcs`): main sends to the Local device directly and to a
 * Remote device over its connection, where it arrives through `InboxRpcs`.
 */
export const MessagingRpcs = RpcGroup.make(
  /** Sends a person's Message to a Session on any Device; a busy Session queues it as the Composer would. */
  Rpc.make('Messaging.send', {
    payload: {
      from: SendingSession,
      device: Schema.optionalKey(DeviceId),
      sessionId: SessionId,
      text: Schema.String,
    },
    success: Delivery,
    error: MessagingError,
  }),
  /**
   * Starts a Session in a Project on any Device with a person's first Message, optionally seeded by a reviewed
   * Summary handoff of the sending Session. The new Session uses that Device's default Agent and Permission mode.
   */
  Rpc.make('Messaging.startSession', {
    payload: {
      from: SendingSession,
      device: Schema.optionalKey(DeviceId),
      projectId: ProjectId,
      text: Schema.String,
      summary: Schema.optionalKey(Schema.String),
    },
    success: SessionId,
    error: MessagingError,
  }),
);

/**
 * What a Device accepts from its Paired devices (part of `RemoteRpcs`): a Message for one of its Sessions, or a new
 * Session in one of its Projects, with the sender's Provenance. The sending Device is the authenticated connection.
 */
export const InboxRpcs = RpcGroup.make(
  Rpc.make('Inbox.deliver', {
    payload: { sessionId: SessionId, text: Schema.String, provenance: SentProvenance },
    success: Accepted,
    error: MessagingError,
  }),
  Rpc.make('Inbox.start', {
    payload: {
      projectId: ProjectId,
      text: Schema.String,
      summary: Schema.optionalKey(Schema.String),
      provenance: SentProvenance,
    },
    success: Started,
    error: MessagingError,
  }),
  /**
   * Waits up to `timeoutMs` (at most `MAX_RESULT_WAIT_MS`) for the Turn behind a `receipt` to end. A receipt is
   * known only to the Device it was minted for: any other, or an unknown one, is `NotFound`.
   */
  Rpc.make('Inbox.result', {
    payload: { receipt: Schema.String, timeoutMs: Schema.Number },
    success: TurnResult,
    error: MessagingError,
  }),
);
