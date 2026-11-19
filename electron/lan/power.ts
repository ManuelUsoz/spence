import { Context, Effect, Layer, PubSub, Stream } from 'effect';
import { powerMonitor } from 'electron';

/** What the OS says about sleeping that the LAN cares about. */
export interface PowerEventsShape {
  /** The computer woke up: connections may be stale and Devices that were away may be back. */
  readonly resumes: Stream.Stream<void>;
}

/** The OS power boundary. Live it is Electron's `powerMonitor`; specs inject resumes with `makePowerEventsTest`. */
export class PowerEvents extends Context.Service<PowerEvents, PowerEventsShape>()(
  'lan/PowerEvents',
) {}

/** `powerMonitor` `resume`, listened to for the life of the layer. */
export const layerPowerEventsLive: Layer.Layer<PowerEvents> = Layer.effect(
  PowerEvents,
  Effect.gen(function* () {
    const resumes = yield* PubSub.unbounded<void>();
    const onResume = (): void => {
      PubSub.publishUnsafe(resumes, undefined);
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => powerMonitor.on('resume', onResume)),
      () => Effect.sync(() => powerMonitor.off('resume', onResume)),
    );
    return { resumes: Stream.fromPubSub(resumes) };
  }),
);

/** Power events a spec drives: `resume` plays the computer waking up. */
export const makePowerEventsTest = Effect.gen(function* () {
  const resumes = yield* PubSub.unbounded<void>();
  return {
    layer: Layer.succeed(PowerEvents, { resumes: Stream.fromPubSub(resumes) }),
    resume: Effect.asVoid(PubSub.publish(resumes, undefined)),
  };
});
