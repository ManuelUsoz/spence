import { ChangeDetectionStrategy, Component, input, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Queue, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import {
  PanelId,
  TabsRpcs,
  type PaneId,
  type PanelSpec,
  type WorkspacePanel,
} from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE, allTabLeaves } from '../../../shared/tabs/workspace-layout';
import { ChangesState } from '../../core/changes-view';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { PANEL_DEFINITION, type PanelDefinition } from '../../core/panel-registry';
import { SessionToolbar, type SessionToolbarAction } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { PanelHeader } from './panel-header';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { SessionsState } from './sessions-state';

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
  readonly changes: ChangesState;
  readonly renamed: Array<{ readonly sessionId: SessionId; readonly title: string }>;
  readonly archived: SessionId[];
  readonly unarchived: SessionId[];
  readonly deleted: SessionId[];
}

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

const defaultSettings: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  crossProjectAccess: [],
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
        [panel]="panel()"
        [paneId]="paneId()"
        [projectId]="projectId"
        [projectName]="'spence'"
        [focused]="focused()"
        [canSplit]="canSplit()"
      />
      <app-session-confirm-dialog />
    `,
  })
  class Host {
    readonly projectId = p1;
    readonly panel = input.required<WorkspacePanel>();
    readonly paneId = input<PaneId | null>(null);
    readonly focused = input(true);
    readonly canSplit = input(true);
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
  fixture.componentRef.setInput('panel', panel);
  fixture.componentRef.setInput('paneId', options?.paneId ?? null);
  fixture.componentRef.setInput('focused', options?.focused ?? true);
  fixture.componentRef.setInput('canSplit', options?.canSplit ?? true);
  const tabs = TestBed.inject(Tabs);
  const toolbar = TestBed.inject(SessionToolbar);
  const changes = TestBed.inject(ChangesState);
  if (options?.summaries !== undefined) {
    TestBed.inject(SessionsState).remember(options.summaries, p1);
  }
  await vi.waitFor(() => expect(tabs.restored()).toBe(true));
  fixture.detectChanges();
  return { fixture, tabs, toolbar, changes, renamed, archived, unarchived, deleted };
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
      collapsed: false,
      heightShare: 1,
    };
    const h = await mountHeader(keptPanel);
    h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    h.fixture.detectChanges();

    expect(one(h.fixture, 'panel-title').textContent?.trim()).toBe('Fix login');

    // Double-click opens inline rename; Esc discards.
    one(h.fixture, 'panel-title').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    h.fixture.detectChanges();
    const escInput = one(h.fixture, 'panel-rename') as HTMLInputElement;
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
      collapsed: false,
      heightShare: 1,
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
      collapsed: false,
      heightShare: 1,
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
      collapsed: false,
      heightShare: 1,
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

    one(h.fixture, 'session-actions-trigger').click();
    expect(one(h.fixture, 'session-context-label').textContent).toBe('42k of 200k · 21%');
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
      collapsed: false,
      heightShare: 0.5,
    };
    const panel2: WorkspacePanel = {
      id: PanelId.make('panel-2'),
      spec: { _tag: 'Session', sessionId: s2 },
      collapsed: false,
      heightShare: 0.5,
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
      collapsed: false,
      heightShare: 1,
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

  it('launches Changes via ChangesState and closes the Panel/Tab via panel-close without deleting kept Sessions', async () => {
    const h = await mountHeader(
      {
        id: PanelId.make('placeholder'),
        spec: { _tag: 'Session', sessionId: s1 },
        collapsed: false,
        heightShare: 1,
      },
      { summaries: [sessionSummary(s1, 'Fix login')] },
    );
    const tab = h.tabs.open({ id: s1, projectId: p1, title: 'Fix login' });
    const realPanel = h.tabs.focusedPanel()!;
    h.fixture.componentRef.setInput('panel', realPanel);
    h.fixture.detectChanges();

    one(h.fixture, 'open-changes').click();
    expect(h.changes.open()).toBe(true);
    h.changes.set(false);
    h.fixture.detectChanges();

    one(h.fixture, 'panel-close').click();
    expect(h.tabs.tabs().some((t) => t.id === tab.id)).toBe(false);
    expect(h.tabs.activeTab()).toBeNull();
    expect(h.deleted).toEqual([]);
    expect(h.archived).toEqual([]);

    // Draft Panel closes cleanly too.
    const draftTab = h.tabs.newTab(p1);
    const draftPanel = h.tabs.focusedPanel()!;
    h.fixture.componentRef.setInput('panel', draftPanel);
    h.fixture.detectChanges();
    one(h.fixture, 'panel-close').click();
    expect(h.tabs.tabs().some((t) => t.id === draftTab.id)).toBe(false);
    expect(h.tabs.draftOf(p1)).toBeNull();
  });

  it('offers Split right and Split down in the Panel header menu when inside a Pane and disables them when canSplit is false', async () => {
    const h = await mountHeader({
      id: PanelId.make('placeholder'),
      spec: { _tag: 'Session', sessionId: s1 },
      collapsed: false,
      heightShare: 1,
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

  it('shows Attention (needsAnswer > error > running) indicator only while collapsed and updates live from Session.changes', async () => {
    const changes = Effect.runSync(Queue.unbounded<SessionChange>());
    const basePanel: WorkspacePanel = {
      id: PanelId.make('panel-s1'),
      spec: { _tag: 'Session', sessionId: s1 },
      collapsed: false,
      heightShare: 0.5,
    };
    const h = await mountHeader(basePanel, { changes: Stream.fromQueue(changes) });

    // Idle & expanded: no indicator.
    expect(all(h.fixture, 'panel-activity-indicator')).toHaveLength(0);

    // Running while expanded: collapsed indicator stays hidden.
    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => expect(h.tabs.sessionStatus(s1)?.running).toBe(true));
    expect(all(h.fixture, 'panel-activity-indicator')).toHaveLength(0);

    // Collapsing reveals running indicator.
    h.fixture.componentRef.setInput('panel', { ...basePanel, collapsed: true });
    h.fixture.detectChanges();
    expect(all(h.fixture, 'panel-activity-indicator')).toHaveLength(1);
    expect(
      one(h.fixture, 'panel-activity-indicator').querySelector('[data-testid="session-running"]'),
    ).not.toBeNull();

    // Error overrides running.
    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ attention: 'error', runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      h.fixture.detectChanges();
      expect(
        one(h.fixture, 'panel-activity-indicator').querySelector('[data-testid="attention-error"]'),
      ).not.toBeNull();
    });
    expect(
      one(h.fixture, 'panel-activity-indicator').querySelector('[data-testid="session-running"]'),
    ).toBeNull();

    // needsAnswer overrides error and running.
    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState({ attention: 'needsAnswer', runningTurn: TurnId.make('t1') }),
    });
    await vi.waitFor(() => {
      h.fixture.detectChanges();
      expect(
        one(h.fixture, 'panel-activity-indicator').querySelector(
          '[data-testid="attention-needsAnswer"]',
        ),
      ).not.toBeNull();
    });

    // Expanding hides the collapsed indicator again.
    h.fixture.componentRef.setInput('panel', { ...basePanel, collapsed: false });
    h.fixture.detectChanges();
    expect(all(h.fixture, 'panel-activity-indicator')).toHaveLength(0);

    // Returning to idle while collapsed hides the indicator.
    h.fixture.componentRef.setInput('panel', { ...basePanel, collapsed: true });
    Queue.offerUnsafe(changes, {
      sessionId: s1,
      projectId: p1,
      state: liveState(),
    });
    await vi.waitFor(() => {
      h.fixture.detectChanges();
      expect(all(h.fixture, 'panel-activity-indicator')).toHaveLength(0);
    });
  });
});
