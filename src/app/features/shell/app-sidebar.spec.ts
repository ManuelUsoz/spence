import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HlmToasterImports } from '@ui/sonner';
import { toast } from '@ui/toast';
import { Effect, Layer, PubSub, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../shared/agents/agents.rpc';
import {
  PermissionMode,
  ProjectId,
  ProjectsRpcs,
  type Project,
} from '../../../shared/projects/projects.rpc';
import {
  SessionError,
  SessionId,
  SessionsRpcs,
  TurnId,
  type LiveState,
  type SessionChange,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import {
  SettingsRpcs,
  type ProjectOrder,
  type Settings,
  type SettingsPatch,
} from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { EMPTY_WORKSPACE } from '../../../shared/tabs/workspace-layout';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap, type KeymapPlatform } from '../../core/keymap';
import { SessionToolbar, type SessionToolbarAction } from '../../core/session-toolbar';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { SettingsState } from './settings-state';
import { PanelHeader } from './panel-header';
import { SessionConfirmDialog } from './session-confirm-dialog';

/** Thursday 12 November 2026, 15:00 local time. */
const NOW = new Date(2026, 10, 12, 15, 0).getTime();
const at = (month: number, day: number, hour = 10): number =>
  new Date(2026, month, day, hour, 0).getTime();

const project = (id: string, name: string, lastUsedAt: number, folderMissing = false): Project => ({
  id: ProjectId.make(id),
  name,
  path: `/work/${id}`,
  addedAt: 1,
  lastUsedAt,
  settings: {},
  folderMissing,
});

const app = project('app', 'app', at(10, 12));
const api = project('api', 'api', at(10, 10), true);
const docs = project('docs', 'docs', at(10, 1));

const session = (id: string, title: string, lastActivityAt: number): SessionSummary => ({
  id: SessionId.make(id),
  agentId: AgentId.make('claude'),
  title: { auto: title, autoIsPlaceholder: false },
  lastActivityAt,
  status: 'idle',
});

const appSessions: ReadonlyArray<SessionSummary> = [
  session('today', 'Fix the login form', at(10, 12, 10)),
  session('yesterday', 'Write release notes', at(10, 11, 18)),
  session('week', 'Add login with GitHub', at(10, 8)),
  session('month', 'Upgrade Angular', at(9, 20)),
  session('august', 'Set up CI', at(7, 3)),
  { ...session('archived', 'Old spike', at(10, 12, 9)), archivedAt: at(10, 12, 11) },
];
const apiSessions: ReadonlyArray<SessionSummary> = [
  {
    ...session('renamed', 'auto title', at(10, 12, 14)),
    title: { user: 'Rate limits', autoIsPlaceholder: false },
  },
];

const docsSessions: ReadonlyArray<SessionSummary> = [
  {
    id: SessionId.make('untitled'),
    agentId: AgentId.make('claude'),
    title: { autoIsPlaceholder: false },
    lastActivityAt: at(10, 12, 12),
    status: 'idle',
  },
  {
    id: SessionId.make('images'),
    agentId: AgentId.make('claude'),
    title: { autoImageCount: 2, autoIsPlaceholder: true },
    lastActivityAt: at(10, 12, 11),
    status: 'idle',
  },
];

const settings = (projectOrder: ProjectOrder): Settings => ({
  language: 'system',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder,
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers' as const,
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  agents: {},
});

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  status: 'idle',
  title: { auto: 'Fix the login form', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  commandsLoaded: true,
  queue: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

const claude = AgentId.make('claude');

const agent: Agent = {
  id: claude,
  name: 'Claude',
  installKind: 'npm',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: true,
  qualifiedVersion: '0.106.0',
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
  capabilities: {
    models: true,
    effort: true,
    images: true,
    askMode: true,
    resume: true,
    contextUsage: true,
    supportsCompaction: true,
    supportsIsolatedSummary: true,
    modelChangePreservesContext: true,
    crossDeviceTools: true,
  },
};

type Fixture = ComponentFixture<unknown>;

interface MountOptions {
  readonly projectOrder?: ProjectOrder;
  readonly projects?: ReadonlyArray<Project>;
  readonly sessionsByProject?:
    | Readonly<Record<string, ReadonlyArray<SessionSummary>>>
    | ReadonlyMap<ProjectId, ReadonlyArray<SessionSummary>>;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly renamed?: Array<{ readonly sessionId: SessionId; readonly title: string }>;
  readonly projectRenamed?: Array<{ readonly id: ProjectId; readonly name: string }>;
  readonly archived?: Array<SessionId>;
  readonly onAddProject?: () => void;
  readonly platform?: KeymapPlatform;
  readonly docsList?: ReadonlyArray<SessionSummary>;
}

const applyPatch = (base: Settings, patch: SettingsPatch): Settings => ({
  ...base,
  ...(patch.language === undefined ? {} : { language: patch.language }),
  ...(patch.theme === undefined ? {} : { theme: patch.theme }),
  ...(patch.notifications === undefined ? {} : { notifications: patch.notifications }),
  ...(patch.projectOrder === undefined ? {} : { projectOrder: patch.projectOrder }),
  ...(patch.defaultPermissionMode === undefined
    ? {}
    : { defaultPermissionMode: patch.defaultPermissionMode }),
  ...(patch.autoArchiveDays === undefined ? {} : { autoArchiveDays: patch.autoArchiveDays }),
});

const sessionsForProject = (
  map: MountOptions['sessionsByProject'],
  projectId: ProjectId,
  docsList: ReadonlyArray<SessionSummary>,
): ReadonlyArray<SessionSummary> => {
  if (map instanceof Map) {
    return (
      map.get(projectId) ??
      (projectId === app.id ? appSessions : projectId === api.id ? apiSessions : [])
    );
  }
  if (map !== undefined)
    return (map as Readonly<Record<string, ReadonlyArray<SessionSummary>>>)[projectId] ?? [];
  if (projectId === app.id) return appSessions;
  if (projectId === api.id) return apiSessions;
  if (projectId === docs.id) return docsList;
  return [];
};

const makeLayer = (options: MountOptions = {}) => {
  let currentSettings = settings(options.projectOrder ?? { by: 'lastUsed', direction: 'desc' });
  const projectList = options.projects ?? [docs, api, app];
  const docsList = options.docsList ?? [];
  const renamed = options.renamed ?? [];
  const projectHandlers = ProjectsRpcs.toLayer({
    'Projects.list': () => Effect.succeed(projectList),
    'Projects.add': () =>
      Effect.sync(() => {
        options.onAddProject?.();
        return null;
      }),
    'Projects.rename': (payload) =>
      Effect.sync(() => {
        options.projectRenamed?.push(payload);
        const existing = projectList.find((p) => p.id === payload.id) ?? app;
        return { ...existing, name: payload.name };
      }),
    'Projects.remove': () => Effect.die('unused'),
    'Projects.locate': () => Effect.die('unused'),
    'Projects.addFolder': () => Effect.die('unused'),
    'Projects.locateFolder': () => Effect.die('unused'),
    'Projects.check': () => Effect.die('unused'),
    'Projects.setSettings': () => Effect.die('unused'),
  });
  const sessionHandlers = SessionsRpcs.toLayer({
    'Session.changes': () => options.changes ?? Stream.empty,
    'Session.list': ({ projectId }) =>
      Effect.succeed(sessionsForProject(options.sessionsByProject, projectId, docsList)),
    'Session.create': () => Effect.die('unused'),
    'Session.setAgent': () => Effect.die('unused'),
    'Session.prompt': () => Effect.die('unused'),
    'Session.steer': () => Effect.die('unused'),
    'Session.enqueue': () => Effect.die('unused'),
    'Session.setQueue': () => Effect.die('unused'),
    'Session.clearQueue': () => Effect.die('unused'),
    'Session.rename': (payload) =>
      Effect.sync(() => {
        renamed.push(payload);
      }),
    'Session.openAgentLog': () => Effect.void,
    'Session.retryAgent': () => Effect.void,
    'Session.loginAgent': () => Effect.void,
    'Session.cancel': () => Effect.die('unused'),
    'Session.stopAgent': () => Effect.die('unused'),
    'Session.setOption': () => Effect.die('unused'),
    'Session.clearContext': () => Effect.die('unused'),
    'Session.compact': () => Effect.die('unused'),
    'Session.startEmptyContext': () => Effect.die('unused'),
    'Session.prepareHandoff': () => Effect.die('unused'),
    'Session.revalidateHandoff': () => Effect.die('unused'),
    'Session.executeHandoff': () => Effect.die('unused'),
    'Session.listHandoffAttempts': () => Effect.die('unused'),
    'Session.archive': ({ sessionId }) =>
      Effect.sync(() => {
        options.archived?.push(sessionId);
      }),
    'Session.unarchive': () => Effect.void,
    'Session.countWorkers': () => Effect.die('unused'),
    'Session.delete': () => Effect.die('unused'),
    'Session.answerPermission': () => Effect.die('unused'),
    'Session.events': () => Stream.die('unused'),
    'Session.getComposer': () => Effect.die('unused'),
    'Session.setComposer': () => Effect.die('unused'),
  });
  const base = Layer.mergeAll(
    projectHandlers,
    sessionHandlers,
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
      'Tabs.update': () => Effect.void,
      'Tabs.setVisibility': () => Effect.void,
      'Tabs.activations': () => Stream.empty,
    }),
    AgentsRpcs.toLayer({
      'Agents.list': () => Effect.succeed([agent]),
      'Agents.install': () => Stream.die('unused'),
      'Agents.cancelInstall': () => Effect.die('unused'),
      'Agents.installStatus': () => Effect.die('unused'),
      'Agents.openInstallLog': () => Effect.die('unused'),
    }),
  );
  if (options.projectOrder === undefined) {
    return base;
  }
  return Layer.mergeAll(
    base,
    SettingsRpcs.toLayer({
      'Settings.get': () => Effect.succeed(currentSettings),
      'Settings.update': ({ patch }) =>
        Effect.sync(() => {
          currentSettings = applyPatch(currentSettings, patch);
          return currentSettings;
        }),
    }),
  );
};

/** Mounts the sidebar; with `projectOrder`, Settings serves that Project order (otherwise Settings.get dies). */
const mount = (projectOrder?: ProjectOrder | MountOptions): Fixture => {
  const options: MountOptions =
    projectOrder === undefined ? {} : 'by' in projectOrder ? { projectOrder } : projectOrder;
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(makeLayer(options)) },
      { provide: KEYMAP_PLATFORM, useValue: options.platform ?? 'other' },
    ],
  });
  return TestBed.createComponent(AppSidebar);
};

/** Searches the whole document: the Project switcher's menu opens in an overlay outside the component. */
const all = (fixture: Fixture, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const texts = (fixture: Fixture, testId: string): string[] =>
  all(fixture, testId).map((element) => element.textContent?.trim() ?? '');

const one = (fixture: Fixture, testId: string): HTMLElement => {
  const element = all(fixture, testId)[0];
  if (element === undefined) throw new Error(`no ${testId}`);
  return element;
};

const click = (fixture: Fixture, testId: string, index = 0): void => {
  const element = all(fixture, testId)[index];
  if (element === undefined) throw new Error(`no ${testId} #${index}`);
  element.click();
  fixture.detectChanges();
};

const search = (fixture: Fixture, query: string): void => {
  const input = one(fixture, 'session-search') as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
};

const titles = (fixture: Fixture): string[] => texts(fixture, 'session-title');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
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
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('AppSidebar', () => {
  it('shows the most recently used Project and groups its Sessions by day, newest first', async () => {
    const fixture = mount();
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    expect(one(fixture, 'current-project').textContent).toContain('app');
    expect(one(fixture, 'current-project').textContent).toContain('/work/app');
    expect(texts(fixture, 'session-group')).toEqual(['Today', 'Earlier']);
    expect(titles(fixture)).toEqual([
      'Fix the login form',
      'Write release notes',
      'Add login with GitHub',
      'Upgrade Angular',
      'Set up CI',
    ]);
    expect(texts(fixture, 'session-age')[0]).toBe('5h');
    expect(all(fixture, 'session-meta')).toHaveLength(0);
  });

  it('searches this Project by title', async () => {
    const fixture = mount();
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    search(fixture, 'LOGIN');
    expect(titles(fixture)).toEqual(['Fix the login form', 'Add login with GitHub']);
    expect(texts(fixture, 'session-group')).toEqual(['Today', 'Earlier']);

    search(fixture, 'nothing like this');
    expect(titles(fixture)).toEqual([]);
    expect(one(fixture, 'sessions-empty').textContent?.trim()).toBe('No Sessions match.');

    search(fixture, '');
    expect(titles(fixture)).toHaveLength(5);
  });

  it('lists Projects by last use in the switcher, and picking one shows its Sessions', async () => {
    const fixture = mount();
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'current-project');
    expect(texts(fixture, 'project-option-name')).toEqual(['app', 'api', 'docs']);
    expect(
      all(fixture, 'project-option')[1]?.querySelector('[data-testid="folder-missing"]'),
    ).not.toBeNull();

    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits']));
    expect(one(fixture, 'current-project').textContent).toContain('Folder missing');

    click(fixture, 'current-project');
    click(fixture, 'project-option', 2);
    await vi.waitFor(() =>
      expect(one(fixture, 'sessions-empty').textContent?.trim()).toBe('No Sessions in docs yet.'),
    );
  });

  it('lists Projects in the Project order Setting, still opening on the last used one', async () => {
    const fixture = mount({ by: 'name', direction: 'asc' });
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));
    expect(one(fixture, 'current-project').textContent).toContain('/work/app');

    click(fixture, 'current-project');
    await vi.waitFor(() =>
      expect(texts(fixture, 'project-option-name')).toEqual(['api', 'app', 'docs']),
    );
  });

  it('starts a draft without a row in the list, and follows the active Tab to its Project', async () => {
    const fixture = mount();
    const tabs = TestBed.inject(Tabs);
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'new-session');
    expect(all(fixture, 'draft-row')).toHaveLength(0);
    expect(tabs.active()?.session).toBeNull();
    expect(tabs.active()?.projectId).toBe(app.id);

    click(fixture, 'session-row', 0);
    expect(tabs.active()?.title).toBe('Fix the login form');

    click(fixture, 'current-project');
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits']));
    expect(all(fixture, 'draft-row')).toHaveLength(0);

    const draft = tabs.draftOf(app.id);
    expect(draft).not.toBeNull();
    if (draft !== null) tabs.activateTab(draft.id);
    await vi.waitFor(() =>
      expect(one(fixture, 'current-project').textContent).toContain('/work/app'),
    );
    expect(one(fixture, 'current-project').textContent).toContain('/work/app');

    if (draft !== null) tabs.closeTab(draft.id);
    expect(all(fixture, 'draft-row')).toHaveLength(0);
  });

  it('renames inline via double-click or F2, cancels on Esc, and opens untitled Sessions as null Tab title', async () => {
    const renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [];
    const fixture = mount({ renamed, docsList: docsSessions });
    const tabs = TestBed.inject(Tabs);
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    // Double-click, edit, Esc cancels without saving.
    one(fixture, 'session-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const escEditor = one(fixture, 'session-rename') as HTMLInputElement;
    escEditor.value = 'Discarded';
    escEditor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(all(fixture, 'session-rename')).toHaveLength(0);
    expect(renamed).toEqual([]);

    // F2 starts rename; blur saves.
    one(fixture, 'session-row').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true }),
    );
    fixture.detectChanges();
    const blurEditor = one(fixture, 'session-rename') as HTMLInputElement;
    blurEditor.value = 'Renamed via blur';
    blurEditor.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(renamed).toEqual([{ sessionId: SessionId.make('today'), title: 'Renamed via blur' }]);

    // Untitled row shows muted "New Session", opens with null Tab title, and starts rename empty.
    click(fixture, 'current-project');
    click(fixture, 'project-option', 2);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['New Session', '2 Images']));
    expect(one(fixture, 'session-title').classList.contains('text-muted-foreground')).toBe(true);
    click(fixture, 'session-row', 0);
    expect(tabs.active()?.title).toBeNull();
    one(fixture, 'session-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const untitledEditor = one(fixture, 'session-rename') as HTMLInputElement;
    expect(untitledEditor.value).toBe('');
    untitledEditor.dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(renamed).toHaveLength(1);
  });
});

@Component({
  selector: 'app-test-shell-host',
  imports: [AppSidebar, PanelHeader, SessionConfirmDialog, HlmToasterImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sidebar />
    @if (tabs.focusedPanel(); as panel) {
      @if (tabs.activeProjectId(); as projectId) {
        <app-panel-header [panel]="panel" [projectId]="projectId" [focused]="true" />
      }
    }
    <app-session-confirm-dialog />
    <hlm-toaster theme="system" />
  `,
})
class TestShellHost {
  protected readonly tabs = inject(Tabs);
}

interface ShellControls {
  readonly fixture: ComponentFixture<TestShellHost>;
  readonly archived: SessionId[];
  readonly unarchived: SessionId[];
  readonly deleted: SessionId[];
  readonly cancelled: SessionId[];
  readonly renamed: Array<{ readonly id: ProjectId; readonly name: string }>;
  readonly sessionRenamed: Array<{ readonly id: SessionId; readonly title: string }>;
  readonly located: ProjectId[];
  readonly removed: ProjectId[];
  readonly running: Set<SessionId>;
  readonly failArchive: Set<SessionId>;
  readonly failDelete: Set<SessionId>;
}

const mountShell = (): ShellControls => {
  const store = new Map<ProjectId, SessionSummary[]>([
    [app.id, appSessions.map((s) => ({ ...s }))],
    [api.id, apiSessions.map((s) => ({ ...s }))],
    [docs.id, []],
  ]);
  let projectList: Project[] = [docs, api, app];
  const archived: SessionId[] = [];
  const unarchived: SessionId[] = [];
  const deleted: SessionId[] = [];
  const cancelled: SessionId[] = [];
  const renamed: Array<{ readonly id: ProjectId; readonly name: string }> = [];
  const sessionRenamed: Array<{ readonly id: SessionId; readonly title: string }> = [];
  const located: ProjectId[] = [];
  const removed: ProjectId[] = [];
  const running = new Set<SessionId>();
  const failArchive = new Set<SessionId>();
  const failDelete = new Set<SessionId>();

  const findSession = (id: SessionId) => {
    for (const [projectId, items] of store) {
      const idx = items.findIndex((s) => s.id === id);
      if (idx !== -1) return { projectId, items, idx, item: items[idx] };
    }
    return undefined;
  };

  const layer = Layer.mergeAll(
    ProjectsRpcs.toLayer({
      'Projects.list': () => Effect.succeed(projectList),
      'Projects.add': () => Effect.succeed(null),
      'Projects.rename': ({ id, name }) =>
        Effect.sync(() => {
          renamed.push({ id, name });
          const nextName = name.trim() || id;
          projectList = projectList.map((p) => (p.id === id ? { ...p, name: nextName } : p));
          return projectList.find((p) => p.id === id) ?? app;
        }),
      'Projects.remove': ({ id }) =>
        Effect.sync(() => {
          removed.push(id);
          projectList = projectList.filter((p) => p.id !== id);
        }),
      'Projects.locate': ({ id }) =>
        Effect.sync(() => {
          located.push(id);
          projectList = projectList.map((p) => (p.id === id ? { ...p, folderMissing: false } : p));
          return projectList.find((p) => p.id === id) ?? null;
        }),
      'Projects.addFolder': () => Effect.die('unused'),
      'Projects.locateFolder': () => Effect.die('unused'),
      'Projects.check': () => Effect.die('unused'),
      'Projects.setSettings': () => Effect.die('unused'),
    }),
    SessionsRpcs.toLayer({
      'Session.list': ({ projectId }) => Effect.succeed(store.get(projectId) ?? []),
      'Session.create': () => Effect.die('unused'),
      'Session.setAgent': () => Effect.die('unused'),
      'Session.prompt': () => Effect.die('unused'),
      'Session.steer': () => Effect.die('unused'),
      'Session.enqueue': () => Effect.die('unused'),
      'Session.setQueue': () => Effect.die('unused'),
      'Session.clearQueue': () => Effect.die('unused'),
      'Session.rename': (payload) =>
        Effect.sync(() => {
          sessionRenamed.push({ id: payload.sessionId, title: payload.title });
        }),
      'Session.openAgentLog': () => Effect.void,
      'Session.retryAgent': () => Effect.void,
      'Session.loginAgent': () => Effect.void,
      'Session.cancel': ({ sessionId }) =>
        Effect.sync(() => {
          cancelled.push(sessionId);
          running.delete(sessionId);
        }),
      'Session.stopAgent': () => Effect.die('unused'),
      'Session.setOption': () => Effect.die('unused'),
      'Session.clearContext': () => Effect.die('unused'),
      'Session.compact': () => Effect.die('unused'),
      'Session.startEmptyContext': () => Effect.die('unused'),
      'Session.prepareHandoff': () => Effect.die('unused'),
      'Session.revalidateHandoff': () => Effect.die('unused'),
      'Session.executeHandoff': () => Effect.die('unused'),
      'Session.listHandoffAttempts': () => Effect.die('unused'),
      'Session.archive': ({ sessionId }) =>
        failArchive.has(sessionId)
          ? Effect.fail(new SessionError({ reason: 'NotFound', detail: 'fail archive' }))
          : Effect.sync(() => {
              archived.push(sessionId);
              const found = findSession(sessionId);
              if (found?.item !== undefined) {
                found.items[found.idx] = { ...found.item, archivedAt: NOW };
              }
            }),
      'Session.unarchive': ({ sessionId }) =>
        Effect.sync(() => {
          unarchived.push(sessionId);
          const found = findSession(sessionId);
          if (found?.item !== undefined) {
            const { archivedAt: _a, ...rest } = found.item;
            found.items[found.idx] = rest;
          }
        }),
      'Session.countWorkers': () => Effect.succeed(0),
      'Session.delete': ({ sessionId }) =>
        failDelete.has(sessionId)
          ? Effect.fail(new SessionError({ reason: 'NotFound', detail: 'fail delete' }))
          : Effect.sync(() => {
              deleted.push(sessionId);
              const found = findSession(sessionId);
              if (found !== undefined) {
                found.items.splice(found.idx, 1);
              }
            }),
      'Session.answerPermission': () => Effect.die('unused'),
      'Session.events': ({ sessionId }) =>
        Stream.fromIterable([
          {
            _tag: 'Live' as const,
            state: {
              agentStatus: 'ready' as const,
              status: running.has(sessionId) ? ('working' as const) : ('idle' as const),
              title: findSession(sessionId)?.item?.title ?? { auto: 's', autoIsPlaceholder: false },
              options: { permissionMode: PermissionMode.make('auto') },
              commands: [],
              commandsLoaded: true,
              queue: [],
              canAttachImages: false,
              imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
              agentName: 'Claude',
              ...(running.has(sessionId) ? { runningTurn: TurnId.make('t1') } : {}),
            },
          },
        ]),
      'Session.changes': () => Stream.empty,
      'Session.getComposer': () => Effect.die('unused'),
      'Session.setComposer': () => Effect.die('unused'),
    }),
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ workspace: EMPTY_WORKSPACE, sessions: [] }),
      'Tabs.update': () => Effect.void,
      'Tabs.setVisibility': () => Effect.void,
      'Tabs.activations': () => Stream.empty,
    }),
  );

  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(layer) }],
  });
  const fixture = TestBed.createComponent(TestShellHost);
  return {
    fixture,
    archived,
    unarchived,
    deleted,
    cancelled,
    renamed,
    sessionRenamed,
    located,
    removed,
    running,
    failArchive,
    failDelete,
  };
};

const docAll = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const docOne = (fixture: ComponentFixture<unknown>, testId: string): HTMLElement => {
  const el = docAll(fixture, testId)[0];
  if (el === undefined) throw new Error(`no ${testId}`);
  return el;
};

const rightClick = (fixture: ComponentFixture<unknown>, el: HTMLElement): void => {
  el.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 20,
      clientY: 20,
    }),
  );
  fixture.detectChanges();
};

const clickRow = (
  fixture: ComponentFixture<unknown>,
  index: number,
  mods: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean } = {},
): void => {
  const row = docAll(fixture, 'session-row')[index];
  if (row === undefined) throw new Error(`no session-row #${index}`);
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));
  fixture.detectChanges();
};

const waitTitles = async (fixture: ComponentFixture<unknown>, expected: number) =>
  vi.waitFor(() => expect(docAll(fixture, 'session-title')).toHaveLength(expected));

describe('AppSidebar Archive, Delete, Multi-select & Context Menus', () => {
  it('shows the Archived fold collapsed by default and expands muted archived rows on click', async () => {
    const { fixture } = mountShell();
    await waitTitles(fixture, 5);

    const fold = docOne(fixture, 'archived-fold');
    expect(fold.textContent?.replace(/\s+/g, ' ').trim()).toBe('Archived (1)');
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    expect(docAll(fixture, 'archived-list')).toHaveLength(0);

    fold.click();
    fixture.detectChanges();
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    const rows = docAll(fixture, 'session-row');
    expect(rows).toHaveLength(6);
    const archivedRow = rows.find((r) => r.getAttribute('data-archived') === 'true');
    expect(archivedRow?.textContent).toContain('Old spike');
    expect(archivedRow?.querySelector('[data-testid="session-title"]')?.className).toContain(
      'text-muted-foreground',
    );
  });

  it('supports Ctrl/Cmd-click toggle, Shift-click range, and Escape clear with distinct selection styling', async () => {
    const { fixture } = mountShell();
    const tabs = TestBed.inject(Tabs);
    await waitTitles(fixture, 5);

    // Open row 0 (becomes active row).
    clickRow(fixture, 0);
    expect(tabs.active()?.session).toBe(SessionId.make('today'));
    expect(docAll(fixture, 'session-row')[0]?.className).toContain('bg-sidebar-accent');

    // Ctrl-click row 1 and Cmd-click row 3: toggled without changing active Tab.
    clickRow(fixture, 1, { ctrlKey: true });
    clickRow(fixture, 3, { metaKey: true });
    expect(tabs.active()?.session).toBe(SessionId.make('today'));
    let selected = docAll(fixture, 'session-row').filter(
      (r) => r.getAttribute('data-selected') === 'true',
    );
    expect(selected.map((r) => r.getAttribute('data-session-id'))).toEqual(['yesterday', 'month']);
    expect(selected[0]?.className).toContain('bg-primary/15');
    expect(selected[0]?.className).toContain('ring-primary/40');

    // Ctrl-click row 1 again unselects it.
    clickRow(fixture, 1, { ctrlKey: true });
    selected = docAll(fixture, 'session-row').filter(
      (r) => r.getAttribute('data-selected') === 'true',
    );
    expect(selected.map((r) => r.getAttribute('data-session-id'))).toEqual(['month']);

    // Shift-click row 1 selects range [yesterday..month] (indices 1..3).
    clickRow(fixture, 1, { shiftKey: true });
    selected = docAll(fixture, 'session-row').filter(
      (r) => r.getAttribute('data-selected') === 'true',
    );
    expect(selected.map((r) => r.getAttribute('data-session-id'))).toEqual([
      'yesterday',
      'week',
      'month',
    ]);

    // Escape clears selection.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    selected = docAll(fixture, 'session-row').filter(
      (r) => r.getAttribute('data-selected') === 'true',
    );
    expect(selected).toHaveLength(0);
  });

  it('archives immediately with Undo toast, confirms when a Turn is running, and closes the Tab', async () => {
    const { fixture, archived, unarchived, running } = mountShell();
    const tabs = TestBed.inject(Tabs);
    await waitTitles(fixture, 5);

    // Open row 0 in a Tab and archive it while idle.
    clickRow(fixture, 0);
    expect(tabs.isOpen(SessionId.make('today'))).toBe(true);

    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    expect(docOne(fixture, 'menu-rename').hasAttribute('disabled')).toBe(false);
    docOne(fixture, 'menu-archive').click();
    await vi.waitFor(() => expect(archived).toEqual([SessionId.make('today')]));
    expect(tabs.isOpen(SessionId.make('today'))).toBe(false);
    await waitTitles(fixture, 4);

    // Toast with Undo button restores it.
    const toastAction = await vi.waitFor(() => {
      fixture.detectChanges();
      const btn = [...document.querySelectorAll<HTMLButtonElement>('hlm-toaster button')].find(
        (b) => b.textContent?.trim() === 'Undo',
      );
      if (btn === undefined) throw new Error('no toast Undo button');
      return btn;
    });
    expect(document.body.textContent).toContain('Archived Fix the login form');
    toastAction.click();
    await vi.waitFor(() => expect(unarchived).toEqual([SessionId.make('today')]));
    await waitTitles(fixture, 5);

    // Archiving a Session with a running Turn prompts alert-dialog first.
    running.add(SessionId.make('yesterday'));
    rightClick(fixture, docAll(fixture, 'session-row')[1]!);
    docOne(fixture, 'menu-archive').click();
    const title = await vi.waitFor(() => docOne(fixture, 'confirm-title'));
    expect(title.textContent?.trim()).toBe('Archive "Write release notes"?');
    expect(docOne(fixture, 'confirm-description').textContent).toContain('running');

    // Cancel keeps it unarchived.
    docOne(fixture, 'confirm-cancel').click();
    fixture.detectChanges();
    expect(archived).toHaveLength(1);

    // Confirm archives it.
    rightClick(fixture, docAll(fixture, 'session-row')[1]!);
    docOne(fixture, 'menu-archive').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(archived).toContain(SessionId.make('yesterday')));
    await waitTitles(fixture, 4);
  });

  it('deletes after alert-dialog promising "removed from Spence" and noting a running Turn', async () => {
    const { fixture, deleted, running } = mountShell();
    const tabs = TestBed.inject(Tabs);
    await waitTitles(fixture, 5);

    clickRow(fixture, 0);
    running.add(SessionId.make('today'));
    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    docOne(fixture, 'menu-delete').click();

    const desc = await vi.waitFor(() => docOne(fixture, 'confirm-description'));
    expect(desc.textContent).toContain('removed from Spence');
    expect(desc.textContent).not.toContain('erased from the Agent');
    expect(desc.textContent).toContain('running Turn will be stopped');

    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(deleted).toEqual([SessionId.make('today')]));
    await vi.waitFor(() => expect(tabs.isOpen(SessionId.make('today'))).toBe(false));
    await waitTitles(fixture, 4);
  });

  it('acts on multi-select bulk menu, shows one confirm/toast, and counts partial failures without stopping the rest', async () => {
    const toastError = vi.spyOn(toast, 'error');
    const { fixture, archived, deleted, running, failArchive, failDelete } = mountShell();
    await waitTitles(fixture, 5);

    clickRow(fixture, 0, { ctrlKey: true });
    clickRow(fixture, 1, { ctrlKey: true });
    clickRow(fixture, 2, { ctrlKey: true });
    running.add(SessionId.make('today'));
    failArchive.add(SessionId.make('week'));

    // Right-clicking inside selection shows ONLY Archive N / Delete N...
    rightClick(fixture, docAll(fixture, 'session-row')[1]!);
    expect(docAll(fixture, 'menu-open')).toHaveLength(0);
    expect(docAll(fixture, 'menu-rename')).toHaveLength(0);
    expect(docOne(fixture, 'menu-archive-bulk').textContent?.trim()).toBe('Archive 3');
    expect(docOne(fixture, 'menu-delete-bulk').textContent?.trim()).toBe('Delete 3…');

    docOne(fixture, 'menu-archive-bulk').click();
    const desc = await vi.waitFor(() => docOne(fixture, 'confirm-description'));
    expect(desc.textContent).toContain('1 Turn is still running');
    docOne(fixture, 'confirm-action').click();

    await vi.waitFor(() =>
      expect(archived).toEqual([SessionId.make('today'), SessionId.make('yesterday')]),
    );
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not archive 1 Session.'));
    await waitTitles(fixture, 3);

    // Bulk delete with partial failure.
    clickRow(fixture, 0, { ctrlKey: true });
    clickRow(fixture, 1, { ctrlKey: true });
    failDelete.add(SessionId.make('week'));
    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    docOne(fixture, 'menu-delete-bulk').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();

    await vi.waitFor(() => expect(deleted).toEqual([SessionId.make('month')]));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith('Could not delete 1 Session.'));
    await waitTitles(fixture, 2);
  });

  it('supports Archived fold menu (Unarchive all / Delete all), Project context menu, and the Panel header Session menu', async () => {
    const { fixture, unarchived, deleted, renamed, located, removed, cancelled, running } =
      mountShell();
    const settings = TestBed.inject(SettingsState);
    await waitTitles(fixture, 5);

    // Archived fold menu: Unarchive all (1)
    rightClick(fixture, docOne(fixture, 'archived-fold'));
    docOne(fixture, 'archived-menu-unarchive-all').click();
    await vi.waitFor(() => expect(unarchived).toEqual([SessionId.make('archived')]));
    await waitTitles(fixture, 6);

    // Panel header Session actions: open row 0, then Delete… from the ⋯ menu.
    clickRow(fixture, 0);
    expect(docOne(fixture, 'panel-title').textContent?.trim()).toBe('Fix the login form');
    docOne(fixture, 'session-actions-trigger').click();
    docOne(fixture, 'menu-delete').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(deleted).toEqual([SessionId.make('today')]));
    await vi.waitFor(() => expect(docAll(fixture, 'session-actions-trigger')).toHaveLength(0));

    // Project menu: Project settings, Rename, Remove Project (with running Turn confirm)
    rightClick(fixture, docOne(fixture, 'current-project'));
    expect(docAll(fixture, 'project-menu-locate')).toHaveLength(0);
    docOne(fixture, 'project-menu-settings').click();
    expect(settings.open()).toBe(true);
    expect(settings.projectId()).toBe(app.id);
    settings.set(false);

    rightClick(fixture, docOne(fixture, 'current-project'));
    docOne(fixture, 'project-menu-rename').click();
    const input = docOne(fixture, 'project-rename-input') as HTMLInputElement;
    input.value = 'web-app';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(renamed).toEqual([{ id: app.id, name: 'web-app' }]));

    // Project menu: Archive all (5), then Archived fold: Delete all (5)...
    rightClick(fixture, docOne(fixture, 'current-project'));
    expect(docOne(fixture, 'project-menu-archive-all').textContent?.trim()).toBe('Archive all (5)');
    docOne(fixture, 'project-menu-archive-all').click();
    await waitTitles(fixture, 0);
    expect(docOne(fixture, 'archived-fold').textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Archived (5)',
    );

    rightClick(fixture, docOne(fixture, 'archived-fold'));
    expect(docOne(fixture, 'archived-menu-delete-all').textContent?.trim()).toBe('Delete all (5)…');
    docOne(fixture, 'archived-menu-delete-all').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(deleted).toHaveLength(6));
    await vi.waitFor(() => expect(docAll(fixture, 'archived-fold')).toHaveLength(0));

    // Switch to api (folderMissing = true) -> Locate folder... appears in Project menu
    docOne(fixture, 'current-project').click();
    docAll(fixture, 'project-option')[1]!.click();
    await waitTitles(fixture, 1);

    rightClick(fixture, docOne(fixture, 'current-project'));
    docOne(fixture, 'project-menu-locate').click();
    await vi.waitFor(() => expect(located).toEqual([api.id]));
    await vi.waitFor(() =>
      expect(docOne(fixture, 'current-project').textContent).not.toContain('Folder missing'),
    );

    // Remove Project when a Turn runs -> confirms, cancels running Turn, removes Project
    running.add(SessionId.make('renamed'));
    rightClick(fixture, docOne(fixture, 'current-project'));
    expect(docAll(fixture, 'project-menu-locate')).toHaveLength(0);
    docOne(fixture, 'project-menu-remove').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(removed).toEqual([api.id]));
    expect(cancelled).toEqual([SessionId.make('renamed')]);
  });

  it('pins Attention Sessions under Needs you, reflects cause in meta, and updates live from Session.changes', async () => {
    const changes = Effect.runSync(PubSub.unbounded<SessionChange>());
    const sessionsByProject = new Map<ProjectId, ReadonlyArray<SessionSummary>>([
      [
        app.id,
        [
          { ...session('today', 'Fix the login form', at(10, 12, 10)) },
          {
            ...session('yesterday', 'Write release notes', at(10, 11, 18)),
            status: 'blocked',
          },
          { ...session('week', 'Add login with GitHub', at(10, 8)), status: 'error' },
        ],
      ],
      [api.id, apiSessions],
    ]);
    const fixture = mount({ changes: Stream.fromPubSub(changes), sessionsByProject });
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(3));

    expect(texts(fixture, 'session-group')).toEqual(['Needs you', 'Today']);
    expect(titles(fixture)).toEqual([
      'Write release notes',
      'Add login with GitHub',
      'Fix the login form',
    ]);
    expect(texts(fixture, 'session-meta')).toEqual(['Waiting', 'Error']);
    expect(texts(fixture, 'session-age')).toEqual(['5h']);

    // Live clear of blocked status moves the session back to its day group; starting a Turn shows working mark.
    Effect.runSync(
      PubSub.publish(changes, {
        sessionId: SessionId.make('yesterday'),
        projectId: app.id,
        state: liveState({
          status: 'working',
          title: { auto: 'Write release notes', autoIsPlaceholder: false },
          runningTurn: TurnId.make('t1'),
        }),
      }),
    );
    await vi.waitFor(() => expect(all(fixture, 'status-working')).toHaveLength(1));
    expect(texts(fixture, 'session-group')).toEqual(['Needs you', 'Today']);
    expect(titles(fixture)).toEqual([
      'Add login with GitHub',
      'Write release notes',
      'Fix the login form',
    ]);
  });

  it('keeps working Sidebar rows calm and reveals live activity and blockedTarget in hover tooltips', async () => {
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
      const baseNow = at(10, 12, 30);
      vi.setSystemTime(baseNow);
      const changes = Effect.runSync(PubSub.unbounded<SessionChange>());
      const parentId = SessionId.make('today');
      const workerId = SessionId.make('worker-1');
      const sessionsByProject = new Map<ProjectId, ReadonlyArray<SessionSummary>>([
        [
          app.id,
          [
            {
              ...session('today', 'Fix the login form', at(10, 12, 10)),
              status: 'working',
              activity: { kind: 'execute', target: 'npm test', startedAt: baseNow - 14_000 },
              workers: [
                {
                  sessionId: workerId,
                  parentSessionId: parentId,
                  title: 'Push release branch',
                  state: 'requiresAction',
                  blockedTarget: 'git push',
                },
              ],
            },
          ],
        ],
        [api.id, apiSessions],
      ]);
      const fixture = mount({ changes: Stream.fromPubSub(changes), sessionsByProject });
      await vi.waitFor(() => expect(titles(fixture)).toEqual(['Fix the login form']));

      // Working row stays single-line with colored mark and no running-command prose.
      expect(all(fixture, 'session-meta')).toHaveLength(0);
      expect(one(fixture, 'session-row').textContent).not.toContain('npm test');
      expect(texts(fixture, 'sidebar-worker-status')).toEqual(['Waiting']);

      // Hover Session row -> shows full title + live micro-status + ticks locally.
      const row = one(fixture, 'session-row');
      hoverIn(row);
      fixture.detectChanges();
      await vi.waitFor(() => {
        const tip = document.querySelector('[role="tooltip"]');
        expect(tip?.textContent).toContain('Fix the login form');
        expect(tip?.textContent).toContain('running npm test · 14s');
      });
      vi.advanceTimersByTime(1000);
      fixture.detectChanges();
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
        'running npm test · 15s',
      );
      hoverOut(row);
      fixture.detectChanges();

      // Live Session.changes update changes tooltip micro-status to writing.
      Effect.runSync(
        PubSub.publish(changes, {
          sessionId: parentId,
          projectId: app.id,
          state: liveState({
            title: { auto: 'Fix the login form', autoIsPlaceholder: false },
            runningTurn: TurnId.make('t1'),
            activity: { kind: 'writing', target: '', startedAt: baseNow - 2_000 },
          }),
        }),
      );
      await vi.waitFor(() => {
        hoverIn(row);
        fixture.detectChanges();
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('writing · 3s');
      });
      hoverOut(row);
      fixture.detectChanges();

      // Hover nested Worker row -> shows full title + waiting for permission: git push.
      const workerRow = one(fixture, 'sidebar-worker-row');
      hoverIn(workerRow);
      fixture.detectChanges();
      await vi.waitFor(() => {
        const tip = document.querySelector('[role="tooltip"]');
        expect(tip?.textContent).toContain('Push release branch');
        expect(tip?.textContent).toContain('waiting for permission: git push');
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the other-project attention dot and per-project marks in the Project switcher', async () => {
    const changes = Effect.runSync(PubSub.unbounded<SessionChange>());
    const sessionsByProject = new Map<ProjectId, ReadonlyArray<SessionSummary>>([
      [app.id, [session('today', 'Fix the login form', at(10, 12, 10))]],
      [
        api.id,
        [
          {
            ...session('renamed', 'Rate limits', at(10, 12, 14)),
            status: 'blocked',
          },
          {
            ...session('api-working', 'Running check', at(10, 12, 12)),
            status: 'working',
          },
        ],
      ],
      [docs.id, [{ ...session('doc1', 'Write docs', at(10, 1, 10)), status: 'working' }]],
    ]);
    const fixture = mount({ changes: Stream.fromPubSub(changes), sessionsByProject });
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(1));

    await vi.waitFor(() => expect(all(fixture, 'other-project-attention')).toHaveLength(1));

    // Open switcher menu: api aggregates blocked > working, docs has working, app has idle.
    click(fixture, 'current-project');
    const options = all(fixture, 'project-option');
    expect(options[1]?.querySelector('[data-testid="status-blocked"]')).not.toBeNull();
    expect(options[1]?.querySelector('[data-testid="status-working"]')).toBeNull();
    expect(options[2]?.querySelector('[data-testid="status-working"]')).not.toBeNull();
    expect(options[0]?.querySelector('[data-testid="status-blocked"]')).toBeNull();
    expect(options[0]?.querySelector('[data-testid="status-working"]')).toBeNull();

    // Switching to api hides the other-project dot (since only api has attention).
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits', 'Running check']));
    expect(all(fixture, 'other-project-attention')).toHaveLength(0);

    // Background session in app gains error -> other-project dot appears again!
    Effect.runSync(
      PubSub.publish(changes, {
        sessionId: SessionId.make('today'),
        projectId: app.id,
        state: liveState({ status: 'error' }),
      }),
    );
    await vi.waitFor(() => expect(all(fixture, 'other-project-attention')).toHaveLength(1));
  });

  it('renames an archived row inline in One Project layout', async () => {
    const renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [];
    const fixture = mount({ renamed });
    await waitTitles(fixture, 5);

    docOne(fixture, 'archived-fold').click();
    fixture.detectChanges();
    const archivedRow = docAll(fixture, 'session-row').find(
      (r) => r.getAttribute('data-archived') === 'true',
    );
    expect(archivedRow).toBeDefined();
    archivedRow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();

    const editor = docOne(fixture, 'session-rename') as HTMLInputElement;
    editor.value = 'Renamed archive';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();

    await vi.waitFor(() =>
      expect(renamed).toEqual([
        { sessionId: SessionId.make('archived'), title: 'Renamed archive' },
      ]),
    );
  });
});

const pressDoc = (init: KeyboardEventInit, target: EventTarget = document): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...(init.key === 'Escape' ? { keyCode: 27 } : {}),
    ...init,
  });
  target.dispatchEvent(event);
  return event;
};

describe('Panel header', () => {
  const openSession = async (shell: ReturnType<typeof mountShell>): Promise<void> => {
    await waitTitles(shell.fixture, 5);
    clickRow(shell.fixture, 0);
  };

  it('shows the open Session title and offers Rename/Archive/Delete only for a kept Session', async () => {
    const shell = mountShell();
    await waitTitles(shell.fixture, 5);
    expect(docAll(shell.fixture, 'session-actions-trigger')).toHaveLength(0);

    clickRow(shell.fixture, 0);
    expect(docOne(shell.fixture, 'panel-title').textContent?.trim()).toBe('Fix the login form');
    expect(docAll(shell.fixture, 'session-actions-trigger')).toHaveLength(1);
    docOne(shell.fixture, 'session-actions-trigger').click();
    shell.fixture.detectChanges();
    expect(docAll(shell.fixture, 'menu-rename')).toHaveLength(1);
    expect(docAll(shell.fixture, 'menu-archive')).toHaveLength(1);
    expect(docAll(shell.fixture, 'menu-delete')).toHaveLength(1);

    docOne(shell.fixture, 'new-session').click();
    shell.fixture.detectChanges();
    expect(docOne(shell.fixture, 'panel-title').textContent?.trim()).toBe('New Session');
    expect(docAll(shell.fixture, 'session-actions-trigger')).toHaveLength(0);
  });

  it('renames the open Session in place from the ⋯ menu, and cancels on Esc', async () => {
    const shell = mountShell();
    await openSession(shell);

    docOne(shell.fixture, 'session-actions-trigger').click();
    docOne(shell.fixture, 'menu-rename').click();
    const editor = docOne(shell.fixture, 'panel-rename') as HTMLInputElement;
    expect(editor.value).toBe('Fix the login form');
    pressDoc({ key: 'Escape', code: 'Escape' }, editor);
    shell.fixture.detectChanges();
    expect(docAll(shell.fixture, 'panel-rename')).toHaveLength(0);
    expect(shell.sessionRenamed).toEqual([]);

    docOne(shell.fixture, 'session-actions-trigger').click();
    docOne(shell.fixture, 'menu-rename').click();
    const again = docOne(shell.fixture, 'panel-rename') as HTMLInputElement;
    again.value = 'Login form, fixed';
    again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() =>
      expect(shell.sessionRenamed).toEqual([
        { id: SessionId.make('today'), title: 'Login form, fixed' },
      ]),
    );
  });

  it('archives the open Session from the ⋯ menu and closes it', async () => {
    const shell = mountShell();
    const tabs = TestBed.inject(Tabs);
    await openSession(shell);

    docOne(shell.fixture, 'session-actions-trigger').click();
    docOne(shell.fixture, 'menu-archive').click();
    await vi.waitFor(() => expect(shell.archived).toEqual([SessionId.make('today')]));
    expect(tabs.isOpen(SessionId.make('today'))).toBe(false);
  });

  it('lists the Session actions and context the open Session publishes, and runs one', async () => {
    const shell = mountShell();
    const toolbar = TestBed.inject(SessionToolbar);
    await openSession(shell);
    const ran: string[] = [];
    const withdraw = toolbar.publish({
      sessionId: signal('today'),
      context: signal({ label: '82k of 200k · 41%', fraction: 0.41 }),
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
          disabled: true,
          reason: 'A Turn is running.',
        },
        {
          id: 'switch-agent',
          operation: 'Switch Agent',
          label: 'Switch Agent or Model…',
          disabled: false,
        },
      ]),
      run: (operation) => ran.push(operation),
    });

    docOne(shell.fixture, 'session-actions-trigger').click();
    expect(docOne(shell.fixture, 'session-context-label').textContent).toBe('82k of 200k · 41%');
    expect(docAll(shell.fixture, 'session-action-fork')).toHaveLength(0);
    expect(docOne(shell.fixture, 'session-action-clear').hasAttribute('disabled')).toBe(true);
    expect(docOne(shell.fixture, 'session-action-reason').textContent?.trim()).toBe(
      'A Turn is running.',
    );

    docOne(shell.fixture, 'session-action-compact').click();
    expect(ran).toEqual(['Compact']);
    withdraw();
  });

  describe('a Worker Session', () => {
    const workerId = SessionId.make('worker-x');
    const parentId = SessionId.make('today');
    const crumb = (waitingAncestorId: SessionId | null, working = true) => ({
      parentId,
      agentId: 'claude',
      agentName: 'Claude',
      modelName: 'Haiku 5.5',
      working,
      waitingAncestorId,
    });
    const openWorker = async (
      shell: ReturnType<typeof mountShell>,
      worker: ReturnType<typeof crumb>,
    ) => {
      await waitTitles(shell.fixture, 5);
      const tabs = TestBed.inject(Tabs);
      tabs.open({ id: workerId, projectId: app.id, title: 'Test writer' });
      const withdraw = TestBed.inject(SessionToolbar).publish({
        sessionId: signal(workerId),
        worker: signal(worker),
        context: signal({ label: '', fraction: null }),
        actions: signal([]),
        run: () => undefined,
      });
      shell.fixture.detectChanges();
      return withdraw;
    };

    it('shows a Parent Session / Worker breadcrumb, the Agent and Model, and the working state', async () => {
      const shell = mountShell();
      const withdraw = await openWorker(shell, crumb(null));
      expect(docOne(shell.fixture, 'worker-parent-title').textContent?.trim()).toBe(
        'Fix the login form',
      );
      expect(docOne(shell.fixture, 'panel-title').textContent?.trim()).toBe('Test writer');
      expect(docOne(shell.fixture, 'worker-kind').textContent).toContain('Worker · Haiku 5.5');
      expect(docOne(shell.fixture, 'worker-working').textContent).toContain('Working');
      expect(docAll(shell.fixture, 'parent-needs-you')).toHaveLength(0);
      withdraw();
    });

    it('closes the Worker Panel and goes back one level from the Parent crumb', async () => {
      const shell = mountShell();
      const withdraw = await openWorker(shell, crumb(null));
      docOne(shell.fixture, 'worker-parent').click();
      const tabs = TestBed.inject(Tabs);
      expect(tabs.active()?.session).toBe(parentId);
      expect(tabs.isOpen(workerId)).toBe(false);
      withdraw();
    });

    it('shows a Parent needs you pill that links to the waiting Session, without moving the user', async () => {
      const shell = mountShell();
      const withdraw = await openWorker(shell, crumb(SessionId.make('today')));
      expect(TestBed.inject(Tabs).active()?.session).toBe(workerId);
      expect(docOne(shell.fixture, 'parent-needs-you').textContent).toContain('Parent needs you');
      docOne(shell.fixture, 'parent-needs-you').click();
      expect(TestBed.inject(Tabs).active()?.session).toBe(parentId);
      withdraw();
    });

    it('keeps the Parent Session highlighted in the Project list', async () => {
      const shell = mountShell();
      const withdraw = await openWorker(shell, crumb(null));
      TestBed.inject(Tabs).seedLive(workerId, {
        agentStatus: 'ready',
        title: { autoIsPlaceholder: false },
        options: { permissionMode: 'auto' },
        commands: [],
        commandsLoaded: true,
        queue: [],
        canAttachImages: false,
        imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
        parentSessionId: parentId,
        workerKind: 'owned',
      } as never);
      shell.fixture.detectChanges();
      await vi.waitFor(() => {
        const rows = docAll(shell.fixture, 'session-row');
        expect(rows[0]?.className).toContain('bg-sidebar-accent');
        expect(rows).toHaveLength(5);
      });
      withdraw();
    });
  });

  it('opens the Session actions menu on Mod+Shift+K', async () => {
    const shell = mountShell();
    await openSession(shell);
    pressDoc({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true });
    shell.fixture.detectChanges();
    expect(docAll(shell.fixture, 'session-actions-menu')).toHaveLength(1);
  });
});

describe('AppSidebar keyboard shortcuts and Esc layers', () => {
  it('opens a draft Tab in the current Project on Mod+N, or picks a folder when no Project exists', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const tabs = TestBed.inject(Tabs);

    const event = pressDoc({ key: 'n', code: 'KeyN', ctrlKey: true });
    fixture.detectChanges();
    expect(event.defaultPrevented).toBe(true);
    expect(tabs.active()?.projectId).toBe(app.id);
    expect(tabs.active()?.session).toBeNull();

    TestBed.resetTestingModule();
    let adds = 0;
    const emptyFixture = mount({ projects: [], onAddProject: () => (adds += 1) });
    await vi.waitFor(() => expect(all(emptyFixture, 'add-project')).toHaveLength(1));

    pressDoc({ key: 'n', code: 'KeyN', ctrlKey: true });
    emptyFixture.detectChanges();
    expect(adds).toBe(1);
  });

  it('focuses the always-visible Session search with Mod+K; Esc clears it, then leaves it', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const input = one(fixture, 'session-search') as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);

    pressDoc({ key: 'k', code: 'KeyK', ctrlKey: true });
    fixture.detectChanges();
    expect(document.activeElement).toBe(input);

    input.value = 'login';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(titles(fixture)).toEqual(['Fix the login form', 'Add login with GitHub']);

    pressDoc({ key: 'Escape', code: 'Escape' }, input);
    fixture.detectChanges();
    expect(input.value).toBe('');
    expect(titles(fixture)).toHaveLength(5);

    pressDoc({ key: 'Escape', code: 'Escape' }, input);
    fixture.detectChanges();
    expect(document.activeElement).not.toBe(input);
  });

  it('opens the Project switcher on Mod+P', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);

    pressDoc({ key: 'p', code: 'KeyP', ctrlKey: true });
    fixture.detectChanges();
    expect(docAll(fixture, 'project-menu')).toHaveLength(1);
  });

  it('does not steal Esc from stopTurn when the sidebar search is unfocused', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const keymap = TestBed.inject(Keymap);
    let stopTurnCalls = 0;
    const stopReg = keymap.registerEscape({
      layer: 'stopTurn',
      run: () => {
        stopTurnCalls += 1;
      },
    });

    const searchInput = one(fixture, 'session-search') as HTMLInputElement;
    searchInput.value = 'login';
    searchInput.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    // Focus elsewhere: Esc must reach stopTurn and keep the query.
    one(fixture, 'new-session').focus();
    pressDoc({ key: 'Escape', code: 'Escape' }, one(fixture, 'new-session'));
    fixture.detectChanges();
    expect(stopTurnCalls).toBe(1);
    expect(searchInput.value).toBe('login');
    expect(titles(fixture)).toEqual(['Fix the login form', 'Add login with GitHub']);

    // In the search field, Esc clears it and stops propagation before stopTurn.
    searchInput.focus();
    pressDoc({ key: 'Escape', code: 'Escape' }, searchInput);
    fixture.detectChanges();
    expect(stopTurnCalls).toBe(1);
    expect(searchInput.value).toBe('');
    stopReg();
  });

  it('respects Esc layers (rename before selection) and suspends shortcuts while a modal is open', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const keymap = TestBed.inject(Keymap);
    const tabs = TestBed.inject(Tabs);

    // Multi-select + inline rename: first Esc cancels rename and restores focus to row, second Esc clears selection.
    clickRow(fixture, 0, { ctrlKey: true });
    clickRow(fixture, 1, { ctrlKey: true });
    expect(
      all(fixture, 'session-row').filter((r) => r.getAttribute('data-selected') === 'true'),
    ).toHaveLength(2);

    const row0 = all(fixture, 'session-row')[0]!;
    row0.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    fixture.detectChanges();
    const editor = one(fixture, 'session-rename') as HTMLInputElement;
    expect(document.activeElement).toBe(editor);

    pressDoc({ key: 'Escape', code: 'Escape' }, editor);
    fixture.detectChanges();
    expect(all(fixture, 'session-rename')).toHaveLength(0);
    expect(document.activeElement).toBe(all(fixture, 'session-row')[0]);
    expect(
      all(fixture, 'session-row').filter((r) => r.getAttribute('data-selected') === 'true'),
    ).toHaveLength(2);

    pressDoc({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();
    expect(
      all(fixture, 'session-row').filter((r) => r.getAttribute('data-selected') === 'true'),
    ).toHaveLength(0);

    // While a modal is open, Mod+N and selection Esc do not fire.
    clickRow(fixture, 0, { ctrlKey: true });
    const release = keymap.pushModal();
    pressDoc({ key: 'n', code: 'KeyN', ctrlKey: true });
    pressDoc({ key: 'Escape', code: 'Escape' });
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(0);
    expect(
      all(fixture, 'session-row').filter((r) => r.getAttribute('data-selected') === 'true'),
    ).toHaveLength(1);
    release();
  });
});

describe('SessionList roving focus and keyboard actions', () => {
  it('maintains a single roving tabindex=0 stop with focus-visible classes and moves with ArrowUp/ArrowDown without opening', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const tabs = TestBed.inject(Tabs);

    const rows = all(fixture, 'session-row');
    expect(rows.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1']);
    expect(rows[0]?.className).toContain('outline-none');
    expect(rows[0]?.className).toContain('focus-visible:');

    const rowAt = (index: number): HTMLElement => {
      const row = all(fixture, 'session-row')[index];
      if (row === undefined) throw new Error(`missing row ${index}`);
      return row;
    };
    const activeTarget = (): EventTarget => document.activeElement ?? document.body;

    rowAt(0).focus();
    const down = pressDoc({ key: 'ArrowDown', code: 'ArrowDown' }, rowAt(0));
    fixture.detectChanges();
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rowAt(1));
    expect(all(fixture, 'session-row').map((r) => r.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
      '-1',
      '-1',
    ]);
    // Arrow movement must not open the Session.
    expect(tabs.active()).toBeNull();

    pressDoc({ key: 'ArrowUp', code: 'ArrowUp' }, activeTarget());
    fixture.detectChanges();
    expect(document.activeElement).toBe(rowAt(0));

    // Enter opens the focused row.
    (document.activeElement as HTMLElement).click();
    fixture.detectChanges();
    expect(tabs.active()?.session).toBe(SessionId.make('today'));
  });

  it('supports Space toggle, Shift+Arrow range selection, and Mod+A scoped to sidebar', async () => {
    const fixture = mount();
    await waitTitles(fixture, 5);
    const activeTarget = (): EventTarget => document.activeElement ?? document.body;

    const firstRow = one(fixture, 'session-row');
    firstRow.focus();

    // Space toggles selection without opening a Tab.
    const space = pressDoc({ key: ' ', code: 'Space' }, firstRow);
    fixture.detectChanges();
    expect(space.defaultPrevented).toBe(true);
    expect(TestBed.inject(Tabs).active()).toBeNull();
    expect(all(fixture, 'session-row')[0]?.getAttribute('data-selected')).toBe('true');

    // Shift+ArrowDown extends range selection.
    pressDoc({ key: 'ArrowDown', code: 'ArrowDown', shiftKey: true }, activeTarget());
    fixture.detectChanges();
    expect(document.activeElement).toBe(all(fixture, 'session-row')[1]);
    expect(
      all(fixture, 'session-row')
        .filter((r) => r.getAttribute('data-selected') === 'true')
        .map((r) => r.getAttribute('data-session-id')),
    ).toEqual(['today', 'yesterday']);

    // Mod+A selects all visible Sessions in the Project.
    pressDoc({ key: 'a', code: 'KeyA', ctrlKey: true }, activeTarget());
    fixture.detectChanges();
    expect(
      all(fixture, 'session-row').filter((r) => r.getAttribute('data-selected') === 'true'),
    ).toHaveLength(5);
  });

  it('opens context menu on Shift+F10 / ContextMenu, renames on F2 with focus restore, and archives on Delete with Undo toast', async () => {
    const { fixture, archived } = mountShell();
    await waitTitles(fixture, 5);
    const activeTarget = (): EventTarget => document.activeElement ?? document.body;

    const row0 = one(fixture, 'session-row');
    row0.focus();

    // Shift+F10 opens context menu.
    const f10 = pressDoc({ key: 'F10', code: 'F10', shiftKey: true }, row0);
    fixture.detectChanges();
    expect(f10.defaultPrevented).toBe(true);
    expect(docAll(fixture, 'session-context-menu')).toHaveLength(1);

    // Close menu with Esc.
    pressDoc({ key: 'Escape', code: 'Escape' }, activeTarget());
    fixture.detectChanges();
    expect(docAll(fixture, 'session-context-menu')).toHaveLength(0);

    // ContextMenu key also opens context menu.
    const menuKey = pressDoc({ key: 'ContextMenu', code: 'ContextMenu' }, row0);
    fixture.detectChanges();
    expect(menuKey.defaultPrevented).toBe(true);
    expect(docAll(fixture, 'session-context-menu')).toHaveLength(1);
    pressDoc({ key: 'Escape', code: 'Escape' }, activeTarget());
    fixture.detectChanges();
    expect(docAll(fixture, 'session-context-menu')).toHaveLength(0);

    // F2 starts rename; Enter saves and restores focus to row.
    pressDoc({ key: 'F2', code: 'F2' }, row0);
    fixture.detectChanges();
    const editor = one(fixture, 'session-rename') as HTMLInputElement;
    editor.value = 'Renamed via F2';
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(all(fixture, 'session-rename')).toHaveLength(0);
    expect(document.activeElement).toBe(one(fixture, 'session-row'));

    // Delete archives focused row with Undo toast and shifts roving focus to adjacent row.
    pressDoc({ key: 'Delete', code: 'Delete' }, one(fixture, 'session-row'));
    await vi.waitFor(() => expect(archived).toEqual([SessionId.make('today')]));
    const undoBtn = await vi.waitFor(() => {
      fixture.detectChanges();
      const btn = [...document.querySelectorAll<HTMLButtonElement>('hlm-toaster button')].find(
        (candidate) => candidate.textContent?.trim() === 'Undo',
      );
      if (btn === undefined) throw new Error('no Undo toast button');
      return btn;
    });
    expect(undoBtn).toBeDefined();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(document.activeElement).toBe(all(fixture, 'session-row')[0]);
    });
  });
});

describe('Sidebar hints', () => {
  it('shows OS-aware @ui/kbd shortcut hints in tooltips and context menus with font-mono', async () => {
    const fixture = mount({ platform: 'mac' });
    await waitTitles(fixture, 5);

    // Context menu shows Enter, F2, Del with font-mono kbd.
    one(fixture, 'session-row').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    fixture.detectChanges();
    const menu = docOne(fixture, 'session-context-menu');
    const menuKbds = [...menu.querySelectorAll('kbd')];
    expect(menuKbds.map((k) => k.textContent?.trim())).toEqual(['Enter', 'F2', 'Del']);
    for (const kbd of menuKbds) {
      expect(kbd.className).toContain('font-mono');
    }
    pressDoc({ key: 'Escape', code: 'Escape' }, document.activeElement ?? document.body);
    fixture.detectChanges();

    // New Session button tooltip renders OS-aware shortcut (⌘N on mac).
    one(fixture, 'new-session').dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    await vi.waitFor(() =>
      expect(document.querySelector('.cdk-overlay-container kbd')).not.toBeNull(),
    );
    const tipKbd = document.querySelector('.cdk-overlay-container kbd');
    expect(tipKbd?.textContent?.trim()).toBe('⌘N');
    expect(tipKbd?.className).toContain('font-mono');
  });

  it('keeps the picked Project when the active draft Tab attaches or updates without changing Tabs', async () => {
    const fixture = mount();
    const tabs = TestBed.inject(Tabs);
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'new-session');
    const draft = tabs.active();
    expect(draft).not.toBeNull();
    expect(draft?.projectId).toBe(app.id);

    click(fixture, 'current-project');
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(one(fixture, 'current-project').textContent).toContain('api'));

    // Attaching main's Session to the already-active draft updates the Tab without switching Projects.
    expect(draft).not.toBeNull();
    if (draft !== null) tabs.attachDraft(draft.panelId, SessionId.make('attached'));
    fixture.detectChanges();
    expect(one(fixture, 'current-project').textContent).toContain('api');
    expect(tabs.activeProjectId()).toBe(api.id);
  });

  it('syncs Project switching with Tabs without closing background Project Tabs, focuses existing Session Tabs, and toggles Settings', async () => {
    const fixture = mount();
    const tabs = TestBed.inject(Tabs);
    const settings = TestBed.inject(SettingsState);
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'session-row', 0);
    click(fixture, 'session-row', 1);
    expect(tabs.tabs()).toHaveLength(2);
    expect(tabs.active()?.title).toBe('Write release notes');

    // Clicking an already-open Session focuses its existing Tab without duplicating it.
    click(fixture, 'session-row', 0);
    expect(tabs.tabs()).toHaveLength(2);
    expect(tabs.active()?.title).toBe('Fix the login form');

    // Switching to `api` swaps visible Tabs while keeping `app`'s Tabs alive in background.
    click(fixture, 'current-project');
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits']));
    expect(tabs.activeProjectId()).toBe(api.id);
    expect(tabs.tabs()).toHaveLength(0);
    expect(tabs.allTabs()).toHaveLength(2);

    click(fixture, 'session-row', 0);
    expect(tabs.tabs()).toHaveLength(1);
    expect(tabs.active()?.title).toBe('Rate limits');
    expect(tabs.allTabs()).toHaveLength(3);

    // Switching back to `app` restores `app`'s visible Tab strip.
    click(fixture, 'current-project');
    click(fixture, 'project-option', 0);
    await vi.waitFor(() => expect(tabs.activeProjectId()).toBe(app.id));
    expect(tabs.tabs()).toHaveLength(2);

    // Settings button in sidebar toggles Settings on and off.
    click(fixture, 'open-settings');
    expect(settings.open()).toBe(true);
    click(fixture, 'open-settings');
    expect(settings.open()).toBe(false);
  });

  it('offers Open in new Tab and Open in split on single rows, enforces 4-Pane cap & uniqueness, and collapses split Panes on Session deletion', async () => {
    const { fixture, deleted } = mountShell();
    const tabs = TestBed.inject(Tabs);
    await waitTitles(fixture, 5);

    // Multi-select hides Open in new Tab and Open in split.
    clickRow(fixture, 0, { ctrlKey: true });
    clickRow(fixture, 1, { ctrlKey: true });
    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    expect(docAll(fixture, 'menu-open-new-tab')).toHaveLength(0);
    expect(docAll(fixture, 'menu-open-split')).toHaveLength(0);
    pressDoc({ key: 'Escape', code: 'Escape' }, document.activeElement ?? document.body);
    pressDoc({ key: 'Escape', code: 'Escape' }, document.activeElement ?? document.body);
    fixture.detectChanges();

    // Open row 0 via Open in new Tab.
    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    docOne(fixture, 'menu-open-new-tab').click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(1);
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(1);
    expect(tabs.active()?.session).toBe(SessionId.make('today'));

    // Open rows 1, 2, 3 in split inside the same Tab -> 4 Panes.
    for (const rowIndex of [1, 2, 3]) {
      rightClick(fixture, docAll(fixture, 'session-row')[rowIndex]!);
      const splitBtn = docOne(fixture, 'menu-open-split') as HTMLButtonElement;
      expect(splitBtn.disabled).toBe(false);
      splitBtn.click();
      fixture.detectChanges();
    }
    expect(tabs.tabs()).toHaveLength(1);
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);
    expect(tabs.active()?.session).toBe(SessionId.make('month'));

    // At 4 Panes, row 4 (not open) has Open in split disabled with clear state.
    rightClick(fixture, docAll(fixture, 'session-row')[4]!);
    const disabledSplit = docOne(fixture, 'menu-open-split') as HTMLButtonElement;
    expect(disabledSplit.disabled).toBe(true);
    expect(document.body.textContent).toContain('Up to 4 Panes per Tab');
    pressDoc({ key: 'Escape', code: 'Escape' }, document.activeElement ?? document.body);
    fixture.detectChanges();

    // At 4 Panes, row 0 (already open) still has Open in split enabled and focuses it without duplicating.
    rightClick(fixture, docAll(fixture, 'session-row')[0]!);
    const focusSplit = docOne(fixture, 'menu-open-split') as HTMLButtonElement;
    expect(focusSplit.disabled).toBe(false);
    focusSplit.click();
    fixture.detectChanges();
    expect(tabs.paneCount(tabs.activeTab()!)).toBe(4);
    expect(tabs.active()?.session).toBe(SessionId.make('today'));

    // Open row 4 in a separate Tab via Open in new Tab.
    rightClick(fixture, docAll(fixture, 'session-row')[4]!);
    docOne(fixture, 'menu-open-new-tab').click();
    fixture.detectChanges();
    expect(tabs.tabs()).toHaveLength(2);
    expect(tabs.active()?.session).toBe(SessionId.make('august'));

    // Switch back to the 4-Pane Tab and delete one of its Sessions -> collapses its Pane to 3 Panes.
    tabs.activateIndex(0);
    fixture.detectChanges();
    rightClick(fixture, docAll(fixture, 'session-row')[1]!);
    docOne(fixture, 'menu-delete').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(deleted).toContain(SessionId.make('yesterday'));
      expect(tabs.paneCount(tabs.activeTab()!)).toBe(3);
    });

    // Deleting the sole Session in the second Tab closes that Tab cleanly.
    const augustRow = docAll(fixture, 'session-row').find(
      (r) => r.getAttribute('data-session-id') === 'august',
    )!;
    rightClick(fixture, augustRow);
    docOne(fixture, 'menu-delete').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(deleted).toContain(SessionId.make('august'));
      expect(tabs.tabs()).toHaveLength(1);
    });
  });
});
