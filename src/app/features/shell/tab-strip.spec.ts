import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ProjectId, ProjectsRpcs } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { TabStrip } from './tab-strip';

const app = ProjectId.make('app');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');
const s3 = SessionId.make('s3');

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

const live = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  title: { auto: 'Session', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

describe('TabStrip', () => {
  it('renders static ActivityMark icons on Tabs for attention and running', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    TestBed.configureTestingModule({
      providers: [
        {
          provide: DESKTOP_LAYER,
          useValue: makeDesktopTestLayer(
            Layer.mergeAll(
              ProjectsRpcs.toLayer({
                'Projects.list': () => Effect.succeed([]),
                'Projects.add': () => Effect.die('unused'),
                'Projects.rename': () => Effect.die('unused'),
                'Projects.remove': () => Effect.die('unused'),
                'Projects.locate': () => Effect.die('unused'),
                'Projects.check': () => Effect.die('unused'),
                'Projects.setSettings': () => Effect.die('unused'),
              }),
              SettingsRpcs.toLayer({
                'Settings.get': () => Effect.succeed(settings),
                'Settings.update': () => Effect.die('unused'),
              }),
              TabsRpcs.toLayer({
                'Tabs.restore': () => Effect.succeed({ tabs: [] }),
                'Tabs.update': () => Effect.void,
                'Tabs.activations': () => Stream.empty,
              }),
              SessionsRpcs.toLayer({
                'Session.changes': () => Stream.fromQueue(changes),
                'Session.list': () => Effect.die('unused'),
                'Session.create': () => Effect.die('unused'),
                'Session.setAgent': () => Effect.die('unused'),
                'Session.prompt': () => Effect.die('unused'),
                'Session.cancel': () => Effect.die('unused'),
                'Session.stopAgent': () => Effect.die('unused'),
                'Session.rename': () => Effect.die('unused'),
                'Session.retryAgent': () => Effect.die('unused'),
                'Session.loginAgent': () => Effect.die('unused'),
                'Session.openAgentLog': () => Effect.die('unused'),
                'Session.answerPermission': () => Effect.die('unused'),
                'Session.setOption': () => Effect.die('unused'),
                'Session.clearContext': () => Effect.die('unused'),
                'Session.startEmptyContext': () => Effect.die('unused'),
                'Session.archive': () => Effect.die('unused'),
                'Session.unarchive': () => Effect.die('unused'),
                'Session.delete': () => Effect.die('unused'),
                'Session.events': () => Stream.die('unused'),
                'Session.getComposer': () => Effect.die('unused'),
                'Session.setComposer': () => Effect.die('unused'),
              }),
            ),
          ),
        },
      ],
    });
    const fixture = TestBed.createComponent(TabStrip);
    const tabs = TestBed.inject(Tabs);
    tabs.open({ id: s1, projectId: app, title: 'Needs answer' });
    tabs.open({ id: s2, projectId: app, title: 'Errored' });
    tabs.open({ id: s3, projectId: app, title: 'Working' });
    fixture.detectChanges();

    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: app,
      state: live({ attention: 'needsAnswer', runningTurn: TurnId.make('t1') }),
    });
    Queue.offerUnsafe(changes, {
      sessionId: s2,
      projectId: app,
      state: live({ attention: 'error' }),
    });
    Queue.offerUnsafe(changes, {
      sessionId: s3,
      projectId: app,
      state: live({ runningTurn: TurnId.make('t2') }),
    });

    await vi.waitFor(() => {
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelectorAll('[data-testid="tab-attention"]')).toHaveLength(2);
      expect(el.querySelectorAll('[data-testid="tab-running"]')).toHaveLength(1);
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('[data-testid="attention-needsAnswer"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="attention-error"]')).toHaveLength(1);
    expect(el.querySelectorAll('[data-testid="session-running"]')).toHaveLength(1);
  });
});
