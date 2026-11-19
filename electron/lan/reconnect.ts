import { Duration, Effect, Schedule } from 'effect';

/** The first wait before reaching a dropped Device again. */
const FIRST_DELAY_MS = 500;
/** Each wait is this much longer than the one before, up to `FAST_CAP_MS`. */
const FACTOR = 1.5;
const FAST_CAP_MS = 5_000;
/** Once the fast phase is over, a Device is tried this often, for as long as it stays paired. */
const SLOW_DELAY_MS = 30_000;

/** How long to wait before the `attempt`-th retry (from 1), `elapsedMillis` after the first try. */
export const reconnectDelay = (
  attempt: number,
  elapsedMillis: number,
  fastFor: Duration.Input,
): number =>
  elapsedMillis < Duration.toMillis(Duration.fromInputUnsafe(fastFor))
    ? Math.min(FIRST_DELAY_MS * FACTOR ** (attempt - 1), FAST_CAP_MS)
    : SLOW_DELAY_MS;

/**
 * When to reach a Paired device again after a try failed: 500 ms, then 1.5 times longer each try up to 5 s while
 * `fastFor` (the spec's first minute) lasts, then every 30 s. It never gives up: the Device is still paired.
 */
export const reconnectSchedule = (fastFor: Duration.Input): Schedule.Schedule<number> =>
  Schedule.forever.pipe(
    Schedule.modifyDelay(({ attempt, elapsed }) =>
      Effect.succeed(Duration.millis(reconnectDelay(attempt, elapsed, fastFor))),
    ),
  );
