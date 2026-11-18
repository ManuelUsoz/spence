import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';

/** A Device's stable identity: a random UUID made on its first use, carried in its certificate. */
export const DeviceId = Schema.String.pipe(Schema.brand('DeviceId')).annotate({
  identifier: 'DeviceId',
});
export type DeviceId = typeof DeviceId.Type;

/** The longest display name a Device takes. */
export const DEVICE_NAME_MAX = 64;

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

/**
 * `InvalidName`: the name is empty after trimming or longer than `DEVICE_NAME_MAX`.
 * `ListenFailed`: hosting could not open its listener (no free port); hosting stays off.
 */
export class DevicesError extends Schema.TaggedError<DevicesError>()('DevicesError', {
  reason: Schema.Literals(['InvalidName', 'ListenFailed']),
  detail: Schema.String,
}) {}

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
);
