import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentsRpcs } from '../../../shared/agents/agents.rpc';
import { AppInfoRpcs } from '../../../shared/app-info/app-info.rpc';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserEvent,
  BrowserRpcs,
  PageId,
  type BrowserState,
} from '../../../shared/browser/browser.rpc';
import { ProjectId, ProjectsRpcs } from '../../../shared/projects/projects.rpc';
import { SessionId, SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { BROWSER_PANE_VIEW } from '../../core/browser-pane';
import { CHANGES_VIEW, ChangesState } from '../../core/changes-view';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, type KeymapPlatform } from '../../core/keymap';
import { SESSION_VIEW } from '../../core/session-view';
import { Tabs, type Tab } from '../../core/tabs';
import { ProjectSettingsState } from './project-settings-state';
import { SessionsState } from './sessions-state';
import { SettingsState } from './settings-state';
import { Shell } from './shell';

@Component({
  selector: 'app-session-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="session-view-stub">{{ tab().id }}</div>`,
})
class SessionViewStub {
  readonly tab = input.required<Tab>();
  readonly projectName = input('');
}

@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<unknown>();
}

@Component({
  selector: 'app-browser-pane-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="browser-pane-stub">{{ sessionId() }}</div>`,
})
class BrowserPaneStub {
  readonly sessionId = input.required<SessionId>();
}

@Component({
  selector: 'app-changes-view-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div data-testid="changes-view-stub">{{ sessionId() }}</div>`,
})
class ChangesViewStub {
  readonly sessionId = input.required<SessionId>();
  readonly running = input(false);
}

const p1 = ProjectId.make('p1');
const sLocal = SessionId.make('session-local');
const sLocalTwo = SessionId.make('session-local-two');
const sRemote = SessionId.make('session-remote');

interface BrowserTestSpy {
  readonly activeSessions: Array<SessionId | null>;
  readonly widths: Array<number>;
  readonly occludedCalls: Array<boolean>;
  readonly states: Map<SessionId, BrowserState>;
  pushEvent?: (event: BrowserEvent) => void;
}

const makeBrowserState = (
  sessionId: SessionId,
  overrides: Partial<BrowserState> = {},
): BrowserState => ({
  sessionId,
  open: false,
  width: BROWSER_DEFAULT_WIDTH,
  pages: [
    {
      id: PageId.make('p-1'),
      url: 'about:blank',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      suspended: false,
    },
  ],
  activePageId: PageId.make('p-1'),
  control: { _tag: 'idle' },
  pickerActive: false,
  occluded: false,
  ...overrides,
});

const defaults: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  agents: {},
};

const desktopLayer = (spy?: BrowserTestSpy) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      BrowserRpcs.toLayer({
        'Browser.getState': ({ sessionId }) =>
          Effect.succeed(spy?.states.get(sessionId) ?? makeBrowserState(sessionId)),
        'Browser.setOpen': ({ sessionId, open }) =>
          Effect.sync(() => {
            const next = makeBrowserState(sessionId, {
              ...(spy?.states.get(sessionId) ?? {}),
              open,
            });
            spy?.states.set(sessionId, next);
            return next;
          }),
        'Browser.setWidth': ({ sessionId, width }) =>
          Effect.sync(() => {
            spy?.widths.push(width);
            const next = makeBrowserState(sessionId, {
              ...(spy?.states.get(sessionId) ?? {}),
              width,
            });
            spy?.states.set(sessionId, next);
            return next;
          }),
        'Browser.setActiveSession': ({ sessionId }) =>
          Effect.sync(() => {
            spy?.activeSessions.push(sessionId);
          }),
        'Browser.setBounds': () => Effect.void,
        'Browser.setOccluded': ({ occluded }) =>
          Effect.sync(() => {
            spy?.occludedCalls.push(occluded);
          }),
        'Browser.navigate': () => Effect.die('unused'),
        'Browser.goBack': () => Effect.die('unused'),
        'Browser.goForward': () => Effect.die('unused'),
        'Browser.reload': () => Effect.die('unused'),
        'Browser.openExternal': () => Effect.die('unused'),
        'Browser.openDevTools': () => Effect.die('unused'),
        // #213: Multi-Page management
        'Browser.createPage': () => Effect.die('unused'),
        'Browser.selectPage': () => Effect.die('unused'),
        'Browser.closePage': () => Effect.die('unused'),
        // #215 Composer bridge
        'Browser.captureScreenshot': () => Effect.die('unused'),
        'Browser.startElementPicker': () => Effect.die('unused'),
        'Browser.cancelElementPicker': () => Effect.die('unused'),
        'Browser.getConsoleErrors': () => Effect.die('unused'),
        // #216: Persistence, LRU & browsing data
        'Browser.clearData': () => Effect.die('unused'),
        'Browser.takeOver': () => Effect.die('unused'),
        'Browser.continueAgent': () => Effect.die('unused'),
        'Browser.events': () =>
          spy === undefined
            ? Stream.empty
            : Stream.unwrap(
                Effect.gen(function* () {
                  const queue = yield* Queue.unbounded<BrowserEvent>();
                  spy.pushEvent = (event) => {
                    Queue.offerUnsafe(queue, event);
                  };
                  return Stream.fromQueue(queue);
                }),
              ),
      }),
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
        'Session.events': () => Stream.empty,
        'Session.getComposer': () => Effect.die('unused'),
        'Session.setComposer': () => Effect.die('unused'),
        'Session.rename': () => Effect.die('unused'),
        'Session.retryAgent': () => Effect.die('unused'),
        'Session.loginAgent': () => Effect.die('unused'),
        'Session.openAgentLog': () => Effect.die('unused'),
        'Session.archive': () => Effect.die('unused'),
        'Session.unarchive': () => Effect.die('unused'),
        'Session.countWorkers': () => Effect.succeed(0),
        'Session.delete': () => Effect.void,
      }),
    ),
  );

const mountShell = async (
  platform: KeymapPlatform = 'other',
  spy?: BrowserTestSpy,
): Promise<{ readonly fixture: ComponentFixture<Shell>; readonly tabs: Tabs }> => {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: DESKTOP_LAYER, useValue: desktopLayer(spy) },
      { provide: KEYMAP_PLATFORM, useValue: platform },
      { provide: SESSION_VIEW, useValue: SessionViewStub },
      { provide: CHANGES_VIEW, useValue: ChangesViewStub },
      { provide: BROWSER_PANE_VIEW, useValue: BrowserPaneStub },
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

describe('Shell Browser split pane & TopBar toggle', () => {
  it('toggles Browser split pane for local Sessions, hides during Settings/Changes, and disables for remote Sessions', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', spy);
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="toggle-browser"]');
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggle()).not.toBeNull();
      expect(toggle()?.disabled).toBe(false);
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    toggle()?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
    });

    // Opening Settings hides the split pane and clears active Browser session without losing open state.
    const settings = TestBed.inject(SettingsState);
    settings.show();
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });

    settings.set(false);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    // Opening Changes also hides the split pane and clears active Browser session.
    const changes = TestBed.inject(ChangesState);
    changes.show();
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });

    changes.set(false);
    fixture.detectChanges();

    // Remote Sessions disable the TopBar Browser toggle and clear active Browser session.
    tabs.open({ id: sRemote, projectId: p1, title: 'Remote Session', deviceId: 'peer-1' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(toggle()?.disabled).toBe(true);
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });
  });

  it('clamps pointer drag resize width to 320..960 px and commits on pointerup', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', spy);
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="toggle-browser"]')).not.toBeNull();
    });

    (root.querySelector('[data-testid="toggle-browser"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-resize-handle"]')).not.toBeNull();
    });

    const handle = root.querySelector('[data-testid="browser-resize-handle"]') as HTMLElement;
    const container = root.querySelector('[data-testid="browser-pane-container"]') as HTMLElement;
    const split = root.querySelector('[data-testid="shell-split"]') as HTMLElement;
    Object.defineProperty(split, 'clientWidth', { configurable: true, value: 1400 });

    handle.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 700 }));
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 500 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('680px');

    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 0 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('960px');

    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1200 }));
    fixture.detectChanges();
    expect(container.style.width).toBe('320px');

    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 1200 }));
    await vi.waitFor(() => {
      expect(spy.widths).toEqual([320]);
    });
  });

  it('switches Browser visibility, active session, width, and pane input cleanly across two local Sessions', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    spy.states.set(
      sLocal,
      makeBrowserState(sLocal, {
        open: true,
        width: 440,
      }),
    );
    spy.states.set(
      sLocalTwo,
      makeBrowserState(sLocalTwo, {
        open: false,
        width: 620,
      }),
    );

    const { fixture, tabs } = await mountShell('other', spy);
    const root = fixture.nativeElement as HTMLElement;
    const toggle = () => root.querySelector<HTMLButtonElement>('[data-testid="toggle-browser"]');

    tabs.open({ id: sLocal, projectId: p1, title: 'First Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('440px');
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });

    // Switch to second Session whose Browser is closed -> hides split pane while preserving sLocal open state.
    tabs.open({ id: sLocalTwo, projectId: p1, title: 'Second Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
      expect(toggle()?.getAttribute('aria-pressed')).toBe('false');
      expect(spy.activeSessions.at(-1)).toBe(sLocalTwo);
    });
    expect(spy.states.get(sLocal)?.open).toBe(true);

    // Open Browser in second Session -> shows sLocalTwo with its own width.
    toggle()?.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocalTwo,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('620px');
    });

    // Switch back to first Session -> restores sLocal in BrowserPane with its own width.
    tabs.open({ id: sLocal, projectId: p1, title: 'First Local' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
      expect(
        root.querySelector<HTMLElement>('[data-testid="browser-pane-container"]')?.style.width,
      ).toBe('440px');
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });
    expect(spy.states.get(sLocalTwo)?.open).toBe(true);
  });

  it('signals occlusion across project settings sheet, confirm dialog, menus, and hides on empty state while ignoring sidebar tooltips', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', spy);
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="toggle-browser"]')).not.toBeNull();
    });
    (root.querySelector('[data-testid="toggle-browser"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
    });

    // Left-sidebar tooltip does not occlude Browser.
    const newSessionBtn = root.querySelector<HTMLElement>('[data-testid="new-session"]')!;
    newSessionBtn.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    });
    expect(spy.occludedCalls).not.toContain(true);
    newSessionBtn.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    // Project settings sheet occludes on open and restores on close.
    const projectSettings = TestBed.inject(ProjectSettingsState);
    projectSettings.show({
      id: p1,
      name: 'app',
      path: '/work/app',
      addedAt: 1,
      lastUsedAt: 1,
      settings: {},
      folderMissing: false,
    });
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(true));
    projectSettings.close();
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(false));

    // Delete confirm alert-dialog occludes on open and restores on dismiss.
    const sessionsState = TestBed.inject(SessionsState);
    await sessionsState.delete([{ id: sLocal, title: 'Local Session' }]);
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(true));
    sessionsState.dismissConfirm();
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(false));

    // TopBar session actions dropdown menu occludes on open and restores on close.
    root.querySelector<HTMLButtonElement>('[data-testid="session-actions-trigger"]')!.click();
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(true));
    const actionsMenu = document.querySelector<HTMLElement>('[data-testid="session-actions-menu"]');
    expect(actionsMenu).not.toBeNull();
    actionsMenu?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }),
    );
    fixture.detectChanges();
    await vi.waitFor(() => expect(spy.occludedCalls.at(-1)).toBe(false));

    // Closing the last Tab switches to empty state and clears active Browser session; reopening restores it.
    tabs.closeSession(sLocal);
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
      expect(spy.activeSessions.at(-1)).toBeNull();
    });

    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(spy.activeSessions.at(-1)).toBe(sLocal);
    });
  });

  it('auto-opens split pane when viewed Session receives Agent Browser event without stealing Tab on background Session events', async () => {
    const spy: BrowserTestSpy = {
      activeSessions: [],
      widths: [],
      occludedCalls: [],
      states: new Map(),
    };
    const { fixture, tabs } = await mountShell('other', spy);
    const root = fixture.nativeElement as HTMLElement;

    tabs.open({ id: sLocalTwo, projectId: p1, title: 'Background Session' });
    tabs.open({ id: sLocal, projectId: p1, title: 'Local Session' });
    fixture.detectChanges();

    await vi.waitFor(() => expect(spy.pushEvent).toBeDefined());
    expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();

    // Background Session Browser event never switches active Tab or opens sLocal's split pane.
    spy.pushEvent?.({
      _tag: 'State',
      state: makeBrowserState(sLocalTwo, {
        open: false,
        control: { _tag: 'agentActive', action: 'navigate' },
      }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(tabs.active()?.session).toBe(sLocal);
      expect(root.querySelector('[data-testid="shell-split"]')).toBeNull();
    });

    // Viewed Session sLocal auto-opens split pane on Browser.events State with open: true.
    spy.pushEvent?.({
      _tag: 'State',
      state: makeBrowserState(sLocal, {
        open: true,
        control: { _tag: 'agentActive', action: 'navigate' },
      }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(root.querySelector('[data-testid="shell-split"]')).not.toBeNull();
      expect(root.querySelector('[data-testid="browser-pane-stub"]')?.textContent).toContain(
        sLocal,
      );
    });
  });
});
