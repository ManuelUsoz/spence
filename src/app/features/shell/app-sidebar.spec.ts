import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
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

const handlers = (
  renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [],
  docsList: ReadonlyArray<SessionSummary> = [],
) =>
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
      'Session.list': ({ projectId }) =>
        Effect.succeed(
          projectId === app.id
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
      'Session.cancel': () => Effect.die('unused'),
      'Session.setOption': () => Effect.die('unused'),
      'Session.clearContext': () => Effect.die('unused'),
      'Session.answerPermission': () => Effect.die('unused'),
      'Session.events': () => Stream.die('unused'),
    }),
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ tabs: [] }),
      'Tabs.update': () => Effect.void,
    }),
  );

type Fixture = ComponentFixture<AppSidebar>;

/** Mounts the sidebar; with `projectOrder`, Settings serves that Project order (otherwise Settings.get dies). */
const mount = (
  projectOrder?: ProjectOrder,
  renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [],
  docsList: ReadonlyArray<SessionSummary> = [],
): Fixture => {
  const base = handlers(renamed, docsList);
  const served =
    projectOrder === undefined
      ? base
      : Layer.mergeAll(
          base,
          SettingsRpcs.toLayer({
            'Settings.get': () => Effect.succeed(settings(projectOrder)),
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

  it('renames inline via double-click or F2, cancels on Esc, and opens untitled Sessions as null Tab title', async () => {
    const renamed: Array<{ readonly sessionId: SessionId; readonly title: string }> = [];
    const fixture = mount(undefined, renamed, docsSessions);
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
