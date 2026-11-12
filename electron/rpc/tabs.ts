import { Layer } from 'effect';
import { TabsRpcs } from '../../src/shared/tabs/tabs.rpc';
import { layerSessionStoreLive } from '../sessions/session-store';
import { Sessions } from '../sessions/sessions';
import { layerSessionsLive } from './sessions';

export const layerTabsHandlers = TabsRpcs.toLayer({
  'Tabs.restore': () => Sessions.use((sessions) => sessions.restoreTabs),
  'Tabs.update': ({ open, active }) => Sessions.use((sessions) => sessions.setTabs(open, active)),
}).pipe(Layer.provide(Layer.mergeAll(layerSessionsLive, layerSessionStoreLive)));
