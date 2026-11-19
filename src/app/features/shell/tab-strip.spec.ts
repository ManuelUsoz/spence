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
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
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

const mount = async (options?: { readonly changes?: Stream.Stream<SessionChange> }) => {
  const layer = makeDesktopTestLayer(
    Layer.mergeAll(
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': () => Effect.void,
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

  it('displays Attention (priority over Working) indicators on Tabs', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const { fixture, tabs } = await mount({ changes: Stream.fromQueue(changes) });
    tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    fixture.detectChanges();

    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(all(fixture, 'session-running')).toHaveLength(1);
    });

    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ attention: 'needsAnswer', runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(all(fixture, 'attention-needsAnswer')).toHaveLength(1);
      expect(all(fixture, 'session-running')).toHaveLength(0);
    });
  });
});
