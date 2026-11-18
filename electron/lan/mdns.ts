import { Context, type Effect, type Scope, type Stream } from 'effect';
import type { DeviceId, NearbyDevice } from '../../src/shared/devices/devices.rpc';

/** The mDNS service type every hosting Device announces: `_spence._tcp`. */
export const SERVICE_TYPE = 'spence';

/** What a hosting Device announces; nothing else goes into the service metadata. */
export interface Announcement {
  readonly id: DeviceId;
  readonly name: string;
  readonly port: number;
  readonly protocolVersion: number;
}

/** A Device announcing itself (again, or with new metadata), or withdrawing. */
export type SightingEvent =
  | { readonly _tag: 'Up'; readonly device: NearbyDevice }
  | { readonly _tag: 'Down'; readonly id: DeviceId };

/** One open mDNS responder: a socket bound for multicast. Closing its scope destroys it. */
export interface MdnsResponder {
  /** Announces until the scope closes. */
  readonly announce: (announcement: Announcement) => Effect.Effect<void, never, Scope.Scope>;
  /** What other Devices announce, while the stream runs. */
  readonly browse: Stream.Stream<SightingEvent>;
}

/**
 * The mDNS boundary: the only place that touches multicast. Live it is `bonjour-service`; specs and e2e use a fake,
 * so `npm run verify` never opens a multicast socket.
 */
export class Mdns extends Context.Service<
  Mdns,
  {
    /** Opens a responder for the scope; nothing is bound until this runs. */
    readonly open: Effect.Effect<MdnsResponder, never, Scope.Scope>;
    /** Emits when the network interfaces change, so the responder is destroyed and opened again. */
    readonly networkChanges: Stream.Stream<void>;
  }
>()('lan/Mdns') {}
