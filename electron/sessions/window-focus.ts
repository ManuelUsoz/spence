import { Context, Effect, Layer, type Stream, SubscriptionRef } from 'effect';

export interface WindowFocusShape {
  readonly isFocused: Effect.Effect<boolean>;
  readonly changes: Stream.Stream<boolean>;
  readonly setFocused: (focused: boolean) => Effect.Effect<void>;
}

/** Tracks whether Spence's main `BrowserWindow` currently has OS focus. */
export class WindowFocus extends Context.Service<WindowFocus, WindowFocusShape>()(
  'sessions/WindowFocus',
) {}

export const layerWindowFocus = Layer.effect(
  WindowFocus,
  Effect.gen(function* () {
    const focused = yield* SubscriptionRef.make(false);

    return WindowFocus.of({
      isFocused: SubscriptionRef.get(focused),
      changes: SubscriptionRef.changes(focused),
      setFocused: (next) => SubscriptionRef.set(focused, next),
    });
  }),
);
