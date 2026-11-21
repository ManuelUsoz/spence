import { Effect, Layer, Schema } from 'effect';
import { type Rpc, RpcClient, type RpcGroup } from 'effect/rpc';
import { Socket } from 'effect/socket';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { type ClientOptions, WebSocket } from 'ws';
import { layerPortSerialization } from '../../src/shared/rpc/message-port-protocol';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import { fingerprintOf } from '../devices/certificate';
import type { Credentials } from '../devices/trust';
import {
  MAX_PAIR_BODY_BYTES,
  PAIR_PATH,
  type PairReply,
  PairReplyJson,
  type PairRequest,
  PairRequestJson,
} from './pairing-wire';
import { DEVICE_HEADER, PROTOCOL_HEADER } from './server';

/** Where a Remote device listens and who it must prove to be. The address is only a hint. */
export interface RemoteEndpoint {
  /** `wss://host:port`. */
  readonly url: string;
  /** The Remote device's pinned certificate (PEM): the only root trusted for this connection. */
  readonly certificate: string;
  /** What this Device presents: its own id and the token the Remote device issued it. */
  readonly credentials: Credentials;
  /** The protocol version this Device speaks, checked by the listener before anything else. */
  readonly protocolVersion: number;
}

/** The listener presented a certificate other than the pinned one: refused, never re-trusted silently. */
export class IdentityChanged extends Schema.TaggedError<IdentityChanged>()('IdentityChanged', {
  reason: Schema.Literals(['FingerprintMismatch']),
  detail: Schema.String,
}) {}

/** Why a Remote device could not be reached with these credentials. */
export class RemoteRefused extends Schema.TaggedError<RemoteRefused>()('RemoteRefused', {
  /** `Unreachable`: nothing answered (or not as Spence). `Unauthorized`: it no longer knows our credentials. */
  reason: Schema.Literals(['Unreachable', 'Unauthorized', 'IdentityChanged', 'VersionMismatch']),
  detail: Schema.String,
  /** The version the Remote device speaks, for `VersionMismatch`. */
  remoteVersion: Schema.NullOr(Schema.Int),
}) {}

/**
 * TLS refusals of the presented certificate. The pinned certificate is the only root, so any other certificate fails
 * the chain check (a new key) before the fingerprint check (`IdentityChanged`) is even reached.
 */
const CERTIFICATE_REFUSALS: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE',
]);

/** Whether a connection failed because the Device presented another certificate than the pinned one. */
const isIdentityChange = (error: Error): boolean =>
  error instanceof IdentityChanged ||
  ('code' in error && typeof error.code === 'string' && CERTIFICATE_REFUSALS.has(error.code));

/** How long reaching a Device may take before it counts as unreachable. */
const CONNECT_TIMEOUT_MS = 5_000;

/** `host:port` from an address hint; `undefined` when it is not one. IPv6 goes in brackets. */
export const parseAddress = (
  address: string,
): { readonly host: string; readonly port: number } | undefined => {
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^\s:[\]/]+)):(\d{1,5})$/.exec(address.trim());
  if (match === null) return undefined;
  const host = match[1] ?? match[2];
  const port = Number(match[3]);
  return host === undefined || port < 1 || port > 65_535 ? undefined : { host, port };
};

/** `wss://host:port` for an address hint. */
export const urlOf = (address: { readonly host: string; readonly port: number }): string =>
  `wss://${address.host.includes(':') ? `[${address.host}]` : address.host}:${address.port}`;

/**
 * TLS options trusting only `certificate` (verification stays on) and checking its SHA-256 fingerprint in place of
 * the hostname, so a changed address never matters and a changed key always does.
 */
const pinnedTls = (certificate: string): ConnectionOptions => {
  const fingerprint = fingerprintOf(certificate);
  return {
    ca: certificate,
    checkServerIdentity: (_host, presented) =>
      presented.fingerprint256 === fingerprint
        ? undefined
        : new IdentityChanged({
            reason: 'FingerprintMismatch',
            detail: `Expected ${fingerprint}, got ${presented.fingerprint256}.`,
          }),
  };
};

const wsOptions = (endpoint: RemoteEndpoint): ClientOptions =>
  // ws hands these options to tls.connect as they are; @types/ws still types `checkServerIdentity` with its
  // legacy (servername, cert) => boolean shape, so the node:tls one is passed through the wider type.
  ({
    ...pinnedTls(endpoint.certificate),
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    headers: {
      authorization: `Bearer ${endpoint.credentials.token}`,
      [DEVICE_HEADER]: endpoint.credentials.deviceId,
      [PROTOCOL_HEADER]: String(endpoint.protocolVersion),
    },
  }) as ClientOptions;

/** What a caller learns about the sockets under a client. */
export interface ConnectHooks {
  /** A socket closed (dropped, or a reconnect attempt refused); the client would otherwise retry on its own. */
  readonly onClose?: () => void;
}

const pinnedWebSocket = (endpoint: RemoteEndpoint, hooks: ConnectHooks) =>
  Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new WebSocket(url, wsOptions(endpoint));
    if (hooks.onClose !== undefined) socket.once('close', hooks.onClose);
    return socket;
  });

/**
 * An RPC client for `group` on a Remote device, over the same binary serialization as the local port, for the life
 * of the scope. It reconnects on its own but never resumes streams. Devices use `connectRemote`; another group only
 * probes what a Remote device refuses to serve.
 */
export const connect = Effect.fnUntraced(function* <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  endpoint: RemoteEndpoint,
  hooks: ConnectHooks = {},
) {
  // Built into the caller's scope: the socket lives as long as the client, not just this call.
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(endpoint.url)),
      Layer.provide(pinnedWebSocket(endpoint, hooks)),
      Layer.provide(layerPortSerialization),
    ),
  );
  return yield* RpcClient.make(group).pipe(Effect.provide(protocol));
});

/** An RPC client for a Remote device's `RemoteRpcs`, for the life of the scope. */
export const connectRemote = (endpoint: RemoteEndpoint, hooks: ConnectHooks = {}) =>
  connect(RemoteRpcs, endpoint, hooks);

const unreachable = (detail: string) =>
  new RemoteRefused({ reason: 'Unreachable', detail, remoteVersion: null });

/**
 * Opens and closes one connection, to learn whether the Remote device lets these credentials in: the WebSocket
 * upgrade is where it checks the protocol version and the token, so its answer there is the whole verdict.
 */
export const probe = (endpoint: RemoteEndpoint): Effect.Effect<void, RemoteRefused> =>
  Effect.callback<void, RemoteRefused>((resume) => {
    const socket = new WebSocket(endpoint.url, wsOptions(endpoint));
    let settled = false;
    const finish = (outcome: Effect.Effect<void, RemoteRefused>) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      // A late error from the torn-down socket must not go unhandled.
      socket.on('error', () => undefined);
      socket.terminate();
      resume(outcome);
    };
    socket.once('open', () => finish(Effect.void));
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode ?? 0;
      const header = response.headers[PROTOCOL_HEADER];
      const remoteVersion = typeof header === 'string' ? Number(header) : Number.NaN;
      if (status === 426 && Number.isInteger(remoteVersion)) {
        finish(
          Effect.fail(
            new RemoteRefused({
              reason: 'VersionMismatch',
              detail: `It speaks protocol ${remoteVersion}.`,
              remoteVersion,
            }),
          ),
        );
      } else if (status === 401) {
        finish(
          Effect.fail(
            new RemoteRefused({
              reason: 'Unauthorized',
              detail: 'It refused these credentials.',
              remoteVersion: null,
            }),
          ),
        );
      } else {
        finish(Effect.fail(unreachable(`It answered ${status}.`)));
      }
    });
    socket.once('error', (error) => {
      finish(
        Effect.fail(
          isIdentityChange(error)
            ? new RemoteRefused({
                reason: 'IdentityChanged',
                detail: error.message,
                remoteVersion: null,
              })
            : unreachable(error.message),
        ),
      );
    });
    return Effect.sync(() => {
      settled = true;
      socket.removeAllListeners();
      socket.on('error', () => undefined);
      socket.terminate();
    });
  });

const toPem = (raw: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${(raw.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * The certificate a listener presents, before any trust exists. Nothing is sent on this connection and nothing it
 * says is believed: the PEM only becomes trusted once the pairing code proof, bound to its fingerprint, succeeds,
 * and every later connection pins it with verification on. This is the one place verification is not enforced,
 * because there is no root to verify against yet.
 */
export const fetchCertificate = (address: {
  readonly host: string;
  readonly port: number;
}): Effect.Effect<string, RemoteRefused> =>
  Effect.callback<string, RemoteRefused>((resume) => {
    const socket = tlsConnect({
      host: address.host,
      port: address.port,
      rejectUnauthorized: false,
      timeout: CONNECT_TIMEOUT_MS,
    });
    let settled = false;
    const finish = (outcome: Effect.Effect<string, RemoteRefused>) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(outcome);
    };
    socket.once('secureConnect', () => {
      const presented = socket.getPeerCertificate(false);
      finish(
        presented.raw === undefined
          ? Effect.fail(unreachable('No certificate was presented.'))
          : Effect.succeed(toPem(presented.raw)),
      );
    });
    socket.once('timeout', () => finish(Effect.fail(unreachable('Timed out.'))));
    socket.once('error', (error) => finish(Effect.fail(unreachable(error.message))));
    return Effect.sync(() => {
      settled = true;
      socket.destroy();
    });
  });

/** Sends the viewer's half of the ceremony to the host, pinned to the certificate the proof is bound to. */
export const requestPairing = (
  address: { readonly host: string; readonly port: number },
  certificate: string,
  body: PairRequest,
): Effect.Effect<PairReply, RemoteRefused | IdentityChanged> =>
  Effect.callback<PairReply, RemoteRefused | IdentityChanged>((resume) => {
    const payload = Schema.encodeSync(PairRequestJson)(body);
    const request = httpsRequest({
      ...pinnedTls(certificate),
      host: address.host,
      port: address.port,
      method: 'POST',
      path: PAIR_PATH,
      timeout: CONNECT_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    });
    let settled = false;
    const finish = (outcome: Effect.Effect<PairReply, RemoteRefused | IdentityChanged>) => {
      if (settled) return;
      settled = true;
      request.destroy();
      resume(outcome);
    };
    request.once('response', (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_PAIR_BODY_BYTES) finish(Effect.fail(unreachable('Reply too large.')));
        else chunks.push(chunk);
      });
      response.once('end', () => {
        const decoded = Schema.decodeUnknownExit(PairReplyJson)(
          Buffer.concat(chunks).toString('utf8'),
        );
        finish(
          decoded._tag === 'Success'
            ? Effect.succeed(decoded.value)
            : Effect.fail(unreachable(`Not a Spence pairing reply (${response.statusCode}).`)),
        );
      });
    });
    request.once('timeout', () => finish(Effect.fail(unreachable('Timed out.'))));
    request.once('error', (error) =>
      finish(Effect.fail(error instanceof IdentityChanged ? error : unreachable(error.message))),
    );
    request.end(payload);
    return Effect.sync(() => {
      settled = true;
      request.destroy();
    });
  });
