import { Layer } from 'effect';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { layerSessionStoreLive, SessionStore } from '../sessions/session-store';

export const layerSessionsHandlers = SessionsRpcs.toLayer({
  'Session.list': ({ projectId }) => SessionStore.use((store) => store.list(projectId)),
}).pipe(Layer.provide(layerSessionStoreLive));
