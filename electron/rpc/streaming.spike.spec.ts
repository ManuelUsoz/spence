/**
 * SPIKE (research #4, branch research/rpc-streaming only; not for main).
 *
 * Proves that `stream: true` RPCs work over Spence's real transport pieces:
 * `layerIpcServer` (main) + `makeClientProtocol` (renderer) + `layerSchemaBinary`,
 * joined by a Node `MessageChannel` standing in for Electron's MessageChannelMain.
 */
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { DateTime, Deferred, Effect, Fiber, Layer, Queue, Schema, Stream } from 'effect';
import { Rpc, RpcClient, RpcGroup, RpcServer, RpcTest } from 'effect/rpc';
import {
  layerClientProtocol,
  type MessagePortAdapter,
} from '../../src/shared/rpc/message-port-protocol';
import { type IpcServerPort, layerIpcServer, RpcPortHandoff } from './ipc-server';

class SessionEvent extends Schema.Class<SessionEvent>('SessionEvent')({
  seq: Schema.Number,
  kind: Schema.Literals(['text', 'tool']),
  at: Schema.DateTimeUtc,
}) {}

class SpikeError extends Schema.TaggedError<SpikeError>()('SpikeError', {
  reason: Schema.Literals(['Boom']),
  detail: Schema.String,
}) {}

const SpikeRpcs = RpcGroup.make(
  Rpc.make('Spike.events', {
    payload: { count: Schema.Number, failAfter: Schema.optional(Schema.Number) },
    success: SessionEvent,
    error: SpikeError,
    stream: true,
  }),
  Rpc.make('Spike.ticks', { success: Schema.Number, stream: true }),
);

const ev = (seq: number) =>
  new SessionEvent({
    seq,
    kind: seq % 2 ? 'tool' : 'text',
    at: DateTime.makeUnsafe(1_700_000_000_000 + seq),
  });

// Node MessagePort -> the two adapters Spence already defines.
const serverPort = (port: MessagePort): IpcServerPort => {
  const wrapped = new Map<unknown, (value: never) => void>();
  return {
    on: ((event: 'message' | 'close', listener: (e?: { data: Uint8Array | string }) => void) => {
      if (event === 'close') return void port.on('close', () => listener());
      const w = (data: Uint8Array | string) => listener({ data });
      wrapped.set(listener, w);
      port.on('message', w);
    }) as IpcServerPort['on'],
    off: (_event, listener) => {
      const w = wrapped.get(listener);
      if (w) port.off('message', w);
    },
    postMessage: (m) => port.postMessage(m),
    start: () => port.start(),
    close: () => port.close(),
  };
};
const clientPort = (port: MessagePort): MessagePortAdapter => ({
  postMessage: (d) => port.postMessage(d),
  onMessage: (cb) => void port.on('message', cb),
  close: () => port.close(),
});

interface Probe {
  produced: number;
  tickStopped: Deferred.Deferred<string>;
}

const makeHandlers = (probe: Probe) =>
  SpikeRpcs.toLayer({
    'Spike.events': ({ count, failAfter }) =>
      Stream.range(1, count).pipe(
        Stream.mapEffect((n) =>
          failAfter !== undefined && n > failAfter
            ? Effect.fail(new SpikeError({ reason: 'Boom', detail: `after ${failAfter}` }))
            : Effect.succeed(ev(n)),
        ),
      ),
    'Spike.ticks': () =>
      Stream.fromEffectRepeat(Effect.sync(() => ++probe.produced)).pipe(
        Stream.onExit((exit) =>
          Deferred.succeed(probe.tickStopped, exit._tag === 'Failure' ? 'interrupted' : 'done'),
        ),
      ),
  });

/** Server on the real IPC protocol + a connector that yields a client per (re)connect. */
const setup = Effect.fnUntraced(function* (probe: Probe) {
  const ctx = yield* Layer.build(
    RpcServer.layer(SpikeRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(makeHandlers(probe)),
    ),
  );
  const handoff = ctx.mapUnsafe.get(RpcPortHandoff.key) as RpcPortHandoff['Service'];
  const connect = Effect.fnUntraced(function* () {
    const { port1, port2 } = new MessageChannel();
    handoff.bind(serverPort(port1));
    // Effect.provide(layer) would close the protocol (and the port) as soon as make returns.
    const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
    return yield* RpcClient.make(SpikeRpcs).pipe(Effect.provideContext(protocol));
  });
  return connect;
});

const newProbe = Effect.map(Deferred.make<string>(), (tickStopped) => ({
  produced: 0,
  tickStopped,
}));

describe('spike: streaming over the MessagePort protocol', () => {
  it.live('round-trips a stream with Schema.Class + DateTimeUtc through layerSchemaBinary', () =>
    Effect.gen(function* () {
      const connect = yield* setup(yield* newProbe);
      const client = yield* connect();
      const out = yield* Stream.runCollect(client['Spike.events']({ count: 50 }));
      expect(out).toHaveLength(50);
      expect(out[0]).toBeInstanceOf(SessionEvent);
      expect(out[49]!.seq).toBe(50);
    }).pipe(Effect.scoped),
  );

  it.live('delivers elements before a typed stream error, then fails with it', () =>
    Effect.gen(function* () {
      const connect = yield* setup(yield* newProbe);
      const client = yield* connect();
      const seen: number[] = [];
      const err = yield* client['Spike.events']({ count: 10, failAfter: 3 }).pipe(
        Stream.runForEach((e) => Effect.sync(() => seen.push(e.seq))),
        Effect.flip,
      );
      expect(seen).toEqual([1, 2, 3]);
      expect(err._tag).toBe('SpikeError');
    }).pipe(Effect.scoped),
  );

  it.live('backpressure: an unread stream stalls the producer in main', () =>
    Effect.gen(function* () {
      const probe = yield* newProbe;
      const connect = yield* setup(probe);
      const client = yield* connect();
      const queue = yield* client['Spike.ticks'](undefined, { asQueue: true, streamBufferSize: 4 });
      yield* Effect.sleep('300 millis');
      const stalledAt = probe.produced;
      yield* Effect.sleep('300 millis');
      expect(probe.produced).toBe(stalledAt); // producer is parked on the ack latch
      expect(stalledAt).toBeLessThan(20);
      expect(stalledAt).toBe(5); // 4 in the client buffer + 1 chunk parked waiting for its ack
      yield* Queue.take(queue);
      yield* Effect.sleep('100 millis');
      expect(probe.produced).toBeGreaterThan(stalledAt); // reading resumes it
    }).pipe(Effect.scoped),
  );

  it.live('interrupting the consumer interrupts the handler in main (ClientAbort)', () =>
    Effect.gen(function* () {
      const probe = yield* newProbe;
      const connect = yield* setup(probe);
      const client = yield* connect();
      const fiber = yield* client['Spike.ticks']().pipe(Stream.runDrain, Effect.forkChild);
      yield* Effect.sleep('100 millis');
      yield* Fiber.interrupt(fiber);
      expect(yield* Deferred.await(probe.tickStopped).pipe(Effect.timeout('1 second'))).toBe(
        'interrupted',
      );
      // take(n) ends the stream early too
      const probe2 = yield* newProbe;
      const client2 = yield* (yield* setup(probe2))();
      expect(yield* Stream.runCollect(client2['Spike.ticks']().pipe(Stream.take(3)))).toHaveLength(
        3,
      );
      expect(yield* Deferred.await(probe2.tickStopped).pipe(Effect.timeout('1 second'))).toBe(
        'interrupted',
      );
    }).pipe(Effect.scoped),
  );

  it.live(
    'a renderer reload (new port bound) interrupts the old stream; the new client resubscribes',
    () =>
      Effect.gen(function* () {
        const probe = yield* newProbe;
        const connect = yield* setup(probe);
        const before = yield* connect();
        const orphan = yield* before['Spike.ticks']().pipe(Stream.runDrain, Effect.forkChild);
        yield* Effect.sleep('100 millis');
        const after = yield* connect(); // what a reload does: bind a fresh port
        expect(yield* Deferred.await(probe.tickStopped).pipe(Effect.timeout('1 second'))).toBe(
          'interrupted',
        );
        const out = yield* Stream.runCollect(after['Spike.events']({ count: 5 }));
        expect(out.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
        // the old client never learns its port is gone: its stream just hangs
        const orphanDone = yield* Fiber.join(orphan).pipe(Effect.timeoutOption('300 millis'));
        expect(orphanDone._tag).toBe('None');
      }).pipe(Effect.scoped),
  );

  it.live('RpcTest (what makeDesktopTestLayer uses) serves streams in memory', () =>
    Effect.gen(function* () {
      const probe = yield* newProbe;
      const client = yield* RpcTest.makeClient(SpikeRpcs).pipe(Effect.provide(makeHandlers(probe)));
      const out = yield* Stream.runCollect(client['Spike.events']({ count: 3 }));
      expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(yield* Stream.runCollect(client['Spike.ticks']().pipe(Stream.take(2)))).toEqual([
        1, 2,
      ]);
    }).pipe(Effect.scoped),
  );
});
