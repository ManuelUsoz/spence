import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
} from '../../../shared/sessions/sessions.rpc';
import {
  PaneId,
  PanelId,
  TabId,
  TabsRpcs,
  type RestoredWorkspace,
  type WorkspaceState,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { Tabs } from '../../core/tabs';
import { HlmSidebarImports } from '@ui/sidebar';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TabStrip } from './tab-strip';

@Component({
  selector: 'app-tab-strip-host',
  imports: [HlmSidebarImports, TabStrip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div hlmSidebarWrapper>
      <app-tab-strip />
    </div>
  `,
})
class TabStripHost {}

const p1 = ProjectId.make('p1');
const p2 = ProjectId.make('p2');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');
const s3 = SessionId.make('s3');

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  title: { auto: 'Fix login', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

const mount = async (options?: {
  readonly changes?: Stream.Stream<SessionChange>;
  readonly updates?: WorkspaceState[];
  readonly restored?: RestoredWorkspace;
}) => {
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () =>
          Effect.succeed(options?.restored ?? { workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': ({ workspace }) =>
          Effect.sync(() => {
            options?.updates?.push(workspace);
          }),
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => options?.changes ?? Stream.empty,
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
  const fixture = TestBed.createComponent(TabStripHost);
  const tabs = TestBed.inject(Tabs);
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  fixture.detectChanges();
  return { fixture, tabs };
};

const all = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const one = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement => {
  const el = all(fixture, testId)[0];
  if (el === undefined) throw new Error(`no ${testId}`);
  return el;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TabStrip', () => {
  it('renders sidebar trigger, active Project Tabs with role=tablist/tab, + button, and close buttons', async () => {
    const { fixture, tabs } = await mount();
    tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    tabs.open({ id: s2, projectId: p2, title: 'API server' });
    tabs.switchProject(p1);
    fixture.detectChanges();

    expect(document.querySelector('[data-slot="sidebar-trigger"]')).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')).not.toBeNull();
    const tabItems = all(fixture, 'tab-item');
    expect(tabItems).toHaveLength(1);
    expect(tabItems[0]?.getAttribute('role')).toBe('tab');
    expect(tabItems[0]?.getAttribute('aria-selected')).toBe('true');
    expect(one(fixture, 'tab-title').textContent?.trim()).toBe('Fix login');

    // + button opens a fresh draft Tab in the active Project (p1).
    expect(one(fixture, 'new-tab').getAttribute('data-slot')).toBe('button');
    one(fixture, 'new-tab').click();
    fixture.detectChanges();
    expect(all(fixture, 'tab-item')).toHaveLength(2);
    expect(all(fixture, 'tab-title').map((el) => el.textContent?.trim())).toEqual([
      'Fix login',
      'New Session',
    ]);
    expect(all(fixture, 'tab-item')[1]?.getAttribute('aria-selected')).toBe('true');

    // Clicking the first Tab activates it.
    all(fixture, 'tab-item')[0]?.click();
    fixture.detectChanges();
    expect(all(fixture, 'tab-item')[0]?.getAttribute('aria-selected')).toBe('true');

    // Switching Project swaps visible Tabs without closing p1's Tabs.
    tabs.switchProject(p2);
    fixture.detectChanges();
    expect(all(fixture, 'tab-title').map((el) => el.textContent?.trim())).toEqual(['API server']);

    // Close button closes the Tab in p2.
    expect(one(fixture, 'tab-close').getAttribute('data-slot')).toBe('button');
    one(fixture, 'tab-close').click();
    fixture.detectChanges();
    expect(all(fixture, 'tab-item')).toHaveLength(0);
  });

  it('renames a Tab inline on double-click or context menu, cancels on Esc, and clears customTitle on blank', async () => {
    const { fixture, tabs } = await mount();
    tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    fixture.detectChanges();

    // Double-click starts inline rename; Esc discards.
    one(fixture, 'tab-item').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const editor = one(fixture, 'tab-rename-input') as HTMLInputElement;
    expect(editor.getAttribute('data-slot')).toBe('input');
    expect(editor.value).toBe('Fix login');
    editor.value = 'Discarded';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(all(fixture, 'tab-rename-input')).toHaveLength(0);
    expect(one(fixture, 'tab-title').textContent?.trim()).toBe('Fix login');

    // Context menu Rename Tab commits on Enter.
    one(fixture, 'tab-item').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }),
    );
    fixture.detectChanges();
    one(fixture, 'tab-menu-rename').click();
    fixture.detectChanges();
    const nextEditor = one(fixture, 'tab-rename-input') as HTMLInputElement;
    nextEditor.value = 'Auth cleanup';
    nextEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(one(fixture, 'tab-title').textContent?.trim()).toBe('Auth cleanup');

    // Blank rename clears customTitle back to the Panel title.
    one(fixture, 'tab-item').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const clearEditor = one(fixture, 'tab-rename-input') as HTMLInputElement;
    clearEditor.value = '   ';
    clearEditor.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(one(fixture, 'tab-title').textContent?.trim()).toBe('Fix login');
    expect(tabs.activeTab()?.customTitle).toBeUndefined();
  });

  it('displays and aggregates Attention (priority over Working) indicators across all Panels in a Tab', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const { fixture, tabs } = await mount({ changes: Stream.fromQueue(changes) });
    const tab = tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    expect(tab).toBeDefined();
    tabs.openSessionInSplit({ id: s2, projectId: p1, title: 'Split worker' }, 'bottom');
    tabs.openSessionInSplit({ id: s3, projectId: p1, title: 'Split session' }, 'right');
    fixture.detectChanges();

    expect(all(fixture, 'tab-activity-indicator')).toHaveLength(0);

    // Working on one Panel shows session-running inside tab-activity-indicator.
    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(all(fixture, 'tab-activity-indicator')).toHaveLength(1);
      expect(
        one(fixture, 'tab-activity-indicator').querySelector('[data-testid="session-running"]'),
      ).not.toBeNull();
    });

    // Error on the split Panel overrides Working on the first Panel.
    Queue.offerUnsafe(changes, {
      sessionId: s3,
      projectId: p1,
      state: liveState({ attention: 'error' }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        one(fixture, 'tab-activity-indicator').querySelector('[data-testid="attention-error"]'),
      ).not.toBeNull();
      expect(all(fixture, 'session-running')).toHaveLength(0);
    });

    // needsAnswer on the collapsed stacked Panel overrides both error and running.
    Queue.offerUnsafe(changes, {
      sessionId: s2,
      projectId: p1,
      state: liveState({ attention: 'needsAnswer', runningTurn: TurnId.make('t2') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        one(fixture, 'tab-activity-indicator').querySelector(
          '[data-testid="attention-needsAnswer"]',
        ),
      ).not.toBeNull();
      expect(all(fixture, 'attention-error')).toHaveLength(0);
    });

    // Clearing needsAnswer falls back to error, and clearing error falls back to running.
    Queue.offerUnsafe(changes, { sessionId: s2, projectId: p1, state: liveState() });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        one(fixture, 'tab-activity-indicator').querySelector('[data-testid="attention-error"]'),
      ).not.toBeNull();
    });
    Queue.offerUnsafe(changes, { sessionId: s3, projectId: p1, state: liveState() });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(
        one(fixture, 'tab-activity-indicator').querySelector('[data-testid="session-running"]'),
      ).not.toBeNull();
    });
  });

  it('reorders Tabs within the active Project on horizontal pointer drag past 5px, guards clicks/dblclick, cancels on Esc, and persists via Tabs.update', async () => {
    const pointerEvent = (
      type: string,
      init: {
        readonly clientX?: number;
        readonly clientY?: number;
        readonly button?: number;
        readonly pointerId?: number;
      },
    ): Event => {
      const Ctor = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      return new Ctor(type, { bubbles: true, cancelable: true, button: 0, ...init });
    };
    const setRect = (el: HTMLElement, left: number, width: number) => {
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
        x: left,
        y: 0,
        left,
        top: 0,
        right: left + width,
        bottom: 28,
        width,
        height: 28,
        toJSON: () => ({}),
      });
    };

    const updates: WorkspaceState[] = [];
    const { fixture, tabs } = await mount({ updates });
    const t1 = tabs.open({ id: s1, projectId: p1, title: 'Tab One' });
    const t2 = tabs.open({ id: s2, projectId: p1, title: 'Tab Two' });
    const t3 = tabs.newTab(p1);
    const p2Tab = tabs.open({ id: SessionId.make('s3'), projectId: p2, title: 'Other Project' });
    tabs.switchProject(p1);
    tabs.activateTab(t2.id);
    fixture.detectChanges();

    const items = all(fixture, 'tab-item');
    expect(items).toHaveLength(3);
    setRect(items[0]!, 0, 100);
    setRect(items[1]!, 104, 100);
    setRect(items[2]!, 208, 100);

    // Short move (< 5px) does NOT trigger drag or reorder.
    const updatesBeforeShort = updates.length;
    items[0]!.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 14, pointerId: 1 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 53, clientY: 14, pointerId: 1 }));
    fixture.detectChanges();
    expect(document.querySelector('[data-drop-target="true"]')).toBeNull();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 53, clientY: 14, pointerId: 1 }));
    fixture.detectChanges();
    expect(updates.length).toBe(updatesBeforeShort);
    expect(tabs.tabs().map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);

    // Dragging Tab 1 over Tab 3 highlights Tab 3, and Escape cancels without reordering.
    items[0]!.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 14, pointerId: 2 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 14, pointerId: 2 }));
    fixture.detectChanges();
    expect(items[2]!.getAttribute('data-drop-target')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(document.querySelector('[data-drop-target="true"]')).toBeNull();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 250, clientY: 14, pointerId: 2 }));
    fixture.detectChanges();
    expect(tabs.tabs().map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
    expect(updates.length).toBe(updatesBeforeShort);

    // Dragging Tab 1 onto Tab 3 and releasing reorders Tabs and persists via Tabs.update without mutating activeTabId or p2.
    items[0]!.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 50, clientY: 14, pointerId: 3 }),
    );
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 250, clientY: 14, pointerId: 3 }));
    fixture.detectChanges();
    window.dispatchEvent(pointerEvent('pointerup', { clientX: 250, clientY: 14, pointerId: 3 }));
    fixture.detectChanges();

    expect(tabs.tabs().map((t) => t.id)).toEqual([t2.id, t3.id, t1.id]);
    expect(tabs.activeTab()?.id).toBe(t2.id);
    expect(updates.length).toBe(updatesBeforeShort + 1);
    expect(
      tabs
        .workspace()
        .projects.find((p) => p.projectId === p2)
        ?.tabs.map((t) => t.id),
    ).toEqual([p2Tab.id]);
  });

  it('shows hover tooltips on Tabs with full title, live micro-status, and local elapsed ticking', async () => {
    const hoverIn = (el: HTMLElement) => {
      el.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerenter', { pointerType: 'mouse' })
          : Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }),
      );
    };
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const baseNow = 1_700_000_020_000;
      vi.setSystemTime(baseNow);
      const changes = Effect.runSync(Queue.unbounded<SessionChange>());
      const { fixture, tabs } = await mount({ changes: Stream.fromQueue(changes) });
      tabs.open({ id: s1, projectId: p1, title: 'Fix login and verify full suite' });
      fixture.detectChanges();

      Queue.offerUnsafe(changes, {
        sessionId: s1,
        projectId: p1,
        state: liveState({
          title: { auto: 'Fix login and verify full suite', autoIsPlaceholder: false },
          runningTurn: TurnId.make('t1'),
          activity: { kind: 'execute', target: 'npm test', startedAt: baseNow - 14_000 },
        }),
      });
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(all(fixture, 'tab-activity-indicator')).toHaveLength(1);
      });

      const tabBtn = one(fixture, 'tab-item');
      // Tab itself remains calm and single-line without running-command prose.
      expect(tabBtn.textContent).not.toContain('npm test');

      hoverIn(tabBtn);
      fixture.detectChanges();
      await vi.waitFor(() => {
        const tip = document.querySelector('[role="tooltip"]');
        expect(tip?.textContent).toContain('Fix login and verify full suite');
        expect(tip?.textContent).toContain('running npm test · 14s');
      });

      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
        'running npm test · 15s',
      );

      Queue.offerUnsafe(changes, {
        sessionId: s1,
        projectId: p1,
        state: liveState({
          title: { auto: 'Fix login and verify full suite', autoIsPlaceholder: false },
          attention: 'needsAnswer',
          runningTurn: TurnId.make('t1'),
          blockedTarget: 'git push',
        }),
      });
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
          'waiting for permission: git push',
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows restored activity and blockedTarget on background Tab hover before Session.changes arrives', async () => {
    const hoverIn = (el: HTMLElement) => {
      el.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerenter', { pointerType: 'mouse' })
          : Object.assign(new Event('pointerenter'), { pointerType: 'mouse' }),
      );
    };
    const hoverOut = (el: HTMLElement) => {
      el.dispatchEvent(
        typeof PointerEvent === 'function'
          ? new PointerEvent('pointerleave', { pointerType: 'mouse' })
          : Object.assign(new Event('pointerleave'), { pointerType: 'mouse' }),
      );
    };
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const baseNow = 1_700_000_020_000;
      vi.setSystemTime(baseNow);
      const t1 = TabId.make('t1');
      const t2 = TabId.make('t2');
      const p1Panel = PanelId.make('panel-1');
      const p2Panel = PanelId.make('panel-2');
      const { fixture, tabs } = await mount({
        restored: {
          workspace: {
            activeProjectId: p1,
            projects: [
              {
                projectId: p1,
                activeTabId: t1,
                tabs: [
                  {
                    id: t1,
                    focusedPanelId: p1Panel,
                    layout: {
                      rootPaneId: PaneId.make('pane-1'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-1'),
                          panels: [{ id: p1Panel, spec: { _tag: 'Session', sessionId: s1 } }],
                        },
                      ],
                    },
                  },
                  {
                    id: t2,
                    focusedPanelId: p2Panel,
                    layout: {
                      rootPaneId: PaneId.make('pane-2'),
                      nodes: [
                        {
                          _tag: 'Leaf',
                          id: PaneId.make('pane-2'),
                          panels: [{ id: p2Panel, spec: { _tag: 'Session', sessionId: s2 } }],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
          sessions: [
            {
              id: s1,
              projectId: p1,
              title: { auto: 'Active tab', autoIsPlaceholder: false },
              running: true,
              activity: { kind: 'read', target: 'src/app.ts', startedAt: baseNow - 5_000 },
            },
            {
              id: s2,
              projectId: p1,
              title: { auto: 'Blocked tab', autoIsPlaceholder: false },
              attention: 'needsAnswer',
              running: true,
              blockedTarget: 'rm -rf dist',
            },
          ],
        },
      });

      const tabButtons = all(fixture, 'tab-item');
      expect(tabButtons).toHaveLength(2);
      const [firstTab, secondTab] = tabButtons;
      if (firstTab === undefined || secondTab === undefined) {
        throw new Error('Expected two restored tabs');
      }

      hoverIn(firstTab);
      fixture.detectChanges();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
          'reading src/app.ts · 5s',
        );
      });

      hoverOut(firstTab);
      fixture.detectChanges();

      hoverIn(secondTab);
      fixture.detectChanges();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
          'waiting for permission: rm -rf dist',
        );
      });

      hoverOut(secondTab);
      fixture.detectChanges();

      // Opening a Session from summary metadata carries activity before Session.changes arrives.
      tabs.open({
        id: s3,
        projectId: p1,
        title: 'Opened from summary',
        running: true,
        activity: { kind: 'execute', target: 'vitest', startedAt: baseNow - 3_000 },
      });
      fixture.detectChanges();
      const thirdTab = all(fixture, 'tab-item')[2];
      if (thirdTab === undefined) throw new Error('Expected third tab');
      hoverIn(thirdTab);
      fixture.detectChanges();
      await vi.waitFor(() => {
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
          'running vitest · 3s',
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
