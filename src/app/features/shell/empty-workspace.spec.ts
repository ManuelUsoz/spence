import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Cause, Deferred, Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { EmptyWorkspace } from './empty-workspace';

const project: Project = {
  id: ProjectId.make('app'),
  name: 'app',
  path: '/work/app',
  addedAt: 1,
  lastUsedAt: 100,
  settings: {},
  folderMissing: false,
};

const session = (
  id: string,
  title: string,
  lastActivityAt: number,
  archivedAt?: number,
): SessionSummary => ({
  id: SessionId.make(id),
  agentId: AgentId.make('claude'),
  title: { auto: title, autoIsPlaceholder: false },
  lastActivityAt,
  ...(archivedAt === undefined ? {} : { archivedAt }),
});

const mount = async (
  sessionsOrEffect: ReadonlyArray<SessionSummary> | Effect.Effect<ReadonlyArray<SessionSummary>>,
) => {
  const listEffect = Array.isArray(sessionsOrEffect)
    ? Effect.succeed(sessionsOrEffect)
    : (sessionsOrEffect as Effect.Effect<ReadonlyArray<SessionSummary>>);
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => listEffect,
        'Session.create': () => Effect.die('unused'),
        'Session.setAgent': () => Effect.die('unused'),
        'Session.prompt': () => Effect.die('unused'),
        'Session.steer': () => Effect.die('unused'),
        'Session.enqueue': () => Effect.die('unused'),
        'Session.setQueue': () => Effect.die('unused'),
        'Session.clearQueue': () => Effect.die('unused'),
        'Session.cancel': () => Effect.die('unused'),
        'Session.stopAgent': () => Effect.die('unused'),
        'Session.answerPermission': () => Effect.die('unused'),
        'Session.setOption': () => Effect.die('unused'),
        'Session.clearContext': () => Effect.die('unused'),
        'Session.compact': () => Effect.die('unused'),
        'Session.startEmptyContext': () => Effect.die('unused'),
        'Session.prepareHandoff': () => Effect.die('unused'),
        'Session.revalidateHandoff': () => Effect.die('unused'),
        'Session.executeHandoff': () => Effect.die('unused'),
        'Session.listHandoffAttempts': () => Effect.die('unused'),
        'Session.events': () => Stream.die('unused'),
        'Session.getComposer': () => Effect.die('unused'),
        'Session.setComposer': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.die('unused'),
        'Session.loginAgent': () => Effect.die('unused'),
        'Session.openAgentLog': () => Effect.die('unused'),
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.die('unused'),
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(EmptyWorkspace);
  fixture.componentRef.setInput('project', project);
  const tabs = TestBed.inject(Tabs);
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  fixture.detectChanges();
  return { fixture, tabs };
};

const all = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>(
      `[data-testid="${testId}"]`,
    ),
  ];
};

const one = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement => {
  const el = all(fixture, testId)[0];
  if (el === undefined) throw new Error(`no ${testId}`);
  return el;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('EmptyWorkspace', () => {
  it('renders a quiet display heading and opens a new draft Tab from the New Tab action', async () => {
    const { fixture, tabs } = await mount([]);
    const heading = one(fixture, 'empty-workspace-heading');
    expect(heading.className).toContain('font-display');
    expect(heading.className).toContain('text-xl');
    expect(heading.textContent).toContain('app');

    one(fixture, 'empty-new-tab').click();
    expect(tabs.tabs()).toHaveLength(1);
    expect(tabs.active()?.projectId).toBe(project.id);
    expect(tabs.active()?.session).toBeNull();
  });

  it('lists recent unarchived Sessions in the Project and opens the clicked Session in a Tab', async () => {
    const { fixture, tabs } = await mount([
      session('s-old', 'Older task', 10),
      session('s-archived', 'Archived task', 999, 1000),
      session('s-new', 'Latest task', 200),
    ]);

    await vi.waitFor(() => expect(all(fixture, 'empty-recent-session')).toHaveLength(2));
    expect(all(fixture, 'empty-recent-session')[0]?.getAttribute('data-slot')).toBe('button');
    expect(all(fixture, 'empty-recent-session').map((el) => el.textContent)).toEqual([
      expect.stringContaining('Latest task'),
      expect.stringContaining('Older task'),
    ]);

    all(fixture, 'empty-recent-session')[0]?.click();
    expect(tabs.active()?.session).toBe(SessionId.make('s-new'));
  });

  it('uses Spartan hlmBtn on action buttons and shows distinct loading and failure states for Session.list', async () => {
    const deferred = Effect.runSync(Deferred.make<ReadonlyArray<SessionSummary>>());
    const { fixture } = await mount(Deferred.await(deferred));

    expect(one(fixture, 'empty-new-tab').getAttribute('data-slot')).toBe('button');
    expect(all(fixture, 'empty-workspace-sessions-loading')).toHaveLength(1);
    expect(all(fixture, 'empty-workspace-sessions-error')).toHaveLength(0);

    Effect.runSync(Deferred.failCause(deferred, Cause.die('disk read failed')));

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(all(fixture, 'empty-workspace-sessions-error')).toHaveLength(1);
    });
    expect(all(fixture, 'empty-workspace-sessions-loading')).toHaveLength(0);
    expect(all(fixture, 'empty-recent-session')).toHaveLength(0);
  });
});
