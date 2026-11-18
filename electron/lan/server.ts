import { Effect, Exit, FiberSet, Option, Queue, Schema, Scope, Stream } from 'effect';
import { type Rpc, type RpcGroup, RpcServer } from 'effect/rpc';
import { NetAddress } from 'effect/net';
import { Socket, SocketServer } from 'effect/socket';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { DevicesError } from '../../src/shared/devices/devices.rpc';
import { layerPortSerialization } from '../../src/shared/rpc/message-port-protocol';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { DeviceCertificate } from '../devices/certificate';
import { PairingHost } from '../devices/pairing-host';
import { DeviceTrust } from '../devices/trust';
import { LanConfig } from './config';
import {
  MAX_PAIR_BODY_BYTES,
  PAIR_PATH,
  type PairReply,
  PairReplyJson,
  PairRequestJson,
} from './pairing-wire';

/** The header carrying the connecting Device's id. The bearer token goes in `Authorization`. */
export const DEVICE_HEADER = 'x-spence-device';

/** The header carrying the protocol version a Device speaks, both ways: a mismatch is refused with 426. */
export const PROTOCOL_HEADER = 'x-spence-protocol';

/** The largest frame a Remote device may send; bigger frames close its connection. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Every handler the LAN server dispatches to: the allow-listed groups only. */
export type RemoteHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof RemoteRpcs>>;

const refuse = (socket: Duplex, status: string, headers: ReadonlyArray<string> = []): void => {
  const lines = [`HTTP/1.1 ${status}`, ...headers, 'Connection: close', 'Content-Length: 0'];
  socket.end(`${lines.join('\r\n')}\r\n\r\n`);
};

const bearerOf = (request: IncomingMessage): string | undefined => {
  const header = request.headers.authorization;
  return header?.startsWith('Bearer ') === true ? header.slice('Bearer '.length) : undefined;
};

const listenOn = (server: Server, host: string | undefined, port: number) =>
  Effect.callback<number, 'InUse' | 'Failed'>((resume) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      resume(Effect.fail(error.code === 'EADDRINUSE' ? 'InUse' : 'Failed'));
    };
    const onListening = (): void => {
      server.off('error', onError);
      const address = server.address();
      resume(Effect.succeed(typeof address === 'object' && address !== null ? address.port : port));
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

/** Binds the first free port of the configured range. */
const bind = Effect.fnUntraced(function* (server: Server) {
  const { host, port, portAttempts } = yield* LanConfig;
  const candidates = port === 0 ? [0] : Array.from({ length: portAttempts }, (_, i) => port + i);
  for (const candidate of candidates) {
    const bound = yield* Effect.result(listenOn(server, host, candidate));
    if (bound._tag === 'Success') return bound.success;
    if (bound.failure === 'Failed') break;
  }
  return yield* new DevicesError({
    reason: 'ListenFailed',
    detail: `No free port from ${port}.`,
  });
});

const reply = (response: ServerResponse, status: number, body: PairReply): void => {
  const payload = Schema.encodeSync(PairReplyJson)(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
};

const statusOf = (body: PairReply): number => {
  switch (body._tag) {
    case 'Paired':
      return 200;
    case 'Refused':
      return 403;
    case 'VersionMismatch':
      return 426;
  }
};

/** Reads a request body up to `MAX_PAIR_BODY_BYTES`; `undefined` when it is bigger (the request is cut off). */
const readBody = (request: IncomingMessage) =>
  Effect.callback<string | undefined>((resume) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PAIR_BODY_BYTES) {
        request.removeAllListeners('data');
        request.destroy();
        resume(Effect.succeed(undefined));
      } else chunks.push(chunk);
    });
    request.once('end', () => resume(Effect.succeed(Buffer.concat(chunks).toString('utf8'))));
    request.once('error', () => resume(Effect.succeed(undefined)));
  });

/**
 * Opens the Device's `wss://` listener for the life of the current scope and serves `RemoteRpcs` on it with the
 * handlers already in context, so the LAN shares the very handler instances the local MessagePort server uses.
 * At the WebSocket upgrade, once per connection, the protocol version is checked (426 with ours on a mismatch), then
 * the credentials (401 when they match no Paired device), before any RPC frame is read. The only other thing served
 * is the pairing ceremony (`POST /pair`), the one unauthenticated surface. Unpairing a Device closes its
 * connections; closing the scope closes every connection.
 */
export const serveRemote = Effect.fnUntraced(function* (certificate: DeviceCertificate) {
  const trust = yield* DeviceTrust;
  const pairing = yield* PairingHost;
  const { protocolVersion } = yield* LanConfig;
  const runFork = yield* FiberSet.makeRuntime<never, unknown, never>();
  const accepted = yield* Queue.unbounded<WebSocket>();
  /** Live connections by the Paired device they were authorized as. */
  const byDevice = new Map<string, Set<WebSocket>>();

  const server = createServer({
    cert: certificate.certificate,
    key: certificate.privateKey,
    minVersion: 'TLSv1.3',
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST' || request.url !== PAIR_PATH) {
      response.writeHead(404).end();
      return;
    }
    runFork(
      Effect.gen(function* () {
        const body = yield* readBody(request);
        const decoded =
          body === undefined ? undefined : Schema.decodeUnknownExit(PairRequestJson)(body);
        if (decoded === undefined || decoded._tag === 'Failure') {
          response.writeHead(400).end();
          return;
        }
        const answer = yield* pairing.accept(decoded.value, request.socket.remoteAddress);
        reply(response, statusOf(answer), answer);
      }),
    );
  });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (request.headers[PROTOCOL_HEADER] !== String(protocolVersion)) {
      refuse(socket, '426 Upgrade Required', [`${PROTOCOL_HEADER}: ${protocolVersion}`]);
      return;
    }
    const deviceId = request.headers[DEVICE_HEADER];
    const token = bearerOf(request);
    if (typeof deviceId !== 'string' || token === undefined) {
      refuse(socket, '401 Unauthorized');
      return;
    }
    runFork(
      trust.authorize({ deviceId, token }).pipe(
        Effect.map((paired) => {
          if (Option.isNone(paired)) {
            refuse(socket, '401 Unauthorized');
            return;
          }
          sockets.handleUpgrade(request, socket, head, (ws) => {
            const live = byDevice.get(paired.value) ?? new Set<WebSocket>();
            byDevice.set(paired.value, live);
            live.add(ws);
            ws.once('close', () => live.delete(ws));
            Queue.offerUnsafe(accepted, ws);
          });
        }),
      ),
    );
  });

  // An unpaired (or re-paired) Device keeps no connection made with its old credentials.
  yield* trust.revocations.pipe(
    Stream.runForEach((deviceId) =>
      Effect.sync(() => {
        for (const ws of byDevice.get(deviceId) ?? []) ws.terminate();
        byDevice.delete(deviceId);
      }),
    ),
    Effect.forkScoped,
  );

  const port = yield* bind(server);
  yield* Effect.addFinalizer(() =>
    Effect.callback<void>((resume) => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      server.closeAllConnections();
      server.close(() => resume(Effect.void));
    }),
  );

  const socketServer: SocketServer.SocketServer['Service'] = {
    address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Unspecified, port),
    run: (handler) =>
      Effect.gen(function* () {
        const connections = yield* FiberSet.make();
        yield* Stream.fromQueue(accepted).pipe(
          Stream.runForEach((ws) =>
            FiberSet.run(
              connections,
              Socket.fromWebSocket(Effect.succeed(ws)).pipe(
                Effect.flatMap(handler),
                Effect.ignoreCause,
                Effect.ensuring(Effect.sync(() => ws.terminate())),
              ),
            ),
          ),
        );
        return yield* Effect.never;
      }).pipe(Effect.scoped),
  };

  const protocol = yield* RpcServer.makeProtocolSocketServer.pipe(
    Effect.provideService(SocketServer.SocketServer, socketServer),
    Effect.provide(layerPortSerialization),
  );
  yield* RpcServer.make(RemoteRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, protocol),
    Effect.forkScoped,
  );
  return { port };
});

/** Builds the listener in its own scope, for callers that open and close it on demand. */
export const openListener = Effect.fnUntraced(function* (certificate: DeviceCertificate) {
  const scope = yield* Scope.make();
  const opened = yield* serveRemote(certificate).pipe(
    Scope.provide(scope),
    Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
  );
  return { port: opened.port, close: Scope.close(scope, Exit.void) };
});
