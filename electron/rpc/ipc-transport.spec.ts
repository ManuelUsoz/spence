/**
 * The renderer's client protocol (`makeClientProtocol`) and main's server protocol
 * (`layerIpcServer`) joined over a real port pair, with the production serialization.
 * A Node `MessageChannel` stands in for Electron's `MessageChannelMain`.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Schema } from 'effect';
import { Rpc, RpcClient, RpcGroup, RpcServer } from 'effect/rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';
import { clientPort, serverPort } from './ipc-fakes';

const EchoRpcs = RpcGroup.make(
  Rpc.make('Echo.say', { payload: { text: Schema.String }, success: Schema.String }),
);

const layerEchoHandlers = EchoRpcs.toLayer({
  'Echo.say': ({ text }) => Effect.succeed(text),
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
