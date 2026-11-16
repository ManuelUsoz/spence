import { MessageChannel } from 'node:worker_threads';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { RpcClient, RpcServer } from 'effect/rpc';
import { ComparisonId } from '../../src/shared/history/comparison';
import { HistoryRpcs, ObservationId } from '../../src/shared/history/history.rpc';
import { layerClientProtocol } from '../../src/shared/rpc/message-port-protocol';
import { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { WorktreeId } from '../../src/shared/worktrees/worktrees.rpc';
import { HistoryStore } from '../history/history-store';
import { StoreError } from '../store/store';
import { layerHistoryHandlersWithStore } from './history';
import { clientPort, serverPort } from './ipc-fakes';
import { layerIpcServer, RpcPortHandoff } from './ipc-server';

const sessionId = SessionId.make('session');
const worktreeId = WorktreeId.make('worktree');
const records = [
  {
    id: ComparisonId.make('one'),
    sessionId,
    worktreeId,
    recordedAt: 1,
    before: { status: 'Complete' as const, observationId: ObservationId.make('obs') },
    after: { status: 'Incomplete' as const, detail: 'timed out' },
  },
  {
    id: ComparisonId.make('two'),
    sessionId,
    worktreeId,
    recordedAt: 2,
    before: { status: 'Missing' as const, detail: 'absent' },
    after: { status: 'Complete' as const, observationId: ObservationId.make('obs2') },
  },
];

describe('History.list over MessagePort', () => {
  it.live('round-trips endpoints and store errors', () =>
    Effect.gen(function* () {
      const store = Layer.succeed(
        HistoryStore,
        HistoryStore.of({
          publish: () => Effect.void,
          list: (session) =>
            session === sessionId
              ? Effect.succeed(records)
              : Effect.fail(new StoreError({ reason: 'Invalid', detail: 'bad store' })),
        }),
      );
      const context = yield* Layer.build(
        RpcServer.layer(HistoryRpcs).pipe(
          Layer.provideMerge(layerIpcServer),
          Layer.provide(layerHistoryHandlersWithStore.pipe(Layer.provide(store))),
        ),
      );
      const { port1, port2 } = new MessageChannel();
      Context.get(context, RpcPortHandoff).bind(serverPort(port1));
      const protocol = yield* Layer.build(layerClientProtocol(clientPort(port2)));
      const client = yield* RpcClient.make(HistoryRpcs).pipe(Effect.provideContext(protocol));
      expect(yield* client['History.list']({ sessionId, worktreeId })).toEqual(records);
      const error = yield* client['History.list']({
        sessionId: SessionId.make('error'),
        worktreeId,
      }).pipe(Effect.flip);
      expect(error._tag).toBe('HistoryError');
      if (error._tag !== 'HistoryError') {
        return yield* Effect.die(error);
      }
      expect(error.reason).toBe('StoreError');
      expect(error.detail).toBe('bad store');
    }).pipe(Effect.scoped),
  );
});
