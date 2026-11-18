import { Effect, Layer, Schema } from 'effect';
import { type Rpc, RpcClient, type RpcGroup } from 'effect/rpc';
import { Socket } from 'effect/socket';
import type { ConnectionOptions } from 'node:tls';
import { type ClientOptions, WebSocket } from 'ws';
import { layerPortSerialization } from '../../src/shared/rpc/message-port-protocol';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import { fingerprintOf } from '../devices/certificate';
import type { Credentials } from '../devices/trust';
import { DEVICE_HEADER } from './server';

/** Where a Remote device listens and who it must prove to be. The address is only a hint. */
export interface RemoteEndpoint {
  /** `wss://host:port`. */
  readonly url: string;
  /** The Remote device's pinned certificate (PEM): the only root trusted for this connection. */
  readonly certificate: string;
  /** What this Device presents: its own id and the token the Remote device issued it. */
  readonly credentials: Credentials;
}

/** The listener presented a certificate other than the pinned one: refused, never re-trusted silently. */
export class IdentityChanged extends Schema.TaggedError<IdentityChanged>()('IdentityChanged', {
  reason: Schema.Literals(['FingerprintMismatch']),
  detail: Schema.String,
}) {}

/**
 * Opens the TLS WebSocket with the pinned certificate as the only CA (verification stays on) and checks its
 * SHA-256 fingerprint in place of the hostname, so a changed address never matters and a changed key always does.
 */
const pinnedWebSocket = (endpoint: RemoteEndpoint) => {
  const fingerprint = fingerprintOf(endpoint.certificate);
  const tls: ConnectionOptions = {
    ca: endpoint.certificate,
    checkServerIdentity: (_host, certificate) =>
      certificate.fingerprint256 === fingerprint
        ? undefined
        : new IdentityChanged({
            reason: 'FingerprintMismatch',
            detail: `Expected ${fingerprint}, got ${certificate.fingerprint256}.`,
          }),
  };
  const headers = {
    authorization: `Bearer ${endpoint.credentials.token}`,
    [DEVICE_HEADER]: endpoint.credentials.deviceId,
  };
  // ws hands these options to tls.connect as they are; @types/ws still types `checkServerIdentity` with its
  // legacy (servername, cert) => boolean shape, so the node:tls one is passed through the wider type.
  const options = { ...tls, headers } as ClientOptions;
  return Layer.succeed(Socket.WebSocketConstructor, (url) => new WebSocket(url, options));
};

/**
 * An RPC client for `group` on a Remote device, over the same binary serialization as the local port, for the life
 * of the scope. It reconnects on its own but never resumes streams. Devices use `connectRemote`; another group only
 * probes what a Remote device refuses to serve.
 */
export const connect = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  endpoint: RemoteEndpoint,
) {
  // Built into the caller's scope: the socket lives as long as the client, not just this call.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(endpoint.url)),
      Layer.provide(pinnedWebSocket(endpoint)),
      Layer.provide(layerPortSerialization),
    ),
  );
  return yield* RpcClient.make(group).pipe(Effect.provide(protocol));
});

/** An RPC client for a Remote device's `RemoteRpcs`, for the life of the scope. */
export const connectRemote = (endpoint: RemoteEndpoint) => connect(RemoteRpcs, endpoint);
