import { Effect, Layer, Stream } from 'effect';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { openAgentLog } from '../acp/acpAgentLog';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerProjectsLive } from '../projects/projects';
import { layerDeleteQueueLive } from '../sessions/delete-queue';
import { layerSessionAgentLive, SessionAgent } from '../sessions/session-agent';
import { layerSessionStoreLive } from '../sessions/session-store';
import { layerSessions, Sessions } from '../sessions/sessions';
import { layerSettingsMain } from '../settings/window';

export const layerSessionsLive = layerSessions.pipe(
  Layer.provide(
    Layer.mergeAll(
      // The app's one AcpClient and AgentLifetime (memoized by reference, shared with MainRuntime).
      layerAgentLifetimeMain,
      layerDeleteQueueLive,
      layerSessionAgentLive,
      layerSessionStoreLive,
      layerProjectsLive,
      layerSettingsMain,
    ),
  ),
);

export const layerSessionsHandlers = SessionsRpcs.toLayer({
  'Session.changes': () =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.changes))),
  'Session.list': ({ projectId }) => Sessions.use((sessions) => sessions.list(projectId)),
  'Session.create': ({ projectId }) => Sessions.use((sessions) => sessions.create(projectId)),
  'Session.prompt': ({ sessionId, parts }) =>
    Sessions.use((sessions) => sessions.prompt(sessionId, parts)),
  'Session.cancel': ({ sessionId }) => Sessions.use((sessions) => sessions.cancel(sessionId)),
  'Session.stopAgent': ({ sessionId, force }) =>
    Sessions.use((sessions) => sessions.stopAgent(sessionId, force)),
  'Session.rename': ({ sessionId, title }) =>
    Sessions.use((sessions) => sessions.rename(sessionId, title)),
  'Session.retryAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.retryAgent(sessionId)),
  'Session.loginAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.loginAgent(sessionId)),
  'Session.openAgentLog': () => SessionAgent.use((agent) => openAgentLog(agent.id)),
  'Session.answerPermission': ({ sessionId, requestId, optionId }) =>
    Sessions.use((sessions) => sessions.answerPermission(sessionId, requestId, optionId)),
  'Session.setOption': (change) => Sessions.use((sessions) => sessions.setOption(change)),
  'Session.clearContext': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.clearContext(sessionId)),
  'Session.archive': ({ sessionId }) => Sessions.use((sessions) => sessions.archive(sessionId)),
  'Session.unarchive': ({ sessionId }) => Sessions.use((sessions) => sessions.unarchive(sessionId)),
  'Session.delete': ({ sessionId }) => Sessions.use((sessions) => sessions.remove(sessionId)),
  'Session.events': ({ sessionId, afterSeq }) =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.events(sessionId, afterSeq)))),
  'Session.getComposer': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.getComposer(sessionId)),
  'Session.setComposer': ({ sessionId, draft }) =>
    Sessions.use((sessions) => sessions.setComposer(sessionId, draft)),
}).pipe(
  Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerSessionsLive, layerSessionAgentLive)),
);
