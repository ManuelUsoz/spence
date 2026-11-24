import { Effect, Layer, Stream } from 'effect';
import { SessionsRpcs } from '../../src/shared/sessions/sessions.rpc';
import { openAgentLog } from '../acp/acpAgentLog';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerAgentsMain } from './agents';
import { layerBrowserMain } from '../browser/browser-main';
import { layerProjectsLive } from '../projects/projects';
import { layerDeleteQueueLive } from '../sessions/delete-queue';
import { AgentCatalog, layerAgentCatalogLive } from '../sessions/session-agent';
import { layerSessionStoreLive } from '../sessions/session-store';
import { layerSessions, Sessions } from '../sessions/sessions';
import { layerSettingsMain } from '../settings/window';

export const layerSessionsLive = layerSessions.pipe(
  Layer.provide(
    Layer.mergeAll(
      // The app's one AcpClient and AgentLifetime (memoized by reference, shared with MainRuntime).
      layerAgentLifetimeMain,
      layerAgentsMain,
      layerDeleteQueueLive,
      layerAgentCatalogLive,
      layerSessionStoreLive,
      layerProjectsLive,
      layerSettingsMain,
      layerBrowserMain,
    ),
  ),
);

/** Unbound: needs `Sessions` and `AgentCatalog`, so a test Device can serve it over its own Store. */
export const layerSessionsHandlersWith = SessionsRpcs.toLayer({
  'Session.changes': () =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.changes))),
  'Session.list': ({ projectId }) => Sessions.use((sessions) => sessions.list(projectId)),
  'Session.create': ({ projectId, agentId }) =>
    Sessions.use((sessions) => sessions.create(projectId, agentId)),
  'Session.setAgent': ({ sessionId, agentId }) =>
    Sessions.use((sessions) => sessions.setAgent(sessionId, agentId)),
  'Session.prompt': ({ sessionId, parts, workflow, verificationOf }) =>
    Sessions.use((sessions) =>
      workflow !== undefined || verificationOf !== undefined
        ? sessions.runWorkflow(sessionId, parts, verificationOf, workflow)
        : sessions.prompt(sessionId, parts),
    ),
  'Session.steer': ({ sessionId, parts }) =>
    Sessions.use((sessions) => sessions.steer(sessionId, parts)),
  'Session.enqueue': ({ sessionId, parts }) =>
    Sessions.use((sessions) => sessions.enqueue(sessionId, parts)),
  'Session.setQueue': ({ sessionId, queue }) =>
    Sessions.use((sessions) => sessions.setQueue(sessionId, queue)),
  'Session.clearQueue': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.clearQueue(sessionId)),
  'Session.cancel': ({ sessionId }) => Sessions.use((sessions) => sessions.cancel(sessionId)),
  'Session.stopAgent': ({ sessionId, force }) =>
    Sessions.use((sessions) => sessions.stopAgent(sessionId, force)),
  'Session.rename': ({ sessionId, title }) =>
    Sessions.use((sessions) => sessions.rename(sessionId, title)),
  'Session.retryAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.retryAgent(sessionId)),
  'Session.loginAgent': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.loginAgent(sessionId)),
  'Session.openAgentLog': ({ sessionId }) =>
    sessionId === undefined
      ? AgentCatalog.use((catalog) => openAgentLog(catalog.fallbackId))
      : Sessions.use((sessions) => sessions.agentOf(sessionId)).pipe(
          Effect.flatMap(openAgentLog),
          Effect.catch(() => AgentCatalog.use((catalog) => openAgentLog(catalog.fallbackId))),
        ),
  'Session.answerPermission': ({ sessionId, requestId, optionId }) =>
    Sessions.use((sessions) => sessions.answerPermission(sessionId, requestId, optionId)),
  'Session.setOption': (change) => Sessions.use((sessions) => sessions.setOption(change)),
  'Session.clearContext': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.clearContext(sessionId)),
  'Session.compact': ({ sessionId }) => Sessions.use((sessions) => sessions.compact(sessionId)),
  'Session.startEmptyContext': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.startEmptyContext(sessionId)),
  'Session.archive': ({ sessionId }) => Sessions.use((sessions) => sessions.archive(sessionId)),
  'Session.unarchive': ({ sessionId }) => Sessions.use((sessions) => sessions.unarchive(sessionId)),
  'Session.countWorkers': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.countWorkers(sessionId)),
  'Session.delete': ({ sessionId }) => Sessions.use((sessions) => sessions.remove(sessionId)),
  'Session.events': ({ sessionId, afterSeq }) =>
    Stream.unwrap(Sessions.use((sessions) => Effect.succeed(sessions.events(sessionId, afterSeq)))),
  'Session.getComposer': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.getComposer(sessionId)),
  'Session.setComposer': ({ sessionId, draft }) =>
    Sessions.use((sessions) => sessions.setComposer(sessionId, draft)),
  'Session.prepareHandoff': (input) => Sessions.use((sessions) => sessions.prepareHandoff(input)),
  'Session.revalidateHandoff': (input) =>
    Sessions.use((sessions) => sessions.revalidateHandoff(input)),
  'Session.executeHandoff': (input) => Sessions.use((sessions) => sessions.executeHandoff(input)),
  'Session.listHandoffAttempts': ({ sessionId }) =>
    Sessions.use((sessions) => sessions.listHandoffAttempts(sessionId)),
});

export const layerSessionsHandlers = layerSessionsHandlersWith.pipe(
  Layer.provide(Layer.mergeAll(layerSessionStoreLive, layerSessionsLive, layerAgentCatalogLive)),
);
