import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AgentId } from '../../shared/agents/agents.rpc';
import {
  ProjectId,
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../shared/sessions/sessions.rpc';
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
  'Session.list': (payload) => Effect.succeed(payload.projectId === projectId ? [summary] : []),
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
