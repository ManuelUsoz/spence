import { describe, expect, it } from '@effect/vitest';
import { Deferred, Duration, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { OperationId } from '../../src/shared/source-control/source-control.rpc';
import {
  ReservationCoordinator,
  layerReservationCoordinator,
  reservationKeys,
} from './reservation-coordinator';

describe('ReservationCoordinator', () => {
  it.effect(
    'acquires overlapping multi-key reservations in deterministic order without deadlock',
    () =>
      Effect.gen(function* () {
        const coordinator = yield* ReservationCoordinator;
        const enteredA = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const order: string[] = [];

        const fiberA = yield* coordinator
          .withReservation(
            {
              holderId: 'op-a',
              keys: [reservationKeys.folder('/tmp/wt-1'), reservationKeys.repo('repo-1')],
              mode: 'exclusive',
              reason: 'Create worktree A',
            },
            Effect.gen(function* () {
              order.push('A-enter');
              yield* Deferred.succeed(enteredA, undefined);
              yield* Deferred.await(releaseA);
              order.push('A-exit');
            }),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(enteredA);

        // Reversed key order; deterministic sorting avoids deadlock and runs strictly after A exits.
        const fiberB = yield* coordinator
          .withReservation(
            {
              holderId: 'op-b',
              keys: [reservationKeys.repo('repo-1'), reservationKeys.folder('/tmp/wt-1')],
              mode: 'exclusive',
              reason: 'Create worktree B',
            },
            Effect.sync(() => {
              order.push('B-enter');
            }),
          )
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        expect(order).toEqual(['A-enter']);

        yield* Deferred.succeed(releaseA, undefined);
        yield* Fiber.join(fiberA);
        yield* Fiber.join(fiberB);
        expect(order).toEqual(['A-enter', 'A-exit', 'B-enter']);
      }).pipe(Effect.provide(layerReservationCoordinator)),
  );

  it.effect('rejects timed-out busy reservations cleanly under TestClock', () =>
    Effect.gen(function* () {
      const coordinator = yield* ReservationCoordinator;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const holder = yield* coordinator
        .withReservation(
          {
            holderId: 'op-hold',
            keys: [reservationKeys.folder('/tmp/wt-busy')],
            mode: 'exclusive',
            reason: 'Hold destination',
          },
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);

      const contender = yield* coordinator
        .withReservation(
          {
            holderId: 'op-waiter',
            keys: [reservationKeys.folder('/tmp/wt-busy')],
            mode: 'exclusive',
            reason: 'Competing operation',
            waitMs: 500,
          },
          Effect.succeed('should-not-run'),
        )
        .pipe(Effect.result, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(600));
      const outcome = yield* Fiber.join(contender);
      expect(outcome._tag).toBe('Failure');
      if (outcome._tag === 'Failure') {
        expect(outcome.failure.reason).toBe('Busy');
      }

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
    }).pipe(Effect.provide(layerReservationCoordinator)),
  );

  it.effect(
    'tracks active Turns separately and blocks conflicting mutations and new Turns on unresolved recovery',
    () =>
      Effect.gen(function* () {
        const coordinator = yield* ReservationCoordinator;
        const wtKey = reservationKeys.worktree('wt-main');
        const destKey = reservationKeys.folder('/tmp/wt-new');
        const opId = OperationId.make('op-recovery-1');

        // Active Turn tracked independently.
        yield* coordinator.registerTurn('session-1', [wtKey]);
        expect(yield* coordinator.activeTurnsFor([wtKey])).toEqual(['session-1']);

        // Idle-only hold rejects while Turn active.
        const busyHold = yield* coordinator
          .holdIdleTargets('op-idle', [wtKey], 'Idle worktree mutation')
          .pipe(Effect.result);
        expect(busyHold._tag).toBe('Failure');

        // Creating a separate worktree (`destKey`) succeeds without disturbing `wtKey` Turn!
        const unrelated = yield* coordinator.withReservation(
          {
            holderId: 'op-new-wt',
            keys: [destKey],
            mode: 'exclusive',
            reason: 'Create separate worktree',
          },
          Effect.succeed('ok'),
        );
        expect(unrelated).toBe('ok');

        yield* coordinator.releaseTurn('session-1');
        expect(yield* coordinator.activeTurnsFor([wtKey])).toEqual([]);

        // Idle hold succeeds once Turn finishes, and prevents new Turns until released.
        yield* coordinator.holdIdleTargets('op-idle', [wtKey], 'Mutating wt-main');
        const blockedTurn = yield* coordinator
          .registerTurn('session-2', [wtKey])
          .pipe(Effect.result);
        expect(blockedTurn._tag).toBe('Failure');
        if (blockedTurn._tag === 'Failure') {
          expect(blockedTurn.failure.reason).toBe('Busy');
        }
        yield* coordinator.releaseIdleTargets('op-idle');

        // Unresolved recovery blocks matching reservation targets and matching Turns until cleared.
        yield* coordinator.setUnresolvedTargets(
          opId,
          [destKey],
          'Partial directory needs inspection',
        );
        const blockedCreate = yield* coordinator
          .withReservation(
            {
              holderId: 'op-retry-other',
              keys: [destKey],
              mode: 'exclusive',
              reason: 'Overwrite unresolved target',
            },
            Effect.succeed('nope'),
          )
          .pipe(Effect.result);
        expect(blockedCreate._tag).toBe('Failure');
        if (blockedCreate._tag === 'Failure') {
          expect(blockedCreate.failure.reason).toBe('RecoveryRequired');
        }

        yield* coordinator.clearUnresolvedTargets(opId);
        const allowed = yield* coordinator.withReservation(
          {
            holderId: 'op-retry-other',
            keys: [destKey],
            mode: 'exclusive',
            reason: 'Clean destination after clear',
          },
          Effect.succeed('allowed'),
        );
        expect(allowed).toBe('allowed');
      }).pipe(Effect.provide(layerReservationCoordinator)),
  );
});
