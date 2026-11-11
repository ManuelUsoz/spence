/**
 * The renderer's client protocol (`makeClientProtocol`) and main's server protocol
 * (`layerIpcServer`) joined over a real port pair, with the production serialization.
 * A Node `MessageChannel` stands in for Electron's `MessageChannelMain`.
 */
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Rpc, RpcClient, RpcGroup, RpcServer } from 'effect/rpc';
import {
  layerClientProtocol,
  type MessagePortAdapter,
} from '../../src/shared/rpc/message-port-protocol';
import { type IpcServerPort, layerIpcServer, RpcPortHandoff } from './ipc-server';

const EchoRpcs = RpcGroup.make(
  Rpc.make('Echo.say', { payload: { text: Schema.String }, success: Schema.String }),
);

const layerEchoHandlers = EchoRpcs.toLayer({
  'Echo.say': ({ text }) => Effect.succeed(text),
});

const serverPort = (port: MessagePort): IpcServerPort => {
  const wrapped = new Map<unknown, (data: Uint8Array | string) => void>();
  return {
    on: ((event: 'message' | 'close', listener: (e?: { data: Uint8Array | string }) => void) => {
      if (event === 'close') return void port.on('close', () => listener());
      const onData = (data: Uint8Array | string) => listener({ data });
      wrapped.set(listener, onData);
      port.on('message', onData);
    }) as IpcServerPort['on'],
    off: (_event, listener) => {
      const onData = wrapped.get(listener);
      if (onData) port.off('message', onData);
    },
    postMessage: (message) => port.postMessage(message),
    start: () => port.start(),
    close: () => port.close(),
  };
};

const clientPort = (port: MessagePort): MessagePortAdapter => ({
  postMessage: (data) => port.postMessage(data),
  onMessage: (callback) => void port.on('message', callback),
  close: () => port.close(),
});

/** Starts the server and returns `connect`, which does what a page load does: a fresh port and a new client. */
const startServer = Effect.fnUntraced(function* () {
  const context = yield* Layer.build(
    RpcServer.layer(EchoRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(layerEchoHandlers),
    ),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  return Effect.fnUntraced(function* () {
    const { port1, port2 } = new MessageChannel();
    handoff.bind(serverPort(port1));
    // Built into the test scope: providing the layer directly would close the port once the client is made.
    const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
    return yield* RpcClient.make(EchoRpcs).pipe(Effect.provideContext(protocol));
  });
});

describe('RPC over the MessagePort transport', () => {
  it.live('answers the first client of a page', () =>
    Effect.gen(function* () {
      const connect = yield* startServer();
      const client = yield* connect();
      expect(yield* client['Echo.say']({ text: 'hello' }).pipe(Effect.timeout('2 seconds'))).toBe(
        'hello',
      );
    }).pipe(Effect.scoped),
  );

  it.live('answers every later client in the same page, not only the first', () =>
    Effect.gen(function* () {
      const connect = yield* startServer();
      const first = yield* connect();
      expect(yield* first['Echo.say']({ text: 'one' }).pipe(Effect.timeout('2 seconds'))).toBe(
        'one',
      );
      const second = yield* connect();
      expect(yield* second['Echo.say']({ text: 'two' }).pipe(Effect.timeout('2 seconds'))).toBe(
        'two',
      );
    }).pipe(Effect.scoped),
  );
});
