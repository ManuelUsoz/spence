import { Context, Effect, Exit, FiberSet, Layer, Option, Queue, Scope, Stream } from 'effect';
import { type Rpc, type RpcGroup, RpcServer } from 'effect/rpc';
import { NetAddress } from 'effect/net';
import { Socket, SocketServer } from 'effect/socket';
import type { IncomingMessage } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { Duplex } from 'node:stream';
import { type WebSocket, WebSocketServer } from 'ws';
import { DevicesError } from '../../src/shared/devices/devices.rpc';
import { layerPortSerialization } from '../../src/shared/rpc/message-port-protocol';
import { RemoteRpcs } from '../../src/shared/rpc/remote-rpcs';
import type { DeviceCertificate } from '../devices/certificate';
import { DeviceTrust } from '../devices/trust';

/** The header carrying the connecting Device's id. The bearer token goes in `Authorization`. */
export const DEVICE_HEADER = 'x-spence-device';

/** The largest frame a Remote device may send; bigger frames close its connection. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Where the listener binds. Production listens on every interface at a fixed port, or the next free one. */
export class LanConfig extends Context.Service<
  LanConfig,
  {
    /** `undefined` binds every interface. */
    readonly host: string | undefined;
    /** The first port tried; `0` lets the OS pick. */
    readonly port: number;
    /** How many consecutive ports are tried before hosting gives up. */
    readonly portAttempts: number;
  }
>()('lan/LanConfig') {}

/** The default port is fixed so a typed `host:port` keeps working; the next free one is used if it is taken. */
export const DEFAULT_PORT = 47_120;

/** Every interface in use; loopback only under e2e, so a test run never opens a port to the network. */
export const layerLanConfigLive = Layer.sync(LanConfig, () => ({
  host: process.env['SPENCE_E2E'] === '1' ? '127.0.0.1' : undefined,
  port: DEFAULT_PORT,
  portAttempts: 20,
}));

/** Every handler the LAN server dispatches to: the allow-listed groups only. */
export type RemoteHandlers = Rpc.ToHandler<RpcGroup.Rpcs<typeof RemoteRpcs>>;

const refuse = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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

/**
 * Opens the Device's `wss://` listener for the life of the current scope and serves `RemoteRpcs` on it with the
 * handlers already in context, so the LAN shares the very handler instances the local MessagePort server uses.
 * Credentials are checked once, at the WebSocket upgrade; a connection with none, or with credentials matching no
 * Paired device, is refused with 401 before any RPC frame is read. Closing the scope closes every connection.
 */
export const serveRemote = Effect.fnUntraced(function* (certificate: DeviceCertificate) {
  const trust = yield* DeviceTrust;
  const runFork = yield* FiberSet.makeRuntime<never, unknown, never>();
  const accepted = yield* Queue.unbounded<WebSocket>();

  const server = createServer({
    cert: certificate.certificate,
    key: certificate.privateKey,
    minVersion: 'TLSv1.3',
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  // Only WebSocket upgrades are served; plain HTTPS requests get nothing.
  server.on('request', (_request, response) => response.writeHead(404).end());
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
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
          sockets.handleUpgrade(request, socket, head, (ws) => Queue.offerUnsafe(accepted, ws));
        }),
      ),
    );
  });

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
