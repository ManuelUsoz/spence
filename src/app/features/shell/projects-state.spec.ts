import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { ProjectsState } from './projects-state';

const project = (id: string, name: string): Project => ({
  id: ProjectId.make(id),
  name,
  path: `/work/${id}`,
  addedAt: 1,
  lastUsedAt: 1,
  settings: {},
  folderMissing: false,
});

const app = project('app', 'app');
const api = project('api', 'api');

const settings: Settings = {
  language: 'en',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  agents: {},
};

const session = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id: SessionId.make(id),
  agentId: AgentId.make('claude'),
  title: { auto: id, autoIsPlaceholder: false },
  lastActivityAt: 1,
  ...overrides,
});

describe('ProjectsState.remove', () => {
  const setup = (sessionsByProject: ReadonlyMap<ProjectId, ReadonlyArray<SessionSummary>>) => {
    const removed: ProjectId[] = [];
    const layer = makeDesktopTestLayer(
      Layer.mergeAll(
        ProjectsRpcs.toLayer({
          'Projects.list': () => Effect.succeed([app, api]),
          'Projects.add': () => Effect.succeed(null),
          'Projects.rename': () => Effect.die('unused'),
          'Projects.remove': ({ id }) =>
            Effect.sync(() => {
              removed.push(id);
            }),
          'Projects.locate': () => Effect.die('unused'),
          'Projects.check': () => Effect.die('unused'),
          'Projects.setSettings': () => Effect.die('unused'),
        }),
        SessionsRpcs.toLayer({
          'Session.list': ({ projectId }) => Effect.succeed(sessionsByProject.get(projectId) ?? []),
          'Session.changes': () => Stream.die('unused'),
          'Session.create': () => Effect.die('unused'),
          'Session.setAgent': () => Effect.die('unused'),
          'Session.prompt': () => Effect.die('unused'),
          'Session.steer': () => Effect.die('unused'),
          'Session.enqueue': () => Effect.die('unused'),
          'Session.setQueue': () => Effect.die('unused'),
          'Session.clearQueue': () => Effect.die('unused'),
          'Session.cancel': () => Effect.die('unused'),
          'Session.stopAgent': () => Effect.die('unused'),
          'Session.setOption': () => Effect.die('unused'),
          'Session.clearContext': () => Effect.die('unused'),
          'Session.compact': () => Effect.die('unused'),
          'Session.startEmptyContext': () => Effect.die('unused'),
          'Session.prepareHandoff': () => Effect.die('unused'),
          'Session.revalidateHandoff': () => Effect.die('unused'),
          'Session.executeHandoff': () => Effect.die('unused'),
          'Session.listHandoffAttempts': () => Effect.die('unused'),
          'Session.answerPermission': () => Effect.die('unused'),
          'Session.events': () => Stream.die('unused'),
          'Session.getComposer': () => Effect.die('unused'),
          'Session.setComposer': () => Effect.die('unused'),
          'Session.rename': () => Effect.die('unused'),
          'Session.retryAgent': () => Effect.die('unused'),
          'Session.loginAgent': () => Effect.die('unused'),
          'Session.openAgentLog': () => Effect.die('unused'),
          'Session.archive': () => Effect.die('unused'),
          'Session.unarchive': () => Effect.die('unused'),
          'Session.delete': () => Effect.die('unused'),
        }),
        SettingsRpcs.toLayer({
          'Settings.get': () => Effect.succeed(settings),
          'Settings.update': () => Effect.die('unused'),
        }),
      ),
    );
    TestBed.configureTestingModule({
      providers: [ProjectsState, { provide: DESKTOP_LAYER, useValue: layer }],
    });
    return { state: TestBed.inject(ProjectsState), removed };
  };

  it('removes a Project without confirmation when no Turn is running', async () => {
    const { state, removed } = setup(
      new Map([
        [app.id, [session('s1')]],
        [api.id, []],
      ]),
    );
    await vi.waitFor(() => expect(state.ordered()).toHaveLength(2));

    const confirm = vi.fn(() => true);
    const ok = await state.remove(app.id, confirm);

    expect(ok).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    expect(removed).toEqual([app.id]);
    expect(state.ordered().map((p) => p.id)).toEqual([api.id]);
  });

  it('asks for confirmation only when a Turn is running and aborts on cancel', async () => {
    const { state, removed } = setup(
      new Map([
        [app.id, [session('s1', { running: true })]],
        [api.id, []],
      ]),
    );
    await vi.waitFor(() => expect(state.ordered()).toHaveLength(2));

    const decline = vi.fn(() => false);
    expect(await state.remove(app.id, decline)).toBe(false);
    expect(decline).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([]);
    expect(state.ordered()).toHaveLength(2);

    const accept = vi.fn(async () => true);
    expect(await state.remove(app.id, accept)).toBe(true);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(removed).toEqual([app.id]);
    expect(state.ordered().map((p) => p.id)).toEqual([api.id]);
  });
});
