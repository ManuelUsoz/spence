import { agent, type SessionNotification } from '@agentclientprotocol/sdk/unstable';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Queue } from 'effect';
import { makeClientDispatcher } from './acpClientDispatcher';
import { AcpSessionId } from './acpSession';

const said = (sessionId: AcpSessionId, text: string): SessionNotification => ({
  sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});

const x = AcpSessionId.make('x');
const y = AcpSessionId.make('y');

/** Our dispatcher with an in-process Agent on the other end; `notify` sends `session/update` from the Agent. */
const connected = Effect.gen(function* () {
  const dispatcher = yield* makeClientDispatcher();
  const connection = yield* Effect.acquireRelease(
    Effect.sync(() => agent({ name: 'test-agent' }).connect(dispatcher.app)),
    (open) => Effect.sync(() => open.close()),
  );
  const notify = (update: SessionNotification) =>
    Effect.promise(() => connection.client.notify('session/update', update));
  /** Every notification sent before this one has been routed once `y` received it. */
  const settle = Effect.gen(function* () {
    const queue = yield* dispatcher.attach(y);
    yield* notify(said(y, 'sync'));
    yield* Queue.take(queue);
    yield* dispatcher.detach(y);
  });
  return { dispatcher, notify, settle };
});

describe('ClientDispatcher', () => {
  it.live('delivers structured Worker announcements and the child stream', () =>
    Effect.gen(function* () {
      const { dispatcher, notify } = yield* connected;
      const parent = yield* dispatcher.attach(x);
      yield* notify({
        sessionId: x,
        update: {
          sessionUpdate: 'subagent_update',
          sessionId: y,
          title: 'Research',
          state: { state: 'running' },
        },
      });
      expect(yield* Queue.take(parent)).toEqual({
        _tag: 'Update',
        update: {
          sessionUpdate: 'subagent_update',
          sessionId: y,
          title: 'Research',
          state: { state: 'running' },
        },
      });
      yield* notify(said(y, 'child output'));
      const child = yield* dispatcher.attach(y);
      expect(yield* Queue.take(child)).toEqual({
        _tag: 'Update',
        update: said(y, 'child output').update,
      });
    }).pipe(Effect.scoped),
  );
  it.live('delivers updates that arrived before attach first', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* notify(said(x, 'early'));
      yield* settle;
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live('drops the updates buffered for a session that is detached before it is attached', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* notify(said(x, 'early'));
      yield* settle;
      yield* dispatcher.detach(x);
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live('ignores updates for a session after it was detached', () =>
    Effect.gen(function* () {
      const { dispatcher, notify, settle } = yield* connected;
      yield* dispatcher.attach(x);
      yield* dispatcher.detach(x);
      yield* notify(said(x, 'late'));
      yield* settle;
      const queue = yield* dispatcher.attach(x);
      expect(yield* Queue.size(queue)).toBe(0);
    }).pipe(Effect.scoped),
  );
});
