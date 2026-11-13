import { Context, Effect, Layer, PubSub, Queue, Stream } from 'effect';
import type { TabActivation } from '../../src/shared/tabs/tabs.rpc';

export interface TabActivationsShape {
  readonly emit: (activation: TabActivation) => void;
  readonly stream: Stream.Stream<TabActivation>;
}

/** Requests from main (such as clicking an OS Attention notification) to open/activate a Session Tab. */
export class TabActivations extends Context.Service<TabActivations, TabActivationsShape>()(
  'tabs/TabActivations',
) {}

export const layerTabActivations = Layer.effect(
  TabActivations,
  Effect.gen(function* () {
    const inbox = yield* Queue.unbounded<TabActivation>();
    const bus = yield* PubSub.unbounded<TabActivation>();
    yield* Queue.take(inbox).pipe(
      Effect.flatMap((activation) => PubSub.publish(bus, activation)),
      Effect.forever,
      Effect.forkScoped,
    );
    return TabActivations.of({
      emit: (activation) => {
        Queue.offerUnsafe(inbox, activation);
      },
      stream: Stream.fromPubSub(bus),
    });
  }),
);
