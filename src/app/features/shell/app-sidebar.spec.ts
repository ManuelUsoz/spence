import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, PubSub, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  SettingsRpcs,
  type ProjectOrder,
  type Settings,
} from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { Tabs } from '../../core/tabs';
import { AppSidebar } from './app-sidebar';

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

const settings = (projectOrder: ProjectOrder): Settings => ({
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder,
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: {},
});

const liveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  agentStatus: 'ready',
  title: { auto: 'Fix the login form', autoIsPlaceholder: false },
  options: { permissionMode: 'auto' },
  commands: [],
  canAttachImages: false,
  imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
  ...overrides,
});

interface MountOptions {
  readonly projectOrder?: ProjectOrder;
  readonly changes?: Stream.Stream<SessionChange>;
  readonly sessionsByProject?: ReadonlyMap<ProjectId, ReadonlyArray<SessionSummary>>;
}

const makeHandlers = (options?: MountOptions) =>
  Layer.mergeAll(
    ProjectsRpcs.toLayer({
      'Projects.list': () => Effect.succeed([docs, api, app]),
      'Projects.add': () => Effect.succeed(null),
      'Projects.rename': () => Effect.die('unused'),
      'Projects.remove': () => Effect.die('unused'),
      'Projects.locate': () => Effect.die('unused'),
      'Projects.check': () => Effect.die('unused'),
      'Projects.setSettings': () => Effect.die('unused'),
    }),
    SessionsRpcs.toLayer({
      'Session.changes': () => options?.changes ?? Stream.empty,
      'Session.list': ({ projectId }) =>
        Effect.succeed(
          options?.sessionsByProject?.get(projectId) ??
            (projectId === app.id ? appSessions : projectId === api.id ? apiSessions : []),
        ),
      'Session.create': () => Effect.die('unused'),
      'Session.prompt': () => Effect.die('unused'),
      'Session.cancel': () => Effect.die('unused'),
      'Session.setOption': () => Effect.die('unused'),
      'Session.clearContext': () => Effect.die('unused'),
      'Session.answerPermission': () => Effect.die('unused'),
      'Session.events': () => Stream.die('unused'),
      'Session.getComposer': () => Effect.die('unused'),
      'Session.setComposer': () => Effect.die('unused'),
    }),
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ tabs: [] }),
      'Tabs.update': () => Effect.void,
      'Tabs.activations': () => Stream.empty,
    }),
  );

type Fixture = ComponentFixture<AppSidebar>;

/** Mounts the sidebar; with `projectOrder`, Settings serves that Project order (otherwise Settings.get dies). */
const mount = (options?: ProjectOrder | MountOptions): Fixture => {
  const opts: MountOptions | undefined =
    options === undefined ? undefined : 'by' in options ? { projectOrder: options } : options;
  const base = makeHandlers(opts);
  const served =
    opts?.projectOrder === undefined
      ? base
      : Layer.mergeAll(
          base,
          SettingsRpcs.toLayer({
            'Settings.get': () => Effect.succeed(settings(opts.projectOrder!)),
            'Settings.update': () => Effect.die('unused'),
          }),
        );
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(served) }],
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
});

afterEach(() => {
  vi.useRealTimers();
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

  it('pins Attention Sessions under Needs you, reflects cause in meta, and updates live from Session.changes', async () => {
    const changes = Effect.runSync(PubSub.unbounded<SessionChange>());
    const sessionsByProject = new Map<ProjectId, ReadonlyArray<SessionSummary>>([
      [
        app.id,
        [
          { ...session('today', 'Fix the login form', at(10, 12, 10)) },
          {
            ...session('yesterday', 'Write release notes', at(10, 11, 18)),
            attention: 'needsAnswer',
          },
          { ...session('week', 'Add login with GitHub', at(10, 8)), attention: 'error' },
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
    expect(texts(fixture, 'session-meta')[0]).toBe('active 21h · waiting for your answer');
    expect(texts(fixture, 'session-meta')[1]).toBe('active 4d · error');
    expect(texts(fixture, 'session-meta')[2]).toBe('active 5h');

    // Opening the needsAnswer session adds "open in a Tab" to meta.
    click(fixture, 'session-row', 0);
    expect(texts(fixture, 'session-meta')[0]).toBe(
      'active 21h · waiting for your answer · open in a Tab',
    );

    // Live clear of attention moves the session back to its day group; starting a Turn shows running mark.
    Effect.runSync(
      PubSub.publish(changes, {
        sessionId: SessionId.make('yesterday'),
        projectId: app.id,
        state: liveState({
          title: { auto: 'Write release notes', autoIsPlaceholder: false },
          runningTurn: TurnId.make('t1'),
        }),
      }),
    );
    await vi.waitFor(() => expect(all(fixture, 'session-running')).toHaveLength(1));
    expect(texts(fixture, 'session-group')).toEqual(['Needs you', 'Today']);
    expect(titles(fixture)).toEqual([
      'Add login with GitHub',
      'Write release notes',
      'Fix the login form',
    ]);
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
            attention: 'needsAnswer',
            running: true,
          },
        ],
      ],
      [docs.id, [{ ...session('doc1', 'Write docs', at(10, 1, 10)), running: true }]],
    ]);
    const fixture = mount({ changes: Stream.fromPubSub(changes), sessionsByProject });
    await vi.waitFor(() => expect(titles(fixture)).toHaveLength(1));

    await vi.waitFor(() => expect(all(fixture, 'other-project-attention')).toHaveLength(1));

    // Open switcher menu: api has needsAnswer + running, docs has running.
    click(fixture, 'current-project');
    const options = all(fixture, 'project-option');
    expect(options[1]?.querySelector('[data-testid="attention-needsAnswer"]')).not.toBeNull();
    expect(options[1]?.querySelector('[data-testid="session-running"]')).not.toBeNull();
    expect(options[2]?.querySelector('[data-testid="session-running"]')).not.toBeNull();
    expect(options[0]?.querySelector('[data-testid="attention-needsAnswer"]')).toBeNull();

    // Switching to api hides the other-project dot (since only api has attention).
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(titles(fixture)).toEqual(['Rate limits']));
    expect(all(fixture, 'other-project-attention')).toHaveLength(0);

    // Background session in app gains error -> other-project dot appears again!
    Effect.runSync(
      PubSub.publish(changes, {
        sessionId: SessionId.make('today'),
        projectId: app.id,
        state: liveState({ attention: 'error' }),
      }),
    );
    await vi.waitFor(() => expect(all(fixture, 'other-project-attention')).toHaveLength(1));
  });
});
