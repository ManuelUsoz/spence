import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import {
  makeDelegationServer,
  toolError,
  type DelegationTools,
  type ToolOutcome,
} from './delegation-server';

type Registered = {
  readonly server: {
    readonly url: string;
    readonly headers: ReadonlyArray<{ name: string; value: string }>;
  };
};

const call = (registered: Registered, name: string, args: Record<string, unknown>) =>
  Effect.promise(async () => {
    const response = await fetch(registered.server.url, {
      method: 'POST',
      headers: Object.fromEntries(registered.server.headers.map((h) => [h.name, h.value])),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    return { status: response.status, body: await response.json() };
  });

const toolsOf = (delegate: DelegationTools['delegate']): DelegationTools => ({
  delegate,
  listSessions: () => Promise.resolve({ text: '{}' }),
  sendMessage: () => Promise.resolve({ text: '{}' }),
});

describe('delegation server retry keys', () => {
  it.live('a retry after the registration was reissued does not run the work again', () =>
    Effect.gen(function* () {
      const server = yield* makeDelegationServer;
      let runs = 0;
      const tools = toolsOf(() => {
        runs += 1;
        return Promise.resolve({ text: 'result' });
      });
      const first = server.register(tools, () => 'session-1:context-1');
      const a = yield* call(first, 'delegate', { task: 't', requestId: 'k' });
      first.revoke();
      const second = server.register(tools, () => 'session-1:context-1');
      const b = yield* call(second, 'delegate', { task: 't', requestId: 'k' });
      expect(runs).toBe(1);
      expect(b.body).toEqual(a.body);
    }).pipe(Effect.scoped),
  );

  it.live('the same key in another scope is separate work', () =>
    Effect.gen(function* () {
      const server = yield* makeDelegationServer;
      let runs = 0;
      const tools = toolsOf(() => {
        runs += 1;
        return Promise.resolve({ text: 'result' });
      });
      const one = server.register(tools, () => 'session-1:context-1');
      const two = server.register(tools, () => 'session-1:context-2');
      yield* call(one, 'delegate', { task: 't', requestId: 'k' });
      yield* call(two, 'delegate', { task: 't', requestId: 'k' });
      expect(runs).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live('a failed or rejected call is not remembered: the retry runs again', () =>
    Effect.gen(function* () {
      const server = yield* makeDelegationServer;
      const outcomes: Array<() => Promise<ToolOutcome>> = [
        () => Promise.resolve(toolError('WorkerFailed', 'boom')),
        () => Promise.reject(new Error('defect')),
        () => Promise.resolve({ text: 'finally' }),
      ];
      let runs = 0;
      const registered = server.register(
        toolsOf(() => outcomes[runs++]?.() ?? Promise.resolve({ text: 'extra' })),
        () => 'session-1:context-1',
      );
      const args = { task: 't', requestId: 'k' };
      const failed = yield* call(registered, 'delegate', args);
      expect(failed.body.result.isError).toBe(true);
      const rejected = yield* call(registered, 'delegate', args);
      expect(rejected.status).not.toBe(200);
      const ok = yield* call(registered, 'delegate', args);
      expect(ok.body.result.content[0].text).toBe('finally');
      expect(runs).toBe(3);
    }).pipe(Effect.scoped),
  );

  it.live('a defect answers with the structured error shape', () =>
    Effect.gen(function* () {
      const server = yield* makeDelegationServer;
      const registered = server.register(
        toolsOf(() => Promise.reject(new Error('defect'))),
        () => 'scope',
      );
      const response = yield* call(registered, 'delegate', { task: 't' });
      expect(response.body.error.reason).toBe('Internal');
      expect(typeof response.body.error.detail).toBe('string');
    }).pipe(Effect.scoped),
  );
});
