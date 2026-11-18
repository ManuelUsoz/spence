import { Schema } from 'effect';
import { DEVICE_NAME_MAX, DeviceId, PairingError } from '../../src/shared/devices/devices.rpc';

/** The one path served without credentials: the pairing ceremony. Everything else needs a token. */
export const PAIR_PATH = '/pair';

/** The largest pairing request body read; a bigger one is refused unread. */
export const MAX_PAIR_BODY_BYTES = 64 * 1024;

/** The viewer's half of the ceremony, sent to the host it connected to with the host's certificate pinned. */
export const PairRequest = Schema.Struct({
  protocolVersion: Schema.Int,
  deviceId: DeviceId,
  name: Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX)),
  /** The viewer's own certificate (PEM): the host pins it to reach the viewer later. */
  certificate: Schema.String,
  /** Where the viewer hosts now, if it does: an address hint for the host. */
  port: Schema.NullOr(Schema.Int),
  /** The token the viewer issues the host. */
  token: Schema.String,
  /** `viewerProof` of the code, bound to both certificates. */
  proof: Schema.String,
});
export type PairRequest = typeof PairRequest.Type;

/** Refusals a host may give; the viewer reports them as `PairingError`. */
const RefusalReason = PairingError.fields.reason;

/** The host's answer. */
export const PairReply = Schema.Union([
  Schema.TaggedStruct('Paired', {
    deviceId: DeviceId,
    name: Schema.String,
    /** The token the host issues the viewer. */
    token: Schema.String,
    /** `hostProof` of the code: the host knew it too. */
    proof: Schema.String,
  }),
  Schema.TaggedStruct('Refused', { reason: RefusalReason, detail: Schema.String }),
  Schema.TaggedStruct('VersionMismatch', { protocolVersion: Schema.Int }),
]);
export type PairReply = typeof PairReply.Type;

export const PairRequestJson = Schema.fromJsonString(PairRequest);
export const PairReplyJson = Schema.fromJsonString(PairReply);
