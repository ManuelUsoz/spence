import { Effect, Layer, Stream } from 'effect';
import { TabsRpcs } from '../../src/shared/tabs/tabs.rpc';
import { layerSessionStoreLive } from '../sessions/session-store';
import { Sessions } from '../sessions/sessions';
import { layerTabActivations, TabActivations } from '../sessions/tab-activations';
import { Remembered } from '../settings/remembered';
import { layerSettingsMain } from '../settings/window';
import { layerSessionsLive } from './sessions';

/** The Tabs to open at launch: Local ones from Sessions, Remote ones from their remembered stubs. */
const restoreTabs = Effect.fnUntraced(function* () {
  const local = yield* Sessions.use((sessions) => sessions.restoreTabs);
  const remote = yield* Remembered.use((remembered) => remembered.remoteTabs);
  return remote.tabs.length === 0 ? local : { ...local, remote };
});

export const layerTabsHandlers = TabsRpcs.toLayer({
  'Tabs.restore': () => restoreTabs(),
  'Tabs.update': ({ open, active, remote }) =>
    Effect.andThen(
      Sessions.use((sessions) => sessions.setTabs(open, active)),
      Remembered.use((remembered) => remembered.rememberRemoteTabs(remote ?? { tabs: [] })),
    ),
  'Tabs.activations': () =>
    Stream.unwrap(TabActivations.use((activations) => Effect.succeed(activations.stream))),
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      layerSessionsLive,
      layerSessionStoreLive,
      layerTabActivations,
      layerSettingsMain,
    ),
  ),
);
