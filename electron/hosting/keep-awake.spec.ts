import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream, SubscriptionRef } from 'effect';
import { keepAwake, makePowerBlockerTest } from './keep-awake';

/** Hosting on/off and the running Turns as a spec drives them, with the blocker as the OS would see it. */
const setup = Effect.gen(function* () {
  const hosting = yield* SubscriptionRef.make(false);
  const working = yield* SubscriptionRef.make(0);
  const blocker = yield* makePowerBlockerTest;
  yield* keepAwake(SubscriptionRef.changes(hosting), SubscriptionRef.changes(working)).pipe(
    Effect.provide(blocker.layer),
    Effect.forkScoped,
  );
  /** Waits until the blocker is held (`true`) or not, as it settles after a change. */
  const awaitHeld = (held: boolean) =>
    blocker.changes.pipe(
      Stream.filter((now) => now === held),
      Stream.runHead,
    );
  return { hosting, working, blocker, awaitHeld };
});

describe('keepAwake', () => {
  it.live('a hosting Device is kept from sleeping only while a Turn runs', () =>
    Effect.gen(function* () {
      const { hosting, working, blocker, awaitHeld } = yield* setup;
      yield* SubscriptionRef.set(hosting, true);
      yield* Effect.yieldNow;
      expect(yield* blocker.held).toBe(false);

      yield* SubscriptionRef.set(working, 2);
      yield* awaitHeld(true);
      yield* SubscriptionRef.set(working, 1);
      yield* Effect.yieldNow;
      expect(yield* blocker.starts).toBe(1);

      yield* SubscriptionRef.set(working, 0);
      yield* awaitHeld(false);
    }).pipe(Effect.scoped),
  );

  it.live('a Device that does not host holds nothing, even while a Turn runs', () =>
    Effect.gen(function* () {
      const { working, blocker } = yield* setup;
      yield* SubscriptionRef.set(working, 1);
      yield* Effect.sleep('20 millis');
      expect(yield* blocker.held).toBe(false);
      expect(yield* blocker.starts).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.live('turning hosting off lets go while a Turn still runs', () =>
    Effect.gen(function* () {
      const { hosting, working, awaitHeld } = yield* setup;
      yield* SubscriptionRef.set(hosting, true);
      yield* SubscriptionRef.set(working, 1);
      yield* awaitHeld(true);

      yield* SubscriptionRef.set(hosting, false);
      yield* awaitHeld(false);
    }).pipe(Effect.scoped),
  );
});
