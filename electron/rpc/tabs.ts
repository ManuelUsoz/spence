import { Effect, Layer, Stream } from 'effect';
import { TabsRpcs } from '../../src/shared/tabs/tabs.rpc';
import { layerSessionStoreLive } from '../sessions/session-store';
import { Sessions } from '../sessions/sessions';
import { layerTabActivations, TabActivations } from '../sessions/tab-activations';
import { layerSessionsLive } from './sessions';

export const layerTabsHandlers = TabsRpcs.toLayer({
  'Tabs.restore': () => Sessions.use((sessions) => sessions.restoreTabs),
  'Tabs.update': ({ workspace }) => Sessions.use((sessions) => sessions.setTabs(workspace)),
  'Tabs.activations': () =>
    Stream.unwrap(TabActivations.use((activations) => Effect.succeed(activations.stream))),
}).pipe(
  Layer.provide(Layer.mergeAll(layerSessionsLive, layerSessionStoreLive, layerTabActivations)),
);
