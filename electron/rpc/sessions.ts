import { Layer } from 'effect';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { layerSessionStore, SessionStore } from '../sessions/session-store';
import { layerStoreUserData } from '../store/store';

export const layerSessionsHandlers = SessionsRpcs.toLayer({
  'Session.list': ({ projectId }) => SessionStore.use((store) => store.list(projectId)),
}).pipe(Layer.provide(layerSessionStore), Layer.provide(layerStoreUserData));
