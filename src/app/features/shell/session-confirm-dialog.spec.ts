import { TestBed } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectId, ProjectsRpcs } from '../../../shared/projects/projects.rpc';
import { SessionId, SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../core/keymap';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SessionsState } from './sessions-state';

const app = ProjectId.make('app');
const s1 = SessionId.make('s1');

const desktopLayer = () =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ tabs: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.die('unused'),
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
        'Session.delete': () => Effect.die('unused'),
      }),
    ),
  );

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SessionConfirmDialog', () => {
  it('locks global shortcuts while open, dismisses on Escape, and restores focus to the opener', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: desktopLayer() },
        { provide: KEYMAP_PLATFORM, useValue: 'other' },
      ],
    });
    const opener = document.createElement('button');
    opener.textContent = 'Delete';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const fixture = TestBed.createComponent(SessionConfirmDialog);
    const state = TestBed.inject(SessionsState);
    const keymap = TestBed.inject(Keymap);
    const onGlobal = vi.fn();
    keymap.register({ binding: { mod: true, key: 'w' }, run: onGlobal });

    // Trigger delete confirmation on a session (Session.events fails -> runningCount 0, still confirms delete).
    await state.delete([{ id: s1, title: `Fix ${app}` }]);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.querySelector('[data-testid="session-confirm-dialog"]')).not.toBeNull();
    });

    expect(keymap.modalOpen()).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true }),
    );
    expect(onGlobal).not.toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(state.confirm()).toBeNull();
    expect(keymap.modalOpen()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
