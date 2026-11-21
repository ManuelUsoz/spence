import { Context, Duration, Layer } from 'effect';
import { PROTOCOL_VERSION } from '../../src/shared/remote/remote.rpc';

/** How this Device takes part in the LAN: where its listener binds and which protocol it speaks. */
export class LanConfig extends Context.Service<
  LanConfig,
  {
    /** `undefined` binds every interface. */
    readonly host: string | undefined;
    /** The first port tried; `0` lets the OS pick. */
    readonly port: number;
    /** How many consecutive ports are tried before hosting gives up. */
    readonly portAttempts: number;
    /** The protocol version this Device speaks: `PROTOCOL_VERSION`, except for a test Device playing an old one. */
    readonly protocolVersion: number;
    /**
     * How long a Device whose connection dropped shows Reconnecting, retried fast (500 ms x 1.5, up to 5 s), before
     * it shows Offline and is retried every 30 s: the spec's first minute.
     */
    readonly reconnectingFor: Duration.Input;
  }
>()('lan/LanConfig') {}

/** The default port is fixed so a typed `host:port` keeps working; the next free one is used if it is taken. */
export const DEFAULT_PORT = 47_120;

/** Every interface in use; loopback only under e2e, so a test run never opens a port to the network. */
export const layerLanConfigLive = Layer.sync(LanConfig, () => ({
  host: process.env['SPENCE_E2E'] === '1' ? '127.0.0.1' : undefined,
  port: DEFAULT_PORT,
  portAttempts: 20,
  protocolVersion: PROTOCOL_VERSION,
  // e2e shortens it so a spec sees Offline without waiting a minute.
  reconnectingFor: process.env['SPENCE_E2E'] === '1' ? Duration.seconds(10) : Duration.minutes(1),
}));
