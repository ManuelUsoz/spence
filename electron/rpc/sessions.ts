import { Effect, Layer, Stream } from 'effect';
import { app, shell } from 'electron';
import { join } from 'node:path';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerProjectsLive } from '../projects/projects';
import { layerSessionAgentLive, SessionAgent } from '../sessions/session-agent';
import { layerSessionStoreLive, SessionStore } from '../sessions/session-store';
import { layerSessions, Sessions } from '../sessions/sessions';
import { layerSettingsMain } from '../settings/window';

export const layerSessionsLive = layerSessions.pipe(
  Layer.provide(
    Layer.mergeAll(
      // The app's one AcpClient and AgentLifetime (memoized by reference, shared with MainRuntime).
      layerAgentLifetimeMain,
      layerSessionAgentLive,
      layerSessionStoreLive,
      layerProjectsLive,
      layerSettingsMain,
    ),
  ),
);

export const layerSessionsHandlers = SessionsRpcs.toLayer({
  'Session.list': ({ projectId }) => SessionStore.use((store) => store.list(projectId)),
  'Session.create': ({ projectId }) => Sessions.use((sessions) => sessions.create(projectId)),
  'Session.prompt': ({ sessionId, parts }) =>
    Sessions.use((sessions) => sessions.prompt(sessionId, parts)),
  'Session.cancel': ({ sessionId }) => Sessions.use((sessions) => sessions.cancel(sessionId)),
  'Session.retryAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.retryAgent(sessionId)),
  'Session.loginAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.loginAgent(sessionId)),
  'Session.openAgentLog': () =>
    SessionAgent.use((agent) =>
      Effect.promise(async () => {
        const failure = await shell.openPath(
          join(app.getPath('userData'), 'spence', 'logs', 'agents', `${agent.id}.log`),
        );
        if (failure !== '') console.warn(`Cannot open Agent log: ${failure}`);
      }),
    ),
  'Session.answerPermission': ({ sessionId, requestId, optionId }) =>
    Sessions.use((sessions) => sessions.answerPermission(sessionId, requestId, optionId)),
  'Session.setOption': (change) => Sessions.use((sessions) => sessions.setOption(change)),
  'Session.clearContext': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.clearContext(sessionId)),
  'Session.events': ({ sessionId, afterSeq }) =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.events(sessionId, afterSeq)))),
}).pipe(
  Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerSessionsLive, layerSessionAgentLive)),
);
