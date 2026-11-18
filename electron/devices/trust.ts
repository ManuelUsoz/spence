import { Context, Effect, Layer, type Option } from 'effect';
import type { DeviceId } from '../../src/shared/devices/devices.rpc';

/** What a Remote device presents when it opens a connection: its id and the bearer token it was issued. */
export interface Credentials {
  readonly deviceId: string;
  readonly token: string;
}

/** Decides, once per connection, whether a Remote device is a Paired device. */
export class DeviceTrust extends Context.Service<
  DeviceTrust,
  {
    /** The Paired device these credentials belong to; none when they match no Pairing. */
    readonly authorize: (credentials: Credentials) => Effect.Effect<Option.Option<DeviceId>>;
  }
>()('devices/DeviceTrust') {}

/**
 * No Device is Paired yet, so every connection is refused. Pairing replaces this with the trust store of token
 * hashes; until then hosting listens but lets nobody in.
 */
export const layerDeviceTrustNone = Layer.succeed(DeviceTrust, {
  authorize: () => Effect.succeedNone,
});
