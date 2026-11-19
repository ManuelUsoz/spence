import { describe, expect, it } from '@effect/vitest';
import { Clock, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { reconnectSchedule } from './reconnect';

/** Runs an attempt that never succeeds under the schedule for `forMillis`, and says when each attempt ran. */
const attemptTimes = (forMillis: number) =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    const attempt = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      times.push(now);
      return Effect.fail('unreachable');
    });
    const fiber = yield* Effect.forkChild(Effect.retry(attempt, reconnectSchedule('1 minute')));
    yield* TestClock.adjust(forMillis);
    yield* Fiber.interrupt(fiber);
    return times;
  });

const gaps = (times: ReadonlyArray<number>): ReadonlyArray<number> =>
  times.slice(1).map((time, i) => time - (times[i] ?? 0));

describe('reconnect backoff', () => {
  it.effect('waits 500 ms, then 1.5 times longer each try, up to 5 s', () =>
    Effect.gen(function* () {
      const times = yield* attemptTimes(30_000);
      expect(gaps(times).slice(0, 9)).toEqual([
        500, 750, 1125, 1687.5, 2531.25, 3796.875, 5000, 5000, 5000,
      ]);
    }),
  );

  it.effect('after the first minute, tries every 30 s and never gives up', () =>
    Effect.gen(function* () {
      const times = yield* attemptTimes(10 * 60_000);
      const late = times.filter((time) => time > 60_000);
      // The first try past the minute was scheduled inside it; from then on, every 30 s.
      expect(gaps(late).length).toBeGreaterThan(15);
      expect(new Set(gaps(late))).toEqual(new Set([30_000]));
      const early = times.filter((time) => time <= 60_000);
      expect(Math.max(...gaps(early))).toBe(5000);
    }),
  );
});
