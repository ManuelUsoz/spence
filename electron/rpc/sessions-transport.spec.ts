/**
 * `Session.events` over the real MessagePort transport with the production serialization: the stream's items survive
 * `layerSchemaBinary`, which `makeDesktopTestLayer` does not exercise.
 */
import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Stream } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import {
  MessageId,
  SessionId,
  SessionsRpcs,
  TurnId,
  type SessionStreamItem,
} from '../../src/shared/sessions/sessions.rpc';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

const sessionId = SessionId.make('session-1');
const turnId = TurnId.make('turn-1');
const messageId = MessageId.make('message-1');

const served: ReadonlyArray<SessionStreamItem> = [
  {
    _tag: 'Live',
    state: {
      agentStatus: 'ready',
      title: { autoIsPlaceholder: false },
      options: { permissionMode: 'auto' },
      commands: [],
      canAttachImages: true,
      supportsCompaction: true,
      imageLimits: { maxBase64Bytes: 1024, maxDimensionPx: 100, maxPerMessage: 1 },
      contextUsage: { _tag: 'reported', used: 24_000, capacity: 200_000 },
    },
  },
  {
    _tag: 'Transcript',
    event: { seq: 3, at: 1, item: { _tag: 'TurnStarted', turnId, permissionMode: 'auto' } },
  },
  {
    _tag: 'Transcript',
    event: {
      seq: 4,
      at: 2,
      item: {
        _tag: 'Message',
        id: messageId,
        turnId,
        role: 'agent',
        parts: [{ _tag: 'text', text: 'Hel' }],
      },
    },
  },
  {
    _tag: 'Transcript',
    event: { seq: 5, at: 3, item: { _tag: 'MessageDelta', id: messageId, text: 'lo' } },
  },
  {
    _tag: 'Transcript',
    event: { seq: 6, at: 4, item: { _tag: 'TurnEnded', turnId, outcome: { _tag: 'done' } } },
  },
];

const die = () => Effect.die('not served in this spec');

/** Serves `served` for any Session after the asked `afterSeq`, remembering what was asked. */
const asked: Array<number | undefined> = [];
const layerHandlers = SessionsRpcs.toLayer({
  'Session.changes': () => Stream.empty,
  'Session.list': die,
  'Session.create': die,
  'Session.prompt': die,
  'Session.rename': () => Effect.void,
  'Session.openAgentLog': () => Effect.void,
  'Session.retryAgent': () => Effect.void,
  'Session.loginAgent': () => Effect.void,
  'Session.cancel': die,
  'Session.answerPermission': die,
  'Session.setOption': die,
  'Session.clearContext': die,
  'Session.compact': die,
  'Session.archive': die,
  'Session.unarchive': die,
  'Session.delete': die,
  'Session.events': ({ afterSeq }) => {
    asked.push(afterSeq);
    return Stream.fromIterable(
      served.filter((item) => item._tag === 'Live' || item.event.seq > (afterSeq ?? 0)),
    );
  },
  'Session.getComposer': die,
  'Session.setComposer': die,
});

/** A page load: a fresh port pair and a new client against the running server. */
const startServer = Effect.fnUntraced(function* () {
  const context = yield* Layer.build(
    RpcServer.layer(SessionsRpcs).pipe(
      Layer.provideMerge(layerIpcServer),
      Layer.provide(layerHandlers),
    ),
  );
  const handoff = Context.get(context, RpcPortHandoff);
  return Effect.fnUntraced(function* () {
    const { port1, port2 } = new MessageChannel();
    handoff.bind(serverPort(port1));
    const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
    return yield* RpcClient.make(SessionsRpcs).pipe(Effect.provideContext(protocol));
  });
});

describe('Session.events over the MessagePort transport', () => {
  it.live('streams the live state and Transcript events intact, and again after a reload', () =>
    Effect.gen(function* () {
      const connect = yield* startServer();
      const first = yield* connect();
      const all = yield* first['Session.events']({ sessionId }).pipe(
        Stream.runCollect,
        Effect.timeout('5 seconds'),
      );
      expect([...all]).toEqual(served);

      // A reload: a new port and client, resubscribing after what the last one saw.
      const second = yield* connect();
      const rest = yield* second['Session.events']({ sessionId, afterSeq: 4 }).pipe(
        Stream.runCollect,
        Effect.timeout('5 seconds'),
      );
      expect([...rest]).toEqual([served[0], served[3], served[4]]);
      expect(asked).toEqual([undefined, 4]);
    }).pipe(Effect.scoped),
  );
});
