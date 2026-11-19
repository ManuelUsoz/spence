import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** A Device's stable identity: a random UUID made on its first use, carried in its certificate. */
export const DeviceId = Schema.String.pipe(Schema.brand('DeviceId')).annotate({
  identifier: 'DeviceId',
});
export type DeviceId = typeof DeviceId.Type;

/** The longest display name a Device takes. */
export const DEVICE_NAME_MAX = 64;

/** How many digits a pairing code has. */
export const PAIRING_CODE_LENGTH = 6;

/** The Local device as Settings > Devices shows it. */
export const LocalDevice = Schema.Struct({
  id: DeviceId,
  /** The display name other Devices see; defaults to the OS hostname. */
  name: Schema.String,
  /** Whether other Devices may connect. Off by default: off means no listener. */
  hosting: Schema.Boolean,
  /** The port the listener is bound to while hosting; `null` while off. */
  port: Schema.NullOr(Schema.Int),
}).annotate({ identifier: 'LocalDevice' });
export type LocalDevice = typeof LocalDevice.Type;

/** A Paired device as this Device remembers it. Paired does not mean reachable. */
export const PairedDevice = Schema.Struct({
  id: DeviceId,
  /** Its display name when last seen. */
  name: Schema.String,
  /** Where it was last reached (`host:port`): only a hint, identity is the id and the pinned certificate. */
  address: Schema.NullOr(Schema.String),
  /** It refused this Device's credentials: it unpaired this Device. Only removal is left. */
  unpairedByOther: Schema.Boolean,
  /** Allow Agents from this Device: its Agents may send Messages and start Sessions here. Off by default. */
  allowAgents: Schema.Boolean,
}).annotate({ identifier: 'PairedDevice' });
export type PairedDevice = typeof PairedDevice.Type;

/**
 * A hosting Device announcing itself on the LAN. Only a hint for where to pair: identity is still proven by its
 * certificate (device id and fingerprint) and the pairing code.
 */
export const NearbyDevice = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
  /** Where it listens, as `host:port`. */
  address: Schema.String,
  protocolVersion: Schema.Int,
}).annotate({ identifier: 'NearbyDevice' });
export type NearbyDevice = typeof NearbyDevice.Type;

/** Which side runs the older Spence, so must update before the two Devices talk again. */
export const UpdateSide = Schema.Literals(['Local', 'Remote']).annotate({
  identifier: 'UpdateSide',
});
export type UpdateSide = typeof UpdateSide.Type;

/** Whether a Paired device can be reached now, and if not, why. */
export const PairedDeviceStatus = Schema.Union([
  /** It answered with these credentials; `name` is its display name now. */
  Schema.TaggedStruct('Online', { name: Schema.String }),
  /** Not reachable: not hosting, asleep, gone from the network or no address known. */
  Schema.TaggedStruct('Offline', {}),
  /** It refused this Device's credentials: it unpaired this Device. */
  Schema.TaggedStruct('UnpairedByOther', {}),
  /** It presented another certificate than the pinned one: refused, never re-trusted silently. */
  Schema.TaggedStruct('IdentityChanged', {}),
  /** It speaks another protocol version; still paired. */
  Schema.TaggedStruct('NeedsUpdate', {
    update: UpdateSide,
    localVersion: Schema.Int,
    remoteVersion: Schema.Int,
  }),
]).annotate({ identifier: 'PairedDeviceStatus' });
export type PairedDeviceStatus = typeof PairedDeviceStatus.Type;

/**
 * The RPC header naming the Device a Device-scoped call is for (`DeviceScopedRpcs`). Absent means the Local
 * device. Main routes on it; a Remote device never does, so it never forwards a call to a third Device.
 */
export const DEVICE_SCOPE_HEADER = 'x-spence-target-device';

/** A Paired device and whether this Device has a live connection to it now. */
export const ConnectionStatus = Schema.Union([
  /** Reaching it now. */
  Schema.TaggedStruct('Connecting', {}),
  /**
   * Its connection dropped a moment ago and it is being reached again, fast at first. Becomes `Offline` (still
   * retried, less often) when that does not work for a while.
   */
  Schema.TaggedStruct('Reconnecting', {}),
  PairedDeviceStatus,
]).annotate({ identifier: 'ConnectionStatus' });
export type ConnectionStatus = typeof ConnectionStatus.Type;

/** One Paired device as the window sees it: Online ones can be driven, the rest only show an indicator. */
export const DeviceConnection = Schema.Struct({
  id: DeviceId,
  /** Its display name, as it last answered. */
  name: Schema.String,
  status: ConnectionStatus,
}).annotate({ identifier: 'DeviceConnection' });
export type DeviceConnection = typeof DeviceConnection.Type;

/** A Remote device connected to this Device while it hosts (a viewer), by the name it paired under. */
export const ConnectedViewer = Schema.Struct({
  id: DeviceId,
  name: Schema.String,
}).annotate({ identifier: 'ConnectedViewer' });
export type ConnectedViewer = typeof ConnectedViewer.Type;

/** The hosting side of Pairing: the code it shows, and how its last pairing window ended. */
export const PairingWindow = Schema.Union([
  /** No code is shown. */
  Schema.TaggedStruct('Idle', {}),
  /** A code is open: single use, closed at `expiresAt` (epoch ms) or after too many wrong tries. */
  Schema.TaggedStruct('Open', { code: Schema.String, expiresAt: Schema.Number }),
  Schema.TaggedStruct('Paired', { name: Schema.String }),
  Schema.TaggedStruct('Expired', {}),
  Schema.TaggedStruct('TooManyAttempts', {}),
]).annotate({ identifier: 'PairingWindow' });
export type PairingWindow = typeof PairingWindow.Type;

/** Everything Settings > Devices shows about Pairing, sent again whenever any of it changes. */
export const DevicesState = Schema.Struct({
  pairing: PairingWindow,
  paired: Schema.Array(PairedDevice),
}).annotate({ identifier: 'DevicesState' });
export type DevicesState = typeof DevicesState.Type;

/**
 * `InvalidName`: the name is empty after trimming or longer than `DEVICE_NAME_MAX`.
 * `ListenFailed`: hosting could not open its listener (no free port); hosting stays off.
 * `NotHosting`: a pairing code needs hosting on.
 * `SecretStorageUnavailable`: the OS cannot store secrets safely here, so Pairing is refused (no plaintext fallback).
 * `NotFound`: no Paired device has that id.
 */
export class DevicesError extends Schema.TaggedError<DevicesError>()('DevicesError', {
  reason: Schema.Literals([
    'InvalidName',
    'ListenFailed',
    'NotHosting',
    'SecretStorageUnavailable',
    'NotFound',
  ]),
  detail: Schema.String,
}) {}

/**
 * Why pairing with a typed address and code failed.
 * `InvalidAddress`: not `host:port`. `Unreachable`: nothing answered there. `NoCode`: the other Device shows no open
 * code (none, expired, or closed after too many wrong tries). `WrongCode`: the code did not match.
 * `SelfPair`: the address is this Device. `AlreadyPaired`: that Device id is paired with another certificate; unpair
 * it first. `SecretStorageUnavailable`: one of the two Devices cannot store secrets safely. `Rejected`: the other
 * Device did not prove it knows the code (a possible impostor).
 */
export class PairingError extends Schema.TaggedError<PairingError>()('PairingError', {
  reason: Schema.Literals([
    'InvalidAddress',
    'Unreachable',
    'NoCode',
    'WrongCode',
    'SelfPair',
    'AlreadyPaired',
    'SecretStorageUnavailable',
    'Rejected',
  ]),
  detail: Schema.String,
}) {}

/** The two Devices speak different protocol versions; `reason` names the side that must update. */
export class VersionMismatch extends Schema.TaggedError<VersionMismatch>()('VersionMismatch', {
  reason: Schema.Literals(['UpdateLocal', 'UpdateRemote']),
  detail: Schema.String,
  localVersion: Schema.Int,
  remoteVersion: Schema.Int,
}) {}

const ById = { id: DeviceId };

/** The Local-only Devices domain: never served to another Device. */
export const DevicesRpcs = RpcGroup.make(
  Rpc.make('Devices.local', { success: LocalDevice }),
  Rpc.make('Devices.rename', {
    payload: { name: Schema.String },
    success: LocalDevice,
    error: DevicesError,
  }),
  Rpc.make('Devices.setHosting', {
    payload: { on: Schema.Boolean },
    success: LocalDevice,
    error: DevicesError,
  }),
  /** The pairing window and the Paired devices now, then again on every change. */
  Rpc.make('Devices.watch', { success: DevicesState, stream: true }),
  /** The Devices hosting nearby (never this one), now and on every change; looks for them while subscribed. */
  Rpc.make('Devices.nearby', { success: Schema.Array(NearbyDevice), stream: true }),
  /** Shows a fresh pairing code (replacing an open one). Needs hosting on and safe secret storage. */
  Rpc.make('Devices.startPairing', { success: PairingWindow, error: DevicesError }),
  /** Closes the open pairing code, if any. */
  Rpc.make('Devices.cancelPairing', {}),
  /** Pairs with the Device hosting at `address` (`host:port`) that shows `code`. */
  Rpc.make('Devices.pair', {
    payload: { address: Schema.String, code: Schema.String },
    success: PairedDevice,
    error: Schema.Union([PairingError, VersionMismatch]),
  }),
  /** Tries to reach a Paired device with this Device's credentials. */
  Rpc.make('Devices.check', { payload: ById, success: PairedDeviceStatus, error: DevicesError }),
  /** Every Paired device with its connection now, then again on every change. */
  Rpc.make('Devices.connections', { success: Schema.Array(DeviceConnection), stream: true }),
  /** Reaches a Paired device now (Retry); how it went shows on `Devices.connections`. */
  Rpc.make('Devices.connect', { payload: ById, error: DevicesError }),
  /** The Remote devices connected to this Device now (its viewers), then again on every change. */
  Rpc.make('Devices.viewers', { success: Schema.Array(ConnectedViewer), stream: true }),
  /** Closes a viewer's connections to this Device. It stays paired, so it may connect again. */
  Rpc.make('Devices.disconnect', { payload: ById }),
  /** Forgets a Paired device and closes its connections; it then finds itself unpaired by this side. */
  Rpc.make('Devices.unpair', { payload: ById, error: DevicesError }),
  /** Turns Allow Agents from this Device on or off for a Paired device; it applies to its next Message. */
  Rpc.make('Devices.setAllowAgents', {
    payload: { id: DeviceId, allow: Schema.Boolean },
    error: DevicesError,
  }),
);
