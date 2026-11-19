import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Deferred, Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import { SessionId, SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { PanelId, TabsRpcs, type WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { SessionTab } from './session-tab';

const projectId = ProjectId.make('p1');
const created = SessionId.make('created-1');

const draft: WorkspacePanel = {
  id: PanelId.make('panel-draft-1'),
  spec: { _tag: 'Session', draft: true },
  collapsed: false,
  heightShare: 1,
};

const kept: WorkspacePanel = {
  id: PanelId.make('panel-kept-1'),
  spec: { _tag: 'Session', sessionId: SessionId.make('kept-1') },
  collapsed: false,
  heightShare: 1,
};

const mount = (
  panel: WorkspacePanel,
  creating: Effect.Effect<SessionId>,
  focused = true,
): ComponentFixture<SessionTab> => {
  const handlers = makeDesktopTestLayer(
    Layer.mergeAll(
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.succeed([]),
        'Session.create': () => creating,
        'Session.setAgent': () => Effect.die('not served'),
        'Session.prompt': () => Effect.die('not served'),
        'Session.steer': () => Effect.die('unused'),
        'Session.enqueue': () => Effect.die('unused'),
        'Session.setQueue': () => Effect.die('unused'),
        'Session.clearQueue': () => Effect.die('unused'),
        'Session.answerPermission': () => Effect.die('not served'),
        'Session.rename': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.cancel': () => Effect.die('not served'),
        'Session.stopAgent': () => Effect.die('not served'),
        'Session.setOption': () => Effect.die('not served'),
        'Session.clearContext': () => Effect.die('not served'),
        'Session.compact': () => Effect.die('not served'),
        'Session.startEmptyContext': () => Effect.die('not served'),
        'Session.prepareHandoff': () => Effect.die('not served'),
        'Session.revalidateHandoff': () => Effect.die('not served'),
        'Session.executeHandoff': () => Effect.die('not served'),
        'Session.listHandoffAttempts': () => Effect.die('not served'),
        'Session.archive': () => Effect.die('not served'),
        'Session.unarchive': () => Effect.die('not served'),
        'Session.countWorkers': () => Effect.die('not served'),
        'Session.delete': () => Effect.die('not served'),
        'Session.events': () => Stream.never,
        'Session.getComposer': () => Effect.succeed({ text: '', images: [] }),
        'Session.setComposer': () => Effect.void,
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
    ),
  );
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: handlers },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(SessionTab);
  fixture.componentRef.setInput('panel', panel);
  fixture.componentRef.setInput('projectId', projectId);
  fixture.componentRef.setInput('focused', focused);
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

  it('keeps the mounted Session view alive when a draft Panel is attached and promoted to kept', async () => {
    const fixture = mount(draft, Effect.succeed(created));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    const viewEl = find(fixture, 'app-session-view');

    fixture.componentRef.setInput('panel', {
      ...draft,
      spec: { _tag: 'Session', sessionId: created, draft: true },
    });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    expect(find(fixture, 'app-session-view')).toBe(viewEl);

    fixture.componentRef.setInput('panel', {
      ...draft,
      spec: { _tag: 'Session', sessionId: created },
    });
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
    expect(find(fixture, 'app-session-view')).toBe(viewEl);
  });

  it('keys draft Session creation by PanelId even across Panels in the same Tab', async () => {
    let createdCount = 0;
    const fixture = mount(
      draft,
      Effect.sync(() => {
        createdCount += 1;
        return SessionId.make(`created-${createdCount}`);
      }),
    );
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(createdCount).toBe(1);

    fixture.componentRef.setInput('panel', {
      ...draft,
      id: PanelId.make('panel-draft-2'),
    });
    await vi.waitFor(() => expect(createdCount).toBe(2));

    // Switching back to the first PanelId reuses its cached draft Session without re-creating.
    fixture.componentRef.setInput('panel', draft);
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(createdCount).toBe(2);
  });

  it('unmounts the previous Session view immediately when switching to a new draft Panel', async () => {
    const nextCreated = Deferred.makeUnsafe<SessionId>();
    const fixture = mount(kept, Deferred.await(nextCreated));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());

    fixture.componentRef.setInput('panel', {
      id: PanelId.make('panel-draft-2'),
      spec: { _tag: 'Session', draft: true },
      collapsed: false,
      heightShare: 1,
    });
    expect(find(fixture, 'app-session-view')).toBeNull();
    expect(find(fixture, '[data-testid="session-starting"]')).not.toBeNull();

    Deferred.doneUnsafe(nextCreated, Effect.succeed(SessionId.make('created-2')));
    await vi.waitFor(() => expect(find(fixture, 'app-session-view')).not.toBeNull());
    expect(find(fixture, '[data-testid="session-starting"]')).toBeNull();
  });

  it('forwards focused state to SessionView so unfocused Panels ignore mount focus and Mod+L', async () => {
    const fixture = mount(kept, Effect.die('not created'), false);
    await vi.waitFor(() => expect(find(fixture, '[data-testid="composer-input"]')).not.toBeNull());
    const composer = find(fixture, '[data-testid="composer-input"]') as HTMLTextAreaElement;

    expect(document.activeElement).not.toBe(composer);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).not.toBe(composer);

    fixture.componentRef.setInput('focused', true);
    fixture.detectChanges();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(composer);
  });
});
