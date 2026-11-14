import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Layer, Logger, PubSub, Stream } from 'effect';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import { AcpError } from '../acp/acpErrors';
import { AcpSessionId } from '../acp/acpSession';
import { AcpClient, type AcpSessionManager } from '../acp/acpSessionManager';
import { layerStore, Store } from '../store/store';
import { AGENT_DELETES_FILE, DeleteQueue, layerDeleteQueue } from './delete-queue';

const agentA = AgentId.make('agent-a');
const agentB = AgentId.make('agent-b');

const withTempRoot = <A, E, R>(fn: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-delq-'))),
    fn,
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

const fakeManager = (options: {
  readonly agentId: AgentId;
  readonly supportsDelete?: boolean;
  readonly onDelete: (id: AcpSessionId) => Effect.Effect<void, AcpError>;
}): AcpSessionManager => ({
  agentId: options.agentId,
  pid: undefined,
  agentCapabilities: options.supportsDelete ? { sessionCapabilities: { delete: {} } } : {},
  authMethods: [],
  agentInfo: null,
  newSession: () => Effect.die('unused'),
  loadSession: () => Effect.die('unused'),
  resumeSession: () => Effect.die('unused'),
  deleteSession: options.onDelete,
  authenticate: () => Effect.die('unused'),
  exited: Effect.never,
  processExited: Effect.never,
});

const readDeletesFile = (root: string) =>
  Effect.tryPromise(() => readFile(path.join(root, AGENT_DELETES_FILE), 'utf8')).pipe(
    Effect.map(
      (text) => JSON.parse(text) as { version: number; items: Array<Record<string, unknown>> },
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  );

const runWithClient = <A, E, R>(
  root: string,
  program: (controls: {
    readonly setConnected: (id: AgentId, manager: AcpSessionManager | undefined) => void;
    readonly emitAndWaitWrite: (manager: AcpSessionManager) => Effect.Effect<void>;
    readonly connectCalls: () => number;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const connected = new Map<AgentId, AcpSessionManager>();
    let connects = 0;
    let writeCount = 0;
    const waiters = new Set<{ readonly target: number; readonly done: () => void }>();
    const hub = yield* PubSub.unbounded<AcpSessionManager>();
    const clientLayer = Layer.succeed(AcpClient, {
      connect: () => {
        connects += 1;
        return Effect.die('DeleteQueue must never start an Agent');
      },
      disconnect: () => Effect.void,
      kill: () => Effect.succeed({ pid: undefined, exitConfirmed: true }),
      unconfirmedExit: () => Effect.succeed(undefined),
      subscribeExitConfirmed: Effect.succeed(Stream.empty),
      login: () => Effect.die('unused'),
      connected: (id) => Effect.sync(() => connected.get(id)),
      subscribeInitialized: Effect.map(PubSub.subscribe(hub), Stream.fromSubscription),
    });
    const observedStore = Layer.effect(
      Store,
      Effect.gen(function* () {
        const inner = yield* Store;
        return {
          ...inner,
          writeVersioned: (spec, value) =>
            inner.writeVersioned(spec, value).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  writeCount += 1;
                  for (const waiter of [...waiters]) {
                    if (writeCount >= waiter.target) {
                      waiters.delete(waiter);
                      waiter.done();
                    }
                  }
                }),
              ),
            ),
        };
      }),
    ).pipe(Layer.provide(layerStore(root)));
    const queueLayer = layerDeleteQueue.pipe(
      Layer.provideMerge(Layer.mergeAll(observedStore, clientLayer)),
    );
    return yield* program({
      setConnected: (id, manager) => {
        if (manager === undefined) connected.delete(id);
        else connected.set(id, manager);
      },
      emitAndWaitWrite: (manager) =>
        Effect.gen(function* () {
          const target = writeCount + 1;
          const written = yield* Deferred.make<void>();
          const waiter = {
            target,
            done: () => void Deferred.succeed(written, undefined).pipe(Effect.runSync),
          };
          waiters.add(waiter);
          yield* Effect.sync(() => {
            connected.set(manager.agentId, manager);
          });
          yield* PubSub.publish(hub, manager);
          yield* Deferred.await(written);
        }),
      connectCalls: () => connects,
    }).pipe(Effect.provide(queueLayer));
  });

describe('DeleteQueue', () => {
  it.effect(
    'deletes immediately when the Agent runs and advertises sessionCapabilities.delete',
    () =>
      withTempRoot((root) =>
        runWithClient(root, ({ setConnected, connectCalls }) =>
          Effect.gen(function* () {
            const deleted: Array<AcpSessionId> = [];
            setConnected(
              agentA,
              fakeManager({
                agentId: agentA,
                supportsDelete: true,
                onDelete: (id) => Effect.sync(() => void deleted.push(id)),
              }),
            );
            const queue = yield* DeleteQueue;
            const id1 = AcpSessionId.make('acp-1');
            const id2 = AcpSessionId.make('acp-2');
            yield* queue.deleteOrQueue(agentA, [id1, id2]);

            expect(deleted).toEqual([id1, id2]);
            expect(yield* readDeletesFile(root)).toBeUndefined();
            expect(connectCalls()).toBe(0);
          }),
        ),
      ),
  );

  it.effect(
    'queues into versioned agent-deletes.json when offline or unsupported, deduplicating, and drains on matching initialize',
    () =>
      withTempRoot((root) =>
        runWithClient(root, ({ setConnected, emitAndWaitWrite, connectCalls }) =>
          Effect.gen(function* () {
            const queue = yield* DeleteQueue;
            const id1 = AcpSessionId.make('acp-1');
            const id2 = AcpSessionId.make('acp-2');
            const idB = AcpSessionId.make('acp-b');

            // Offline -> queued
            yield* queue.deleteOrQueue(agentA, [id1, id1]);
            // Connected without capability -> queued
            setConnected(
              agentA,
              fakeManager({
                agentId: agentA,
                supportsDelete: false,
                onDelete: () => Effect.die('should not call without capability'),
              }),
            );
            yield* queue.deleteOrQueue(agentA, [id2]);
            yield* queue.deleteOrQueue(agentB, [idB]);

            const stored = yield* readDeletesFile(root);
            expect(stored?.version).toBe(1);
            expect(stored?.items.map((item) => item['acpSessionId'])).toEqual([id1, id2, idB]);

            const drainedA: Array<AcpSessionId> = [];
            const mgrA = fakeManager({
              agentId: agentA,
              supportsDelete: true,
              onDelete: (id) => Effect.sync(() => void drainedA.push(id)),
            });
            yield* emitAndWaitWrite(mgrA);
            const afterA = yield* readDeletesFile(root);

            expect(drainedA).toEqual([id1, id2]);
            expect(afterA?.items.map((item) => item['acpSessionId'])).toEqual([idB]);
            expect(connectCalls()).toBe(0);
          }),
        ),
      ),
  );

  it.effect('counts Agent errors (Refused / Unsupported) as done', () =>
    withTempRoot((root) =>
      runWithClient(root, ({ emitAndWaitWrite }) =>
        Effect.gen(function* () {
          const queue = yield* DeleteQueue;
          const id1 = AcpSessionId.make('acp-refused');
          const id2 = AcpSessionId.make('acp-unsupported');
          yield* queue.deleteOrQueue(agentA, [id1, id2]);

          yield* emitAndWaitWrite(
            fakeManager({
              agentId: agentA,
              supportsDelete: true,
              onDelete: (id) =>
                id === id1
                  ? Effect.fail(new AcpError({ reason: 'Refused', detail: 'nope' }))
                  : Effect.fail(new AcpError({ reason: 'Unsupported', detail: 'no delete' })),
            }),
          );
          const after = yield* readDeletesFile(root);
          expect(after?.items).toEqual([]);
        }),
      ),
    ),
  );

  it.effect(
    'retries Exited transport failures up to 3 times, then drops with Effect.logWarning',
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const warnings: Array<string> = [];
          const logger = Logger.make(({ logLevel, message }) => {
            if (logLevel === 'Warn') warnings.push(String(message));
          });

          yield* runWithClient(root, ({ emitAndWaitWrite }) =>
            Effect.gen(function* () {
              const queue = yield* DeleteQueue;
              const id1 = AcpSessionId.make('acp-flaky');
              yield* queue.deleteOrQueue(agentA, [id1]);

              for (let attempt = 1; attempt <= 3; attempt += 1) {
                yield* emitAndWaitWrite(
                  fakeManager({
                    agentId: agentA,
                    supportsDelete: true,
                    onDelete: () =>
                      Effect.fail(new AcpError({ reason: 'Exited', detail: 'crashed' })),
                  }),
                );
                const state = yield* readDeletesFile(root);
                if (attempt < 3) {
                  expect(state?.items).toHaveLength(1);
                  expect(state?.items[0]?.['attempts']).toBe(attempt);
                } else {
                  expect(state?.items).toEqual([]);
                }
              }
            }),
          ).pipe(Effect.provide(Logger.layer([logger])));

          expect(warnings.some((msg) => msg.includes('acp-flaky'))).toBe(true);
        }),
      ),
  );

  it.effect('refuses to overwrite an agent-deletes.json from a newer Spence version', () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const future = JSON.stringify({ version: 99, items: [{ futureField: true }] });
        yield* Effect.promise(async () => {
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, AGENT_DELETES_FILE), future, 'utf8');
        });
        yield* runWithClient(root, () =>
          Effect.gen(function* () {
            const queue = yield* DeleteQueue;
            yield* queue.deleteOrQueue(agentA, [AcpSessionId.make('acp-1')]);
          }),
        );
        const onDisk = yield* Effect.promise(() =>
          readFile(path.join(root, AGENT_DELETES_FILE), 'utf8'),
        );
        expect(onDisk).toBe(future);
      }),
    ),
  );
});
