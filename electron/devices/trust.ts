import { Context, type Effect, type Option, type Stream } from 'effect';
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
    /** Allow Agents from this Device, as set now for a Paired device: read at each Message, never cached. */
    readonly allowsAgents: (id: DeviceId) => Effect.Effect<boolean>;
    /** Devices whose credentials stopped being valid (unpaired, or paired again): their connections close. */
    readonly revocations: Stream.Stream<DeviceId>;
  }
>()('devices/DeviceTrust') {}
