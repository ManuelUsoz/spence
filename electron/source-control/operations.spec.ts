import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OperationId,
  type OperationSnapshot,
  SourceControlError,
} from '../../src/shared/source-control/source-control.rpc';
import { Store, layerStore } from '../store/store';
import { Operations, layerOperations, makeLayerOperations } from './operations';
import {
  ReservationCoordinator,
  layerReservationCoordinator,
  reservationKeys,
} from './reservation-coordinator';

const withTempStore = <A, E, R>(fn: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-ops-'))),
    fn,
    (dir) =>
      Effect.promise(() =>
        rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  );

const makeOpsLayer = (root: string, hook?: Parameters<typeof makeLayerOperations>[0]) =>
  makeLayerOperations(hook).pipe(
    Layer.provideMerge(layerReservationCoordinator),
    Layer.provideMerge(layerStore(root)),
  );

describe('Operations durable journal and restart reconciliation', () => {
  it.effect('enforces idempotency on identical retries and rejects conflicting reuse', () =>
    withTempStore((dir) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(10_000);
        const ops = yield* Operations;
        const opId = OperationId.make('op-idem-1');
        let applyCalls = 0;

        const first = yield* ops.execute({
          operationId: opId,
          kind: 'Worktree.create',
          title: 'Create Worktree feat/one',
          requestDigest: 'digest-1',
          lockKeys: [reservationKeys.folder(path.join(dir, 'wt-1'))],
          targetPath: path.join(dir, 'wt-1'),
          branch: 'feat/one',
          metadata: { branch: 'feat/one' },
          prepare: () => Effect.succeed({}),
          apply: Effect.fnUntraced(function* ({ reportProgress }) {
            applyCalls += 1;
            yield* reportProgress('ExecutingGit', 'Creating worktree');
            return { _tag: 'Succeeded' as const };
          }),
        });

        expect(first.phase).toBe('Completed');
        expect(first.outcome).toBe('Succeeded');
        expect(applyCalls).toBe(1);

        // Exact retry returns persisted snapshot without re-running apply.
        const second = yield* ops.execute({
          operationId: opId,
          kind: 'Worktree.create',
          title: 'Create Worktree feat/one',
          requestDigest: 'digest-1',
          lockKeys: [reservationKeys.folder(path.join(dir, 'wt-1'))],
          targetPath: path.join(dir, 'wt-1'),
          branch: 'feat/one',
          metadata: { branch: 'feat/one' },
          prepare: () => Effect.die('must not re-run prepare on completed operation'),
          apply: () => Effect.die('must not re-run apply on completed operation'),
        });

        expect(second.id).toBe(opId);
        expect(second.outcome).toBe('Succeeded');
        expect(applyCalls).toBe(1);

        // Conflicting reuse with different digest fails cleanly.
        const conflict = yield* ops
          .execute({
            operationId: opId,
            kind: 'Worktree.create',
            title: 'Create Worktree feat/two',
            requestDigest: 'digest-different',
            lockKeys: [reservationKeys.folder(path.join(dir, 'wt-2'))],
            metadata: { branch: 'feat/two' },
            prepare: () => Effect.succeed({}),
            apply: () => Effect.die('must not run'),
          })
          .pipe(Effect.result);

        expect(conflict._tag).toBe('Failure');
        if (conflict._tag === 'Failure') {
          expect(conflict.failure.reason).toBe('Conflict');
        }
      }).pipe(Effect.provide(makeOpsLayer(dir))),
    ),
  );

  it.effect('continues durable execution to completion when caller RPC fiber disconnects', () =>
    withTempStore((dir) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(20_000);
        const ops = yield* Operations;
        const opId = OperationId.make('op-disconnect-1');
        const started = yield* Deferred.make<void>();
        const allowFinish = yield* Deferred.make<void>();

        const callerFiber = yield* ops
          .execute({
            operationId: opId,
            kind: 'Worktree.create',
            title: 'Create Worktree survive disconnect',
            requestDigest: 'digest-disc',
            lockKeys: [reservationKeys.folder(path.join(dir, 'wt-disc'))],
            targetPath: path.join(dir, 'wt-disc'),
            branch: 'feat/disc',
            metadata: {},
            prepare: () => Effect.succeed({}),
            apply: Effect.fnUntraced(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(allowFinish);
              return { _tag: 'Succeeded' as const };
            }),
          })
          .pipe(Effect.forkChild);

        yield* Deferred.await(started);
        const completionWatch = yield* ops.updates.pipe(
          Stream.filter(
            (snap: OperationSnapshot) => snap.id === opId && snap.phase === 'Completed',
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;

        // Simulate renderer transport closing / interrupting caller RPC fiber.
        yield* Fiber.interrupt(callerFiber);

        // Release work after disconnect and verify operation completes cleanly.
        yield* Deferred.succeed(allowFinish, undefined);
        const awaited = yield* ops.awaitOperation(opId);
        expect(awaited.phase).toBe('Completed');
        expect(awaited.outcome).toBe('Succeeded');
        const stored = yield* ops.getOperation(opId);
        expect(stored.phase).toBe('Completed');
        expect(stored.outcome).toBe('Succeeded');
        const collected = yield* Fiber.join(completionWatch);
        expect([...collected].length).toBe(1);
      }).pipe(Effect.provide(makeOpsLayer(dir))),
    ),
  );

  it.effect(
    'reconciles Prepared and Applying journals across restart without blindly replaying mutation',
    () =>
      withTempStore((dir) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(30_000);
          const opPrepared = OperationId.make('op-crash-prepared');
          const opAppliedOk = OperationId.make('op-crash-applied-ok');
          const opAppliedPartial = OperationId.make('op-crash-partial');

          // 1. Crash after writing Prepared journal (mutation never ran).
          const crashPreparedExit = yield* Effect.gen(function* () {
            const ops = yield* Operations;
            return yield* ops.execute({
              operationId: opPrepared,
              kind: 'Worktree.create',
              title: 'Interrupted before apply',
              requestDigest: 'd-prep',
              lockKeys: [reservationKeys.folder(path.join(dir, 'wt-prep'))],
              metadata: {},
              prepare: () => Effect.succeed({}),
              apply: () => Effect.die('should not reach apply'),
            });
          }).pipe(
            Effect.provide(
              makeOpsLayer(dir, {
                onPhaseTransition: (phase) =>
                  phase === 'Prepared'
                    ? Effect.die('simulated crash right after Prepared journal flush')
                    : Effect.void,
              }),
            ),
            Effect.exit,
          );
          expect(crashPreparedExit._tag).toBe('Failure');

          // 2. Crash right after writing Applying journal (with postconditions actually present).
          const crashOkExit = yield* Effect.gen(function* () {
            const ops = yield* Operations;
            return yield* ops.execute({
              operationId: opAppliedOk,
              kind: 'Worktree.create',
              title: 'Interrupted after git finished',
              requestDigest: 'd-ok',
              lockKeys: [reservationKeys.folder(path.join(dir, 'wt-ok'))],
              targetPath: path.join(dir, 'wt-ok'),
              branch: 'feat/ok',
              metadata: { targetPath: path.join(dir, 'wt-ok') },
              prepare: () => Effect.succeed({}),
              apply: () => Effect.die('simulated crash during git step'),
            });
          }).pipe(
            Effect.provide(
              makeOpsLayer(dir, {
                onPhaseTransition: (phase) =>
                  phase === 'Applying'
                    ? Effect.die('simulated crash right after Applying flush')
                    : Effect.void,
              }),
            ),
            Effect.exit,
          );
          expect(crashOkExit._tag).toBe('Failure');

          // 3. Crash right after Applying when postconditions are partial on disk.
          yield* Effect.gen(function* () {
            const ops = yield* Operations;
            return yield* ops.execute({
              operationId: opAppliedPartial,
              kind: 'Worktree.create',
              title: 'Interrupted partial',
              requestDigest: 'd-part',
              lockKeys: [reservationKeys.folder(path.join(dir, 'wt-partial'))],
              targetPath: path.join(dir, 'wt-partial'),
              branch: 'feat/part',
              metadata: {},
              prepare: () => Effect.succeed({}),
              apply: () => Effect.die('crash'),
            });
          }).pipe(
            Effect.provide(
              makeOpsLayer(dir, {
                onPhaseTransition: (phase) =>
                  phase === 'Applying' ? Effect.die('simulated crash') : Effect.void,
              }),
            ),
            Effect.exit,
          );

          // Fresh process startup over the same Store: register postcondition reconciler.
          let replayCount = 0;
          yield* Effect.gen(function* () {
            const ops = yield* Operations;
            const coordinator = yield* ReservationCoordinator;

            yield* ops.registerReconciler('Worktree.create', (record) => {
              if (record.snapshot.id === opAppliedOk) {
                return Effect.succeed({
                  _tag: 'Succeeded' as const,
                  detail: 'Verified created Worktree on disk without replaying.',
                });
              }
              return Effect.succeed({
                _tag: 'NeedsRecovery' as const,
                outcome: 'NeedsRecovery' as const,
                recovery: {
                  summary: 'Unregistered directory exists at destination.',
                  detail: 'Folder was created on disk but not registered in Git.',
                  observedFolderExists: true,
                  observedRegisteredInGit: false,
                  observedBranchExists: false,
                  canReconcile: true,
                  canDismiss: true,
                },
              });
            });

            yield* ops.reconcilePendingForKind('Worktree.create');

            const prepSnap = yield* ops.getOperation(opPrepared);
            expect(prepSnap.phase).toBe('Completed');
            expect(prepSnap.outcome).toBe('Cancelled');

            const okSnap = yield* ops.getOperation(opAppliedOk);
            expect(okSnap.phase).toBe('Completed');
            expect(okSnap.outcome).toBe('Succeeded');

            const partSnap = yield* ops.getOperation(opAppliedPartial);
            expect(partSnap.phase).toBe('NeedsRecovery');
            expect(partSnap.recovery?.observedFolderExists).toBe(true);

            // Target of NeedsRecovery operation remains locked until dismissed!
            const blocked = yield* coordinator
              .withReservation(
                {
                  holderId: 'new-op',
                  keys: [reservationKeys.folder(path.join(dir, 'wt-partial'))],
                  mode: 'exclusive',
                  reason: 'Reuse partial folder',
                },
                Effect.sync(() => {
                  replayCount += 1;
                }),
              )
              .pipe(Effect.result);
            expect(blocked._tag).toBe('Failure');
            if (blocked._tag === 'Failure') {
              expect(blocked.failure.reason).toBe('RecoveryRequired');
            }
            expect(replayCount).toBe(0);

            // Explicit dismiss settles recovery and unlocks target cleanly.
            const dismissed = yield* ops.dismissOperation(opAppliedPartial);
            expect(dismissed.phase).toBe('Completed');
            expect(dismissed.outcome).toBe('Cancelled');
            expect((yield* coordinator.listUnresolvedTargets()).length).toBe(0);

            // Store was actually used.
            const store = yield* Store;
            expect(store.root).toBe(dir);
          }).pipe(Effect.provide(makeOpsLayer(dir)));
        }),
      ),
  );

  it.effect(
    'allows cancellation before Applying and rejects cancellation once Applying started',
    () =>
      withTempStore((dir) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(40_000);
          const ops = yield* Operations;

          const opEarly = OperationId.make('op-cancel-early');
          const prepEntered = yield* Deferred.make<void>();
          const releasePrep = yield* Deferred.make<void>();
          let applyRan = false;

          const earlyFiber = yield* ops
            .execute({
              operationId: opEarly,
              kind: 'Worktree.create',
              title: 'Cancel before apply',
              requestDigest: 'd-early',
              lockKeys: [reservationKeys.folder(path.join(dir, 'wt-early'))],
              metadata: {},
              prepare: Effect.fnUntraced(function* () {
                yield* Deferred.succeed(prepEntered, undefined);
                yield* Deferred.await(releasePrep);
                return {};
              }),
              apply: () => {
                applyRan = true;
                return Effect.succeed({ _tag: 'Succeeded' as const });
              },
            })
            .pipe(Effect.forkChild);

          yield* Deferred.await(prepEntered);
          const cancelled = yield* ops.cancelOperation(opEarly);
          expect(cancelled.phase).toBe('Completed');
          expect(cancelled.outcome).toBe('Cancelled');
          yield* Deferred.succeed(releasePrep, undefined);
          const earlyOutcome = yield* Fiber.join(earlyFiber);
          expect(earlyOutcome.outcome).toBe('Cancelled');
          expect(applyRan).toBe(false);

          const opLate = OperationId.make('op-cancel-late');
          const applyEntered = yield* Deferred.make<void>();
          const releaseApply = yield* Deferred.make<void>();

          const lateFiber = yield* ops
            .execute({
              operationId: opLate,
              kind: 'Worktree.create',
              title: 'Too late to cancel',
              requestDigest: 'd-late',
              lockKeys: [reservationKeys.folder(path.join(dir, 'wt-late'))],
              metadata: {},
              prepare: () => Effect.succeed({}),
              apply: Effect.fnUntraced(function* () {
                yield* Deferred.succeed(applyEntered, undefined);
                yield* Deferred.await(releaseApply);
                return { _tag: 'Succeeded' as const };
              }),
            })
            .pipe(Effect.forkChild);

          yield* Deferred.await(applyEntered);
          const lateCancel = yield* ops.cancelOperation(opLate).pipe(Effect.result);
          expect(lateCancel._tag).toBe('Failure');
          if (lateCancel._tag === 'Failure') {
            expect(lateCancel.failure.reason).toBe('Conflict');
          }
          yield* Deferred.succeed(releaseApply, undefined);
          const lateSnap = yield* Fiber.join(lateFiber);
          expect(lateSnap.outcome).toBe('Succeeded');
        }).pipe(
          Effect.provide(
            layerOperations.pipe(
              Layer.provideMerge(layerReservationCoordinator),
              Layer.provideMerge(layerStore(dir)),
            ),
          ),
        ),
      ),
  );
});

void SourceControlError;
