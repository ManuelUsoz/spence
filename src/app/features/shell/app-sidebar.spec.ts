import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId, AgentsRpcs, type Agent } from '../../../shared/agents/agents.rpc';
import { ProjectId, ProjectsRpcs, type Project } from '../../../shared/projects/projects.rpc';
import {
  SessionId,
  SessionsRpcs,
  type SessionSummary,
} from '../../../shared/sessions/sessions.rpc';
import {
  SettingsRpcs,
  type ProjectOrder,
  type Settings,
  type SettingsPatch,
  type SidebarLayout,
} from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { AGENT_INSTALL_OFFER } from '../../core/agent-install-offer';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';
import { capSessions } from './session-groups';
import { SettingsDialog } from './settings-dialog';

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
  },
  {
    id: SessionId.make('images'),
    agentId: AgentId.make('claude'),
    title: { autoImageCount: 2, autoIsPlaceholder: true },
    lastActivityAt: at(10, 12, 11),
  },
];

const settings = (
  projectOrder: ProjectOrder,
  sidebarLayout: SidebarLayout = 'oneProject',
): Settings => ({
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout,
  projectOrder,
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: {},
});

const claude = AgentId.make('claude');

const agent: Agent = {
  id: claude,
  name: 'Claude',
  package: '@agentclientprotocol/claude-agent-acp',
  installed: true,
  imageLimits: { maxBase64Bytes: 5_242_880, maxDimensionPx: 8000, maxPerMessage: 20 },
};

@Component({
  selector: 'app-install-offer-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '',
})
class InstallOfferStub {
  readonly agent = input.required<Agent>();
}

@Component({
  selector: 'app-sidebar-host',
  imports: [AppSidebar, SettingsDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-sidebar /><app-settings-dialog />`,
})
class SidebarHost {}

type Fixture = ComponentFixture<unknown>;

interface MountOptions {
  readonly projectOrder?: ProjectOrder;
  readonly sidebarLayout?: SidebarLayout;
  readonly projects?: ReadonlyArray<Project>;
  readonly sessionsByProject?: Readonly<Record<string, ReadonlyArray<SessionSummary>>>;
  readonly renamed?: Array<{ readonly sessionId: SessionId; readonly title: string }>;
  readonly docsList?: ReadonlyArray<SessionSummary>;
}

const applyPatch = (base: Settings, patch: SettingsPatch): Settings => ({
  ...base,
  ...(patch.language === undefined ? {} : { language: patch.language }),
  ...(patch.theme === undefined ? {} : { theme: patch.theme }),
  ...(patch.notifications === undefined ? {} : { notifications: patch.notifications }),
  ...(patch.sidebarLayout === undefined ? {} : { sidebarLayout: patch.sidebarLayout }),
  ...(patch.projectOrder === undefined ? {} : { projectOrder: patch.projectOrder }),
  ...(patch.defaultPermissionMode === undefined
    ? {}
    : { defaultPermissionMode: patch.defaultPermissionMode }),
  ...(patch.autoArchiveDays === undefined ? {} : { autoArchiveDays: patch.autoArchiveDays }),
});

const makeLayer = (options: MountOptions = {}) => {
  let currentSettings = settings(
    options.projectOrder ?? { by: 'lastUsed', direction: 'desc' },
    options.sidebarLayout ?? 'oneProject',
  );
  const projectList = options.projects ?? [docs, api, app];
  const sessionsMap = options.sessionsByProject;
  const docsList = options.docsList ?? [];
  const renamed = options.renamed ?? [];
  const projectHandlers = ProjectsRpcs.toLayer({
    'Projects.list': () => Effect.succeed(projectList),
    'Projects.add': () => Effect.succeed(null),
    'Projects.rename': () => Effect.die('unused'),
    'Projects.remove': () => Effect.die('unused'),
    'Projects.locate': () => Effect.die('unused'),
    'Projects.check': () => Effect.die('unused'),
    'Projects.setSettings': () => Effect.die('unused'),
  });
  const sessionHandlers = SessionsRpcs.toLayer({
    'Session.list': ({ projectId }) =>
      Effect.succeed(
        sessionsMap !== undefined
          ? (sessionsMap[projectId] ?? [])
          : projectId === app.id
            ? appSessions
            : projectId === api.id
              ? apiSessions
              : projectId === docs.id
                ? docsList
                : [],
      ),
    'Session.create': () => Effect.die('unused'),
    'Session.prompt': () => Effect.die('unused'),
    'Session.rename': (payload) =>
      Effect.sync(() => {
        renamed.push(payload);
      }),
    'Session.openAgentLog': () => Effect.void,
    'Session.retryAgent': () => Effect.void,
    'Session.loginAgent': () => Effect.void,
    'Session.cancel': () => Effect.die('unused'),
    'Session.setOption': () => Effect.die('unused'),
    'Session.clearContext': () => Effect.die('unused'),
    'Session.answerPermission': () => Effect.die('unused'),
    'Session.events': () => Stream.die('unused'),
  });
  const base = Layer.mergeAll(
    projectHandlers,
    sessionHandlers,
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ tabs: [] }),
      'Tabs.update': () => Effect.void,
    }),
    AgentsRpcs.toLayer({
      'Agents.list': () => Effect.succeed([agent]),
      'Agents.installCommand': () => Effect.die('unused'),
      'Agents.install': () => Stream.die('unused'),
      'Agents.openInstallLog': () => Effect.die('unused'),
    }),
  );
  if (options.projectOrder === undefined && options.sidebarLayout === undefined) {
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
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(makeLayer(options)) }],
  });
  return TestBed.createComponent(AppSidebar);
};

const mountWithSettings = (options: MountOptions = {}): Fixture => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(makeLayer(options)) },
      { provide: AGENT_INSTALL_OFFER, useValue: InstallOfferStub },
    ],
  });
  return TestBed.createComponent(SidebarHost);
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
    expect(texts(fixture, 'session-group')).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      'August 2026',
    ]);
    expect(titles(fixture)).toEqual([
      'Fix the login form',
      'Write release notes',
      'Add login with GitHub',
      'Upgrade Angular',
      'Set up CI',
    ]);
    expect(texts(fixture, 'session-meta')[0]).toBe('active 5h');
  });

  it('searches this Project by title', async () => {
    const fixture = mount();
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'search-sessions');
    search(fixture, 'LOGIN');
    expect(titles(fixture)).toEqual(['Fix the login form', 'Add login with GitHub']);
    expect(texts(fixture, 'session-group')).toEqual(['Today', 'Previous 7 days']);

    search(fixture, 'nothing like this');
    expect(titles(fixture)).toEqual([]);
    expect(one(fixture, 'sessions-empty').textContent?.trim()).toBe('No Sessions match.');

    click(fixture, 'search-sessions');
    expect(titles(fixture)).toHaveLength(5);
  });

  it('lists Projects by last use in the switcher, and picking one shows its Sessions', async () => {
    const fixture = mount();
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'current-project');
    expect(texts(fixture, 'project-option')).toEqual(['app', 'api', 'docs']);
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
      expect(texts(fixture, 'project-option')).toEqual(['api', 'app', 'docs']),
    );
  });

  it('starts a draft at the top of the list, and follows the active Tab to its Project', async () => {
    const fixture = mount();
    const tabs = TestBed.inject(Tabs);
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));

    click(fixture, 'new-session');
    expect(texts(fixture, 'draft-row')).toEqual(['New Session']);
    expect(tabs.active()?.session).toBeNull();
    expect(tabs.active()?.projectId).toBe(app.id);

    click(fixture, 'session-row', 0);
    expect(tabs.active()?.title).toBe('Fix the login form');
    expect(texts(fixture, 'session-meta')[0]).toBe('active 5h · open in a Tab');

    click(fixture, 'current-project');
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits']));
    expect(all(fixture, 'draft-row')).toHaveLength(0);

    const draft = tabs.draftOf(app.id);
    tabs.activate(draft?.id ?? '');
    await vi.waitFor(() => expect(texts(fixture, 'draft-row')).toEqual(['New Session']));
    expect(one(fixture, 'current-project').textContent).toContain('/work/app');

    tabs.close(draft?.id ?? '');
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

  it('switches to All Projects layout immediately when changed in Settings', async () => {
    const fixture = mountWithSettings({ sidebarLayout: 'oneProject' });
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));
    expect(all(fixture, 'all-projects-filter')).toHaveLength(0);

    click(fixture, 'open-settings');
    await vi.waitFor(() => expect(all(fixture, 'sidebar-allProjects')).toHaveLength(1));
    click(fixture, 'sidebar-allProjects');

    await vi.waitFor(() => {
      expect(all(fixture, 'all-projects-filter')).toHaveLength(1);
      expect(all(fixture, 'project-heading')).toHaveLength(3);
    });
    expect(texts(fixture, 'project-heading').map((text) => text.replace(/\s+/g, ' '))).toEqual([
      'app',
      'api',
      'docs',
    ]);
  });

  it('sorts Projects numerically and case-insensitively from the sidebar sort control', async () => {
    const app10 = project('p10', 'app10', at(10, 12));
    const beta = project('pb', 'Beta', at(10, 11));
    const app2 = project('p2', 'app2', at(10, 10));
    const alpha = project('pa', 'alpha', at(10, 9));
    const fixture = mount({
      sidebarLayout: 'allProjects',
      projectOrder: { by: 'lastUsed', direction: 'desc' },
      projects: [app2, alpha, app10, beta],
      sessionsByProject: {},
    });
    const headingNames = () =>
      texts(fixture, 'project-heading').map((text) => text.replace(/\s+/g, ' '));

    await vi.waitFor(() => expect(headingNames()).toEqual(['app10', 'Beta', 'app2', 'alpha']));

    click(fixture, 'project-order-trigger');
    click(fixture, 'sort-by-name');
    await vi.waitFor(() => expect(headingNames()).toEqual(['Beta', 'app10', 'app2', 'alpha']));

    click(fixture, 'project-order-trigger');
    click(fixture, 'sort-direction-asc');
    await vi.waitFor(() => expect(headingNames()).toEqual(['alpha', 'app2', 'app10', 'Beta']));
  });

  it('caps each Project at 5 Sessions with short age, toggles Show N more / Show less, and shows drafts and folder-missing marks', async () => {
    const manySessions: ReadonlyArray<SessionSummary> = [
      session('s1', 'First', at(10, 12, 14)),
      session('s2', 'Second', at(10, 12, 12)),
      session('s3', 'Third', at(10, 11, 15)),
      session('s4', 'Fourth', at(10, 10, 15)),
      session('s5', 'Fifth', at(10, 9, 15)),
      session('s6', 'Sixth', at(10, 8, 15)),
      session('s7', 'Seventh', at(10, 7, 15)),
      { ...session('s8', 'Archived one', at(10, 12, 14)), archivedAt: at(10, 12, 14) },
    ];
    const fixture = mount({
      sidebarLayout: 'allProjects',
      sessionsByProject: { [app.id]: manySessions, [api.id]: apiSessions, [docs.id]: [] },
    });
    const tabs = TestBed.inject(Tabs);

    await vi.waitFor(() =>
      expect(titles(fixture)).toEqual([
        'First',
        'Second',
        'Third',
        'Fourth',
        'Fifth',
        'Rate limits',
      ]),
    );
    expect(texts(fixture, 'session-age')).toEqual(['1h', '3h', '1d', '2d', '3d', '1h']);
    expect(
      all(fixture, 'project-heading')[1]?.querySelector('[data-testid="folder-missing"]'),
    ).not.toBeNull();
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 2 more']);

    click(fixture, 'show-more-sessions');
    expect(titles(fixture)).toEqual([
      'First',
      'Second',
      'Third',
      'Fourth',
      'Fifth',
      'Sixth',
      'Seventh',
      'Rate limits',
    ]);
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show less']);

    click(fixture, 'show-more-sessions');
    expect(titles(fixture)).toHaveLength(6);
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 2 more']);

    // + button starts a draft under that Project, and clicking a Session opens its Tab.
    click(fixture, 'project-new-session', 1);
    expect(texts(fixture, 'draft-row')).toEqual(['New Session']);
    expect(tabs.active()?.projectId).toBe(api.id);

    click(fixture, 'session-row', 5);
    expect(tabs.active()?.session).toBe(SessionId.make('renamed'));
    expect(tabs.active()?.projectId).toBe(api.id);
  });

  it('pins the active Session and any Session with attention past the 5-Session cap', async () => {
    const manySessions: ReadonlyArray<SessionSummary> = [
      session('s1', 'First', at(10, 12, 14)),
      session('s2', 'Second', at(10, 12, 13)),
      session('s3', 'Third', at(10, 12, 12)),
      session('s4', 'Fourth', at(10, 12, 11)),
      session('s5', 'Fifth', at(10, 12, 10)),
      session('s6', 'Sixth', at(10, 11, 10)),
      session('s7', 'Seventh', at(10, 10, 10)),
      session('s8', 'Eighth', at(10, 9, 10)),
    ];
    const fixture = mount({
      sidebarLayout: 'allProjects',
      projects: [app],
      sessionsByProject: { [app.id]: manySessions },
    });
    const tabs = TestBed.inject(Tabs);

    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(5));
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 3 more']);

    // Opening the 7th Session keeps it pinned past the cap.
    tabs.open({ id: SessionId.make('s7'), projectId: app.id, title: 'Seventh' });
    fixture.detectChanges();
    expect(titles(fixture)).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Seventh']);
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 2 more']);

    // Switching active Tab to a top-5 Session unpins the 7th Session.
    tabs.open({ id: SessionId.make('s1'), projectId: app.id, title: 'First' });
    fixture.detectChanges();
    expect(titles(fixture)).toEqual(['First', 'Second', 'Third', 'Fourth', 'Fifth']);
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 3 more']);

    // Attention hook also pins past the cap.
    const withAttention = manySessions.map((item) =>
      item.id === SessionId.make('s6') ? { ...item, attention: 'needsAnswer' as const } : item,
    );
    const capped = capSessions(withAttention, {
      cap: 5,
      expanded: false,
      isPinned: (item) => 'attention' in item && item.attention !== undefined,
    });
    expect(capped.visible.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);
    expect(capped.hiddenCount).toBe(2);
  });

  it('filters across Project names and Session titles without the 5-Session cap', async () => {
    const manyApp: ReadonlyArray<SessionSummary> = [
      session('s1', 'Auth login', at(10, 12, 14)),
      session('s2', 'Billing', at(10, 12, 13)),
      session('s3', 'Caching', at(10, 12, 12)),
      session('s4', 'Docs sync', at(10, 12, 11)),
      session('s5', 'Errors', at(10, 12, 10)),
      session('s6', 'Auth logout', at(10, 11, 10)),
      session('s7', 'Auth tokens', at(10, 10, 10)),
    ];
    const fixture = mount({
      sidebarLayout: 'allProjects',
      sessionsByProject: { [app.id]: manyApp, [api.id]: apiSessions, [docs.id]: [] },
    });
    const filterBy = (value: string) => {
      const input = one(fixture, 'all-projects-filter') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
    };
    const headingNames = () =>
      texts(fixture, 'project-heading').map((text) => text.replace(/\s+/g, ' '));

    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(6));

    // Matches Session titles past the cap and hides non-matching Projects.
    filterBy('AUTH');
    expect(headingNames()).toEqual(['app']);
    expect(titles(fixture)).toEqual(['Auth login', 'Auth logout', 'Auth tokens']);
    expect(all(fixture, 'show-more-sessions')).toHaveLength(0);

    // Matches Project name and shows all its non-archived Sessions without cap.
    filterBy('APP');
    expect(headingNames()).toEqual(['app']);
    expect(titles(fixture)).toHaveLength(7);
    expect(all(fixture, 'show-more-sessions')).toHaveLength(0);

    // Matches across multiple Projects when both match.
    filterBy('rate');
    expect(headingNames()).toEqual(['api']);
    expect(titles(fixture)).toEqual(['Rate limits']);

    // Nothing matches -> empty state message.
    filterBy('nope');
    expect(headingNames()).toEqual([]);
    expect(titles(fixture)).toEqual([]);
    expect(one(fixture, 'sessions-empty').textContent?.trim()).toBe('No Sessions match.');

    // Escape clears the filter and restores the cap.
    one(fixture, 'all-projects-filter').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape' }),
    );
    fixture.detectChanges();
    expect((one(fixture, 'all-projects-filter') as HTMLInputElement).value).toBe('');
    expect(headingNames()).toEqual(['app', 'api', 'docs']);
    expect(titles(fixture)).toHaveLength(6);
    expect(texts(fixture, 'show-more-sessions')).toEqual(['Show 2 more']);
  });
});
