import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionChange,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import {
  PanelId,
  TabId,
  TabsRpcs,
  type PaneId,
  type PanelSpec,
  type WorkspacePanel,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, allTabLeaves } from '../../../shared/tabs/workspace-layout';
import { ChatBackgrounds } from '../../core/chat-backgrounds';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { PANEL_DEFINITION, type PanelDefinition } from '../../core/panel-registry';
import { SessionToolbar, type SessionToolbarAction } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { PanelHeader } from './panel-header';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SessionsState } from './sessions-state';

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}

const p1 = ProjectId.make('p1');
const s1 = SessionId.make('s1');
const s2 = SessionId.make('s2');
const workerId = SessionId.make('worker-1');

const project1: Project = {
  id: p1,
  name: 'spence',
  path: '/work/spence',
  addedAt: 1,
  lastUsedAt: 2,
  settings: {},
  folderMissing: false,
};

const sessionSummary = (id: SessionId, title: string, archivedAt?: number): SessionSummary => ({
  id,
  agentId: AgentId.make('claude'),
  title: { auto: title, autoIsPlaceholder: false },
  lastActivityAt: 100,
  ...(archivedAt === undefined ? {} : { archivedAt }),
});

@Component({
  selector: 'app-notes-panel-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class NotesPanelStub {}

interface HarnessResult {
  readonly fixture: ComponentFixture<unknown>;
  readonly tabs: Tabs;
  readonly toolbar: SessionToolbar;
  readonly renamed: Array<{ readonly sessionId: SessionId; readonly title: string }>;
  readonly archived: SessionId[];
  readonly unarchived: SessionId[];
  readonly deleted: SessionId[];
}

const defaultSettings: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers',
  sendMode: 'queue',
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  agents: {},
};

const makeDesktop = (options?: {
  readonly changes?: Stream.Stream<SessionChange>;
  readonly renamed?: Array<{ readonly sessionId: SessionId; readonly title: string }>;
  readonly archived?: SessionId[];
  readonly unarchived?: SessionId[];
  readonly deleted?: SessionId[];
}) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      SettingsRpcs.toLayer({
        'Settings.get': () => Effect.succeed(defaultSettings),
        'Settings.update': () => Effect.succeed(defaultSettings),
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': () => Effect.succeed([project1]),
        'Projects.add': () => Effect.die('unused'),
        'Projects.rename': () => Effect.die('unused'),
        'Projects.remove': () => Effect.die('unused'),
        'Projects.locate': () => Effect.die('unused'),
        'Projects.addFolder': () => Effect.die('unused'),
        'Projects.locateFolder': () => Effect.die('unused'),
        'Projects.check': () => Effect.die('unused'),
        'Projects.setSettings': () => Effect.die('unused'),
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => options?.changes ?? Stream.empty,
        'Session.list': () =>
          Effect.succeed([sessionSummary(s1, 'Fix login'), sessionSummary(s2, 'Refactor tabs')]),
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
        'Session.rename': (payload) =>
          Effect.sync(() => {
            options?.renamed?.push(payload);
          }),
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.archive': ({ sessionId }) =>
          Effect.sync(() => {
            options?.archived?.push(sessionId);
          }),
        'Session.unarchive': ({ sessionId }) =>
          Effect.sync(() => {
            options?.unarchived?.push(sessionId);
          }),
        'Session.countWorkers': () => Effect.succeed(0),
        'Session.delete': ({ sessionId }) =>
          Effect.sync(() => {
            options?.deleted?.push(sessionId);
          }),
      }),
    ),
  );

const mountHeader = async (
  panel: WorkspacePanel,
  options?: {
    readonly changes?: Stream.Stream<SessionChange>;
    readonly paneId?: PaneId | null;
    readonly tabId?: TabId | null;
    readonly isSplit?: boolean;
    readonly canSplit?: boolean;
    readonly focused?: boolean;
    readonly definitions?: ReadonlyArray<PanelDefinition>;
    readonly summaries?: ReadonlyArray<SessionSummary>;
  },
): Promise<HarnessResult> => {
  const renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [];
  const archived: SessionId[] = [];
  const unarchived: SessionId[] = [];
  const deleted: SessionId[] = [];

  @Component({
    selector: 'app-panel-header-host',
    imports: [PanelHeader, SessionConfirmDialog],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
      <app-panel-header
        [tabId]="tabId()"
        [panel]="panel()"
        [paneId]="paneId()"
        [projectId]="projectId"
        [projectName]="'spence'"
        [focused]="focused()"
        [canSplit]="canSplit()"
        [isSplit]="isSplit()"
      />
      <app-session-confirm-dialog />
    `,
  })
  class Host {
    readonly projectId = p1;
    readonly tabId = input<TabId | null>(null);
    readonly panel = input.required<WorkspacePanel>();
    readonly paneId = input<PaneId | null>(null);
    readonly focused = input(true);
    readonly canSplit = input(true);
    readonly isSplit = input(true);
  }

  TestBed.configureTestingModule({
    providers: [
      {
        provide: DESKTOP_LAYER,
        useValue: makeDesktop({
          ...(options?.changes === undefined ? {} : { changes: options.changes }),
          renamed,
          archived,
          unarchived,
          deleted,
        }),
      },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
      ...(options?.definitions ?? []).map((def) => ({
        provide: PANEL_DEFINITION,
        multi: true,
        useValue: def,
      })),
    ],
  });

  const fixture = TestBed.createComponent(Host);
  fixture.componentRef.setInput('tabId', options?.tabId ?? null);
  fixture.componentRef.setInput('panel', panel);
  fixture.componentRef.setInput('paneId', options?.paneId ?? null);
  fixture.componentRef.setInput('focused', options?.focused ?? true);
  fixture.componentRef.setInput('canSplit', options?.canSplit ?? true);
  fixture.componentRef.setInput('isSplit', options?.isSplit ?? true);
  const tabs = TestBed.inject(Tabs);
  const toolbar = TestBed.inject(SessionToolbar);
  if (options?.summaries !== undefined) {
    TestBed.inject(SessionsState).remember(options.summaries, p1);
  }
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  fixture.detectChanges();
  return { fixture, tabs, toolbar, renamed, archived, unarchived, deleted };
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

describe('PanelHeader', () => {
  it('shows Session title, supports double-click and menu inline rename, and ignores rename on drafts or custom Panels', async () => {
    const keptPanel: WorkspacePanel = {
      id: PanelId.make('panel-1'),
      spec: { _tag: 'Session', sessionId: s1 },
    };
    const h = await mountHeader(keptPanel);
    h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    h.fixture.detectChanges();

    expect(one(h.fixture, 'panel-title').textContent?.trim()).toBe('Fix login');

    // Double-click opens inline rename; Esc discards.
    one(h.fixture, 'panel-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    h.fixture.detectChanges();
    const escInput = one(h.fixture, 'panel-rename') as HTMLInputElement;
    expect(escInput.getAttribute('data-slot')).toBe('input');
    expect(escInput.value).toBe('Fix login');
    escInput.value = 'Discarded';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    h.fixture.detectChanges();
    expect(all(h.fixture, 'panel-rename')).toHaveLength(0);
    expect(h.renamed).toEqual([]);

    // Double-click again and Enter commits via Session.rename.
    one(h.fixture, 'panel-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    h.fixture.detectChanges();
    const commitInput = one(h.fixture, 'panel-rename') as HTMLInputElement;
    commitInput.value = 'Login fixed';
    commitInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(h.renamed).toEqual([{ sessionId: s1, title: 'Login fixed' }]));

    // Draft Panel shows muted "New Session" and ignores double-click rename.
    h.fixture.componentRef.setInput('panel', {
      id: PanelId.make('panel-draft'),
      spec: { _tag: 'Session', draft: true },
    } satisfies WorkspacePanel);
    h.fixture.detectChanges();
    expect(one(h.fixture, 'panel-title').textContent?.trim()).toBe('New Session');
    expect(one(h.fixture, 'panel-title').classList.contains('text-muted-foreground')).toBe(true);
    one(h.fixture, 'panel-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(all(h.fixture, 'panel-rename')).toHaveLength(0);

    // Custom Panel reads headerMeta from PanelRegistry and does not offer Session menu/rename.
    TestBed.resetTestingModule();
    const customPanel: WorkspacePanel = {
      id: PanelId.make('panel-notes'),
      spec: { _tag: 'Notes' } as unknown as PanelSpec,
    };
    const custom = await mountHeader(customPanel, {
      definitions: [
        {
          kind: 'Notes',
          component: NotesPanelStub,
          headerMeta: (ctx) => ({ title: `Notes · ${ctx.projectName}` }),
        },
      ],
    });
    expect(one(custom.fixture, 'panel-title').textContent?.trim()).toBe('Notes · spence');
    expect(all(custom.fixture, 'session-actions-trigger')).toHaveLength(0);
    expect(all(custom.fixture, 'open-changes')).toHaveLength(0);
    expect(all(custom.fixture, 'panel-close')).toHaveLength(1);
    one(custom.fixture, 'panel-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(all(custom.fixture, 'panel-rename')).toHaveLength(0);
  });

  it('reads per-Session context and actions from SessionToolbar, runs operations, and handles Archive/Unarchive/Delete', async () => {
    const panel: WorkspacePanel = {
      id: PanelId.make('panel-s1'),
      spec: { _tag: 'Session', sessionId: s1 },
    };
    const h = await mountHeader(panel, {
      summaries: [sessionSummary(s1, 'Fix login')],
    });
    h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });

    const ran1: string[] = [];
    const ran2: string[] = [];
    const withdraw1 = h.toolbar.publish({
      sessionId: signal<string>(s1),
      context: signal({ label: '42k of 200k · 21%', fraction: 0.21 }),
      actions: signal<ReadonlyArray<SessionToolbarAction>>([
        {
          id: 'compact',
          operation: 'Compact',
          label: 'Compact context',
          command: '/compact',
          disabled: false,
        },
        {
          id: 'clear',
          operation: 'Clear',
          label: 'Clear context',
          command: '/clear',
          disabled: false,
        },
        {
          id: 'switch-agent',
          operation: 'Switch Agent',
          label: 'Switch Agent or Model…',
          disabled: false,
        },
      ]),
      run: (op) => ran1.push(op),
    });
    const withdraw2 = h.toolbar.publish({
      sessionId: signal<string>(s2),
      context: signal({ label: '99k of 200k · 50%', fraction: 0.5 }),
      actions: signal([]),
      run: (op) => ran2.push(op),
    });

    expect(one(h.fixture, 'session-actions-trigger').hasAttribute('hlmBtn')).toBe(true);
    expect(one(h.fixture, 'panel-close').getAttribute('data-slot')).toBe('button');
    one(h.fixture, 'session-actions-trigger').click();
    expect(one(h.fixture, 'session-context-label').textContent).toBe('42k of 200k · 21%');
    expect(one(h.fixture, 'session-context-progress').getAttribute('data-slot')).toBe('progress');
    expect(one(h.fixture, 'session-context-progress').getAttribute('aria-valuenow')).toBe('21');
    one(h.fixture, 'session-action-compact').click();
    expect(ran1).toEqual(['Compact']);
    expect(ran2).toEqual([]);

    // Archive closes the Session and calls Session.archive.
    one(h.fixture, 'session-actions-trigger').click();
    one(h.fixture, 'menu-archive').click();
    await vi.waitFor(() => expect(h.archived).toEqual([s1]));

    // Delete prompts confirmation dialog and calls Session.delete.
    one(h.fixture, 'session-actions-trigger').click();
    one(h.fixture, 'menu-delete').click();
    await vi.waitFor(() => expect(all(h.fixture, 'confirm-action')).toHaveLength(1));
    one(h.fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(h.deleted).toEqual([s1]));

    withdraw1();
    withdraw2();
  });

  it('opens the ⋯ menu via Mod+Shift+K only on the focused Panel when multiple Panels are mounted', async () => {
    const panel1: WorkspacePanel = {
      id: PanelId.make('panel-1'),
      spec: { _tag: 'Session', sessionId: s1 },
    };
    const panel2: WorkspacePanel = {
      id: PanelId.make('panel-2'),
      spec: { _tag: 'Session', sessionId: s2 },
    };

    @Component({
      selector: 'app-dual-panel-header-host',
      imports: [PanelHeader],
      changeDetection: ChangeDetectionStrategy.OnPush,
      template: `
        <app-panel-header [panel]="p1" [projectId]="projectId" [focused]="false" />
        <app-panel-header [panel]="p2" [projectId]="projectId" [focused]="true" />
      `,
    })
    class DualHost {
      readonly projectId = p1;
      readonly p1 = panel1;
      readonly p2 = panel2;
    }

    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktop() },
        { provide: KEYMAP_PLATFORM, useValue: 'other' },
      ],
    });
    const fixture = TestBed.createComponent(DualHost);
    const tabs = TestBed.inject(Tabs);
    const toolbar = TestBed.inject(SessionToolbar);
    await vi.waitFor(() => expect(tabs.restored()).toBe(true));

    const w1 = toolbar.publish({
      sessionId: signal<string>(s1),
      context: signal({ label: 'Session One Context', fraction: 0.1 }),
      actions: signal([]),
      run: () => undefined,
    });
    const w2 = toolbar.publish({
      sessionId: signal<string>(s2),
      context: signal({ label: 'Session Two Context', fraction: 0.2 }),
      actions: signal([]),
      run: () => undefined,
    });
    fixture.detectChanges();

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'K',
        code: 'KeyK',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();

    expect(all(fixture, 'session-actions-menu')).toHaveLength(1);
    expect(one(fixture, 'session-context-label').textContent).toBe('Session Two Context');
    w1();
    w2();
  });

  it('shows Worker parent link, kind, working spinner, and Parent needs you pill, and navigates to Parent on click', async () => {
    const workerPanel: WorkspacePanel = {
      id: PanelId.make('panel-worker'),
      spec: { _tag: 'Session', sessionId: workerId },
    };
    const h = await mountHeader(workerPanel, {
      summaries: [sessionSummary(s1, 'Fix login')],
    });
    h.tabs.open({ id: workerId, projectId: p1, title: 'Test writer' });
    const withdraw = h.toolbar.publish({
      sessionId: signal<string>(workerId),
      worker: signal({
        parentId: s1,
        agentId: 'claude',
        agentName: 'Claude',
        modelName: 'Haiku 5.5',
        working: true,
        waitingAncestorId: s1,
      }),
      context: signal({ label: '', fraction: null }),
      actions: signal([]),
      run: () => undefined,
    });
    h.fixture.detectChanges();

    expect(one(h.fixture, 'worker-parent-title').textContent?.trim()).toBe('Fix login');
    expect(one(h.fixture, 'panel-title').textContent?.trim()).toBe('Test writer');
    expect(one(h.fixture, 'worker-kind').textContent).toContain('Worker · Haiku 5.5');
    expect(one(h.fixture, 'worker-working').textContent).toContain('Working');
    expect(one(h.fixture, 'parent-needs-you').textContent).toContain('Parent needs you');

    one(h.fixture, 'worker-parent').click();
    expect(h.tabs.active()?.session).toBe(s1);

    h.tabs.open({ id: workerId, projectId: p1, title: 'Test writer' });
    one(h.fixture, 'parent-needs-you').click();
    expect(h.tabs.active()?.session).toBe(s1);
    withdraw();
  });

  it('launches full-Tab Changes and Workers overlays with active worker count and closes split Panes via panel-close without deleting kept Sessions', async () => {
    const h = await mountHeader(
      {
        id: PanelId.make('placeholder'),
        spec: { _tag: 'Session', sessionId: s1 },
      },
      { summaries: [sessionSummary(s1, 'Fix login')] },
    );
    const tab = h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    const leaf = allTabLeaves(tab)[0]!;
    h.fixture.componentRef.setInput('tabId', tab.id);
    h.fixture.componentRef.setInput('panel', leaf.panels[0]!);
    h.fixture.componentRef.setInput('paneId', leaf.id);
    h.fixture.detectChanges();

    expect(all(h.fixture, 'open-workers-count')).toHaveLength(0);
    h.tabs.applyLive(s1, {
      agentStatus: 'ready',
      title: { auto: 'Fix login', autoIsPlaceholder: false },
      options: { permissionMode: 'auto' },
      commands: [],
      commandsLoaded: true,
      queue: [],
      canAttachImages: false,
      imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
      workers: [
        { sessionId: workerId, title: 'Test writer', state: 'running' },
        { sessionId: SessionId.make('worker-2'), title: 'Done', state: 'idle' },
      ],
    });
    h.fixture.detectChanges();
    expect(one(h.fixture, 'open-workers-count').textContent?.trim()).toBe('1');

    one(h.fixture, 'open-changes').click();
    expect(h.tabs.activeTabOverlay()).toEqual({
      kind: 'Changes',
      sessionId: s1,
      sourcePaneId: leaf.id,
    });

    one(h.fixture, 'open-workers').click();
    expect(h.tabs.activeTabOverlay()).toEqual({
      kind: 'Workers',
      sessionId: s1,
      sourcePaneId: leaf.id,
    });
    h.tabs.closeTabOverlay(tab.id);

    // Clicking panel-close (when isSplit is true) closes the Panel cleanly without deleting/archiving the Session.
    one(h.fixture, 'panel-close').click();
    expect(h.tabs.tabs().some((t) => t.id === tab.id)).toBe(false);
    expect(h.tabs.activeTab()).toBeNull();
    expect(h.deleted).toEqual([]);
    expect(h.archived).toEqual([]);

    // Draft Panel closes cleanly too.
    const draftTab = h.tabs.newTab(p1);
    const draftPanel = h.tabs.focusedPanel()!;
    h.fixture.componentRef.setInput('tabId', draftTab.id);
    h.fixture.componentRef.setInput('panel', draftPanel);
    h.fixture.detectChanges();
    one(h.fixture, 'panel-close').click();
    expect(h.tabs.tabs().some((t) => t.id === draftTab.id)).toBe(false);
    expect(h.tabs.draftOf(p1)).toBeNull();
  });

  it('hides duplicate Session title and panel-close on 1-Pane Session Tabs while offering Change background in different mode', async () => {
    const h = await mountHeader(
      {
        id: PanelId.make('placeholder'),
        spec: { _tag: 'Session', sessionId: s1 },
      },
      { summaries: [sessionSummary(s1, 'Fix login')], isSplit: false },
    );
    const tab = h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    const leaf = allTabLeaves(tab)[0]!;
    h.fixture.componentRef.setInput('tabId', tab.id);
    h.fixture.componentRef.setInput('panel', leaf.panels[0]!);
    h.fixture.componentRef.setInput('paneId', leaf.id);
    h.fixture.detectChanges();

    // 1-Pane Session Tab: panel-title stays in DOM as sr-only and panel-close is omitted.
    expect(one(h.fixture, 'panel-title').classList.contains('sr-only')).toBe(true);
    expect(all(h.fixture, 'panel-close')).toHaveLength(0);

    // When Tab has a distinct customTitle, panel-title becomes visible to show the underlying Session name.
    h.tabs.renameTab(tab.id, 'Auth sprint');
    h.fixture.detectChanges();
    expect(one(h.fixture, 'panel-title').classList.contains('sr-only')).toBe(false);

    // Default 'solid' mode hides menu-change-background.
    one(h.fixture, 'session-actions-trigger').click();
    h.fixture.detectChanges();
    expect(all(h.fixture, 'menu-change-background')).toHaveLength(0);
    // Close the menu before switching mode and re-opening.
    one(h.fixture, 'session-actions-trigger').click();
    h.fixture.detectChanges();

    // Switching to 'different' mode offers Change background submenu and updates panel wallpaper on click.
    TestBed.inject(ChatBackgrounds).applySettings({ chatBackgroundMode: 'different' });
    one(h.fixture, 'session-actions-trigger').click();
    h.fixture.detectChanges();
    const bgTrigger = one(h.fixture, 'menu-change-background');
    bgTrigger.click();
    h.fixture.detectChanges();
    await h.fixture.whenStable();
    const option = all(h.fixture, 'menu-background-option').find(
      (el) => el.getAttribute('data-wallpaper-id') === 'rose-halftone',
    )!;
    expect(option).toBeDefined();
    option.click();
    h.fixture.detectChanges();
    expect(h.tabs.panelWallpaper(leaf.panels[0]!)?.id).toBe('rose-halftone');

    // Switching ChatBackgrounds back to 'solid' hides menu-change-background again.
    TestBed.inject(ChatBackgrounds).applySettings({ chatBackgroundMode: 'solid' });
    one(h.fixture, 'session-actions-trigger').click();
    h.fixture.detectChanges();
    expect(all(h.fixture, 'menu-change-background')).toHaveLength(0);
    // Avoid unused TabId type lint if only passed through options.
    expect(TabId.make('t1')).toBeDefined();
  });

  it('offers Split right and Split down in the Panel header menu when inside a Pane and disables them when canSplit is false', async () => {
    const h = await mountHeader({
      id: PanelId.make('placeholder'),
      spec: { _tag: 'Session', sessionId: s1 },
    });
    const tab = h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    const leaf = allTabLeaves(tab)[0]!;
    h.fixture.componentRef.setInput('panel', leaf.panels[0]!);
    h.fixture.componentRef.setInput('paneId', leaf.id);
    h.fixture.detectChanges();

    one(h.fixture, 'panel-split-trigger').click();
    (one(h.fixture, 'panel-split-right') as HTMLButtonElement).click();
    h.fixture.detectChanges();
    expect(h.tabs.paneCount(h.tabs.activeTab()!)).toBe(2);

    one(h.fixture, 'panel-split-trigger').click();
    (one(h.fixture, 'panel-split-down') as HTMLButtonElement).click();
    h.fixture.detectChanges();
    expect(h.tabs.paneCount(h.tabs.activeTab()!)).toBe(3);

    h.fixture.componentRef.setInput('canSplit', false);
    h.fixture.detectChanges();
    one(h.fixture, 'panel-split-trigger').click();
    const rightBtn = one(h.fixture, 'panel-split-right') as HTMLButtonElement;
    const downBtn = one(h.fixture, 'panel-split-down') as HTMLButtonElement;
    expect(rightBtn.disabled).toBe(true);
    expect(downBtn.disabled).toBe(true);
    expect(all(h.fixture, 'panel-split-reason')).toHaveLength(2);
  });
});
