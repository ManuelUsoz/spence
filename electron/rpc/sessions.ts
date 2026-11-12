import { Effect, Layer, Stream } from 'effect';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { layerAgentLogsUserData } from '../acp/acpAgentLog';
import { layerAcpClient } from '../acp/acpSessionManager';
import { layerProjectsLive } from '../projects/projects';
import { layerSessionAgentLive } from '../sessions/session-agent';
import { layerSessionStoreLive, SessionStore } from '../sessions/session-store';
import { layerSessions, Sessions } from '../sessions/sessions';
import { layerSettingsMain } from '../settings/window';

/** The ACP client stack for the app's lifetime: one process per Agent, logs under `<userData>`. */
const layerAcpClientLive = layerAcpClient.pipe(
  Layer.provide(layerAgentLogsUserData),
  Layer.provideMerge(layerSessionAgentLive),
);

const layerSessionsLive = layerSessions.pipe(
  Layer.provide(
    Layer.mergeAll(layerAcpClientLive, layerSessionStoreLive, layerProjectsLive, layerSettingsMain),
  ),
);

export const layerSessionsHandlers = SessionsRpcs.toLayer({
  'Session.list': ({ projectId }) => SessionStore.use((store) => store.list(projectId)),
  'Session.create': ({ projectId }) => Sessions.use((sessions) => sessions.create(projectId)),
  'Session.prompt': ({ sessionId, parts }) =>
    Sessions.use((sessions) => sessions.prompt(sessionId, parts)),
  'Session.cancel': ({ sessionId }) => Sessions.use((sessions) => sessions.cancel(sessionId)),
  'Session.events': ({ sessionId, afterSeq }) =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.events(sessionId, afterSeq)))),
}).pipe(Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerSessionsLive)));
