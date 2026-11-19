import { Context, Effect, Exit, Layer, Option, Scope, Stream, SubscriptionRef } from 'effect';
import { powerSaveBlocker } from 'electron';
import { AgentLifetime } from '../acp/acpLifetime';
import { Hosting } from '../lan/hosting';

export interface PowerBlockerShape {
  /** Keeps the OS from suspending the app for the life of the scope (`prevent-app-suspension`). */
  readonly hold: Effect.Effect<void, never, Scope.Scope>;
}

/** The OS sleep boundary. Live it is Electron's `powerSaveBlocker`; specs use `makePowerBlockerTest`. */
export class PowerBlocker extends Context.Service<PowerBlocker, PowerBlockerShape>()(
  'hosting/PowerBlocker',
) {}

export const layerPowerBlockerLive: Layer.Layer<PowerBlocker> = Layer.succeed(PowerBlocker, {
  hold: Effect.asVoid(
    Effect.acquireRelease(
      Effect.sync(() => powerSaveBlocker.start('prevent-app-suspension')),
      (id) => Effect.sync(() => powerSaveBlocker.stop(id)),
    ),
  ),
});

/** A blocker a spec reads: whether it is held now (and on every change) and how many times it was taken. */
export const makePowerBlockerTest = Effect.gen(function* () {
  const held = yield* SubscriptionRef.make(false);
  let starts = 0;
  return {
    layer: Layer.succeed(PowerBlocker, {
      hold: Effect.acquireRelease(
        Effect.andThen(
          Effect.sync(() => {
            starts += 1;
          }),
          SubscriptionRef.set(held, true),
        ),
        () => SubscriptionRef.set(held, false),
      ),
    }),
    held: SubscriptionRef.get(held),
    changes: SubscriptionRef.changes(held),
    starts: Effect.sync(() => starts),
  };
});

/**
 * Holds the power blocker only while this Device hosts and at least one Turn runs on it (Remote-started ones too),
 * so idle hosting costs no battery and a Device that does not host never holds it. Runs until interrupted.
 */
export const keepAwake = Effect.fnUntraced(function* (
  hosting: Stream.Stream<boolean>,
  working: Stream.Stream<number>,
) {
  const blocker = yield* PowerBlocker;
  let held: Option.Option<Scope.Closeable> = Option.none();
  const release = Effect.suspend(() => {
    if (Option.isNone(held)) return Effect.void;
    const scope = held.value;
    held = Option.none();
    return Scope.close(scope, Exit.void);
  });
  const take = Effect.fnUntraced(function* (wanted: boolean) {
    if (!wanted) return yield* release;
    if (Option.isSome(held)) return;
    const scope = yield* Scope.make();
    yield* Scope.provide(scope)(blocker.hold);
    held = Option.some(scope);
  });
  yield* Stream.zipLatest(hosting, working).pipe(
    Stream.map(([on, turns]) => on && turns > 0),
    Stream.changes,
    Stream.runForEach(take),
    Effect.ensuring(release),
  );
});

/** Keeps a hosting Device awake while a Turn runs on it, for the life of the layer. */
export const layerKeepAwake: Layer.Layer<never, never, Hosting | AgentLifetime | PowerBlocker> =
  Layer.effectDiscard(
    Effect.gen(function* () {
      const hosting = yield* Hosting;
      const lifetime = yield* AgentLifetime;
      yield* Effect.forkScoped(keepAwake(hosting.serving, lifetime.workingChanges));
    }),
  );
