import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import { ProjectId, ProjectsRpcs } from '../../../shared/projects/projects.rpc';
import { SessionId, SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, type KeymapPlatform } from '../../core/keymap';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs, type Tab } from '../../core/tabs';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

@Component({
  selector: 'app-session-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="session-view-stub">{{ tab().id }}</div>`,
})
class SessionViewStub {
  readonly tab = input.required<Tab>();
}

@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

const p1 = ProjectId.make('p1');

const defaults: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: {},
};

const desktopLayer = () =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      AppInfoRpcs.toLayer({
        'AppInfo.get': () =>
          Effect.succeed({
            name: 'Spence',
            version: '0.1.0',
            electron: '0',
            chrome: '0',
            node: '0',
            platform: 'win32',
            cwd: '/work',
          }),
      }),
      SettingsRpcs.toLayer({
        'Settings.get': () => Effect.succeed(defaults),
        'Settings.update': () => Effect.succeed(defaults),
      }),
      AgentsRpcs.toLayer({
        'Agents.list': () => Effect.succeed([]),
        'Agents.installCommand': () => Effect.die('unused'),
        'Agents.install': () => Effect.die('unused'),
        'Agents.openInstallLog': () => Effect.die('unused'),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () =>
          Effect.succeed([
            {
              id: p1,
              name: 'app',
              path: '/work/app',
              addedAt: 1,
              lastUsedAt: 1,
              settings: {},
              folderMissing: false,
            },
          ]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ tabs: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.empty,
        'Session.list': () => Effect.succeed([]),
        'Session.create': () => Effect.die('unused'),
        'Session.prompt': () => Effect.die('unused'),
        'Session.cancel': () => Effect.die('unused'),
        'Session.answerPermission': () => Effect.die('unused'),
        'Session.setOption': () => Effect.die('unused'),
        'Session.clearContext': () => Effect.die('unused'),
        'Session.compact': () => Effect.die('unused'),
        'Session.events': () => Stream.empty,
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

const mountShell = async (
  platform: KeymapPlatform = 'other',
): Promise<{ readonly fixture: ComponentFixture<Shell>; readonly tabs: Tabs }> => {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DESKTOP_LAYER, useValue: desktopLayer() },
      { provide: KEYMAP_PLATFORM, useValue: platform },
      { provide: SESSION_VIEW, useValue: SessionViewStub },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  const fixture = TestBed.createComponent(Shell);
  const tabs = TestBed.inject(Tabs);
  fixture.detectChanges();
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(tabs.tabs()).toEqual([]);
  });
  return { fixture, tabs };
};

const dispatchKey = (init: KeyboardEventInit): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  document.dispatchEvent(event);
  return event;
};

beforeEach(() => {
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => ({
        matches: false,
        media: '',
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Shell keyboard shortcuts', () => {
  it('closes the active Tab with Mod+W and leaves the empty state on the last Tab', async () => {
    const { fixture, tabs } = await mountShell('other');
    const draft = tabs.startDraft(p1);
    const kept = tabs.open({ id: SessionId.make('s1'), projectId: p1, title: 'One' });
    fixture.detectChanges();

    expect(tabs.active()?.id).toBe(kept.id);

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.active()?.id).toBe(draft.id);
    expect(tabs.tabs()).toHaveLength(1);

    dispatchKey({ key: 'w', code: 'KeyW', ctrlKey: true });
    fixture.detectChanges();
    expect(tabs.active()).toBeNull();
    expect(tabs.tabs()).toEqual([]);
  });

  it('cycles Tabs with Ctrl+Tab / Ctrl+Shift+Tab even on macOS and jumps with Mod+1..8 / Mod+9', async () => {
    const { fixture, tabs } = await mountShell('mac');
    const opened = Array.from({ length: 10 }, (_, index) =>
      tabs.open({
        id: SessionId.make(`s${index + 1}`),
        projectId: p1,
        title: `Session ${index + 1}`,
      }),
    );
    tabs.activate(opened[0]!.id);
    fixture.detectChanges();

    // Ctrl+Tab uses Ctrl on macOS too.
    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true });
    expect(tabs.active()?.id).toBe(opened[1]?.id);

    dispatchKey({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true });
    expect(tabs.active()?.id).toBe(opened[0]?.id);

    // Mod+3 -> 3rd Tab (index 2).
    dispatchKey({ key: '3', code: 'Digit3', metaKey: true });
    expect(tabs.active()?.id).toBe(opened[2]?.id);

    // Mod+9 -> last Tab (10th Tab).
    dispatchKey({ key: '9', code: 'Digit9', metaKey: true });
    expect(tabs.active()?.id).toBe(opened[9]?.id);
  });

  it('opens Settings on Mod+, and leaves Mod+F free', async () => {
    const { fixture } = await mountShell('other');
    const settings = TestBed.inject(SettingsState);

    const findEvent = dispatchKey({ key: 'f', code: 'KeyF', ctrlKey: true });
    expect(findEvent.defaultPrevented).toBe(false);

    const settingsEvent = dispatchKey({ key: ',', code: 'Comma', ctrlKey: true });
    fixture.detectChanges();
    expect(settingsEvent.defaultPrevented).toBe(true);
    expect(settings.open()).toBe(true);
  });
});
