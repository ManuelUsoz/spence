import { describe, expect, it } from '@effect/vitest';
import { Effect, Stream } from 'effect';
import { AgentId } from '../../shared/agents/agents.rpc';
import { SessionId, SessionsRpcs, type SessionSummary } from '../../shared/sessions/sessions.rpc';
import { ProjectId } from '../../shared/projects/projects.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const projectId = ProjectId.make('project-1');

const summary: SessionSummary = {
  id: SessionId.make('session-1'),
  agentId: AgentId.make('claude'),
  title: { auto: 'Fix the build', autoIsPlaceholder: false },
  lastActivityAt: 20,
  archivedAt: 30,
};

const handlers = SessionsRpcs.toLayer({
  'Session.changes': () => Stream.empty,
  'Session.list': (payload) => Effect.succeed(payload.projectId === projectId ? [summary] : []),
  'Session.create': () => Effect.die('not served in this spec'),
  'Session.setAgent': () => Effect.die('not served in this spec'),
  'Session.prompt': () => Effect.die('not served in this spec'),
  'Session.rename': () => Effect.void,
  'Session.openAgentLog': () => Effect.void,
  'Session.retryAgent': () => Effect.void,
  'Session.loginAgent': () => Effect.void,
  'Session.cancel': () => Effect.die('not served in this spec'),
  'Session.stopAgent': () => Effect.die('not served in this spec'),
  'Session.setOption': () => Effect.die('not served in this spec'),
  'Session.clearContext': () => Effect.die('not served in this spec'),
  'Session.startEmptyContext': () => Effect.die('not served in this spec'),
  'Session.archive': () => Effect.die('not served in this spec'),
  'Session.unarchive': () => Effect.die('not served in this spec'),
  'Session.delete': () => Effect.die('not served in this spec'),
  'Session.answerPermission': () => Effect.die('not served in this spec'),
  'Session.events': () => Stream.die('not served in this spec'),
  'Session.getComposer': () => Effect.die('not served in this spec'),
  'Session.setComposer': () => Effect.die('not served in this spec'),
});

describe('DesktopApi Sessions', () => {
  it.effect(
    'serves Session.list through the real contract with only the Sessions handlers given',
    () =>
      Effect.gen(function* () {
        const api = yield* DesktopApi;
        expect(yield* api['Session.list']({ projectId })).toEqual([summary]);
      }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
