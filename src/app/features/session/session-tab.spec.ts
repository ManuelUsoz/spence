import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Deferred, Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import { SessionId, SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import type { Tab } from '../../core/tabs';
import { SessionTab } from './session-tab';

const projectId = ProjectId.make('p1');
const created = SessionId.make('created-1');

const draft: Tab = { id: 'draft:1', projectId, session: null, title: null };
const kept: Tab = {
  id: 'session:kept-1',
  projectId,
  session: SessionId.make('kept-1'),
  title: 'Earlier work',
};

const mount = (tab: Tab, creating: Effect.Effect<SessionId>): ComponentFixture<SessionTab> => {
  const handlers = makeDesktopTestLayer(
    Layer.mergeAll(
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.succeed([]),
        'Session.create': () => creating,
        'Session.setAgent': () => Effect.die('not served'),
        'Session.prompt': () => Effect.die('not served'),
        'Session.answerPermission': () => Effect.die('not served'),
        'Session.rename': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.cancel': () => Effect.die('not served'),
        'Session.stopAgent': () => Effect.die('not served'),
        'Session.setOption': () => Effect.die('not served'),
        'Session.clearContext': () => Effect.die('not served'),
        'Session.archive': () => Effect.die('not served'),
        'Session.unarchive': () => Effect.die('not served'),
        'Session.delete': () => Effect.die('not served'),
        'Session.events': () => Stream.never,
        'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
        'Session.setComposer': () => Effect.void,
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ tabs: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
    ),
  );
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: handlers }],
  });
  const fixture = TestBed.createComponent(SessionTab);
  fixture.componentRef.setInput('tab', tab);
  fixture.detectChanges();
  return fixture;
};

const find = (fixture: ComponentFixture<SessionTab>, selector: string): Element | null => {
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector(selector);
};

describe('SessionTab', () => {
  it('shows that a draft Session is starting, then its Session view', async () => {
    const answer = Deferred.makeUnsafe<SessionId>();
    const fixture = mount(draft, Deferred.await(answer));
    await vi.waitFor(() =>
      expect(find(fixture, '[data-testid="session-starting"]')).not.toBeNull(),
    );
    expect(find(fixture, 'app-session-view')).toBeNull();

    Deferred.doneUnsafe(answer, Effect.succeed(created));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
  });

  it('shows a kept Session from an earlier run in its Session view', async () => {
    const fixture = mount(kept, Effect.die('not created'));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
  });

  it('keeps the mounted Session view alive when a draft Tab is promoted to kept', async () => {
    const fixture = mount(draft, Effect.succeed(created));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    const viewEl = find(fixture, 'app-session-view');

    fixture.componentRef.setInput('tab', {
      ...draft,
      session: created,
    });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
    expect(find(fixture, 'app-session-view')).toBe(viewEl);
  });

  it('unmounts the previous Session view immediately when switching to a new draft Tab', async () => {
    const nextCreated = Deferred.makeUnsafe<SessionId>();
    const fixture = mount(kept, Deferred.await(nextCreated));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());

    fixture.componentRef.setInput('tab', { id: 'draft:2', projectId, session: null, title: null });
    expect(find(fixture, 'app-session-view')).toBeNull();
    expect(find(fixture, '[data-testid="session-starting"]')).not.toBeNull();

    Deferred.doneUnsafe(nextCreated, Effect.succeed(SessionId.make('created-2')));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
  });
});
