import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HlmToasterImports } from '@ui/sonner';
import { toast } from '@ui/toast';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentId } from '../../../shared/agents/agents.rpc';
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
import { ProjectSettingsState } from './project-settings-state';
import { SessionConfirmDialog } from './session-confirm-dialog';
import { TabStrip } from './tab-strip';

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

const handlers = Layer.mergeAll(
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
      Effect.succeed(projectId === app.id ? appSessions : projectId === api.id ? apiSessions : []),
    'Session.create': () => Effect.die('unused'),
    'Session.prompt': () => Effect.die('unused'),
    'Session.cancel': () => Effect.die('unused'),
    'Session.setOption': () => Effect.die('unused'),
    'Session.clearContext': () => Effect.die('unused'),
    'Session.archive': () => Effect.die('unused'),
    'Session.unarchive': () => Effect.die('unused'),
    'Session.delete': () => Effect.die('unused'),
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
const mount = (projectOrder?: ProjectOrder): Fixture => {
  const served =
    projectOrder === undefined
      ? handlers
      : Layer.mergeAll(
          handlers,
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
});

@Component({
  selector: 'app-test-shell-host',
  imports: [AppSidebar, TabStrip, SessionConfirmDialog, HlmToasterImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-sidebar />
    <app-tab-strip />
    <app-session-confirm-dialog />
    <hlm-toaster theme="system" />
  `,
})
class TestShellHost {}

interface ShellControls {
  readonly fixture: ComponentFixture<TestShellHost>;
  readonly archived: SessionId[];
  readonly unarchived: SessionId[];
  readonly deleted: SessionId[];
  readonly cancelled: SessionId[];
  readonly renamed: Array<{ readonly id: ProjectId; readonly name: string }>;
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
      'Projects.check': () => Effect.die('unused'),
      'Projects.setSettings': () => Effect.die('unused'),
    }),
    SessionsRpcs.toLayer({
      'Session.list': ({ projectId }) => Effect.succeed(store.get(projectId) ?? []),
      'Session.create': () => Effect.die('unused'),
      'Session.prompt': () => Effect.die('unused'),
      'Session.cancel': ({ sessionId }) =>
        Effect.sync(() => {
          cancelled.push(sessionId);
          running.delete(sessionId);
        }),
      'Session.setOption': () => Effect.die('unused'),
      'Session.clearContext': () => Effect.die('unused'),
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
              title: { auto: 's', autoIsPlaceholder: false },
              options: { permissionMode: PermissionMode.make('auto') },
              commands: [],
              canAttachImages: false,
              imageLimits: { maxBase64Bytes: 1, maxDimensionPx: 1, maxPerMessage: 1 },
              agentName: 'Claude',
              ...(running.has(sessionId) ? { runningTurn: TurnId.make('t1') } : {}),
            },
          },
        ]),
    }),
    TabsRpcs.toLayer({
      'Tabs.restore': () => Effect.succeed({ tabs: [] }),
      'Tabs.update': () => Effect.void,
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
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
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
    expect(docOne(fixture, 'menu-rename').hasAttribute('disabled')).toBe(true);
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
    expect(toastError).toHaveBeenCalledWith('Could not archive 1 Session.');
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
    expect(toastError).toHaveBeenCalledWith('Could not delete 1 Session.');
    await waitTitles(fixture, 2);
  });

  it('supports Archived fold menu (Unarchive all / Delete all), Project context menu, and TabStrip context menu', async () => {
    const { fixture, unarchived, deleted, renamed, located, removed, cancelled, running } =
      mountShell();
    const projectSettings = TestBed.inject(ProjectSettingsState);
    await waitTitles(fixture, 5);

    // Archived fold menu: Unarchive all (1)
    rightClick(fixture, docOne(fixture, 'archived-fold'));
    docOne(fixture, 'archived-menu-unarchive-all').click();
    await vi.waitFor(() => expect(unarchived).toEqual([SessionId.make('archived')]));
    await waitTitles(fixture, 6);

    // TabStrip context menu: open row 0, right-click tab, Delete...
    clickRow(fixture, 0);
    expect(docAll(fixture, 'tab')).toHaveLength(1);
    rightClick(fixture, docOne(fixture, 'tab'));
    docOne(fixture, 'menu-delete').click();
    await vi.waitFor(() => docOne(fixture, 'confirm-action'));
    docOne(fixture, 'confirm-action').click();
    await vi.waitFor(() => expect(deleted).toEqual([SessionId.make('today')]));
    await vi.waitFor(() => expect(docAll(fixture, 'tab')).toHaveLength(0));

    // Project menu: Project settings, Rename, Remove Project (with running Turn confirm)
    rightClick(fixture, docOne(fixture, 'current-project'));
    expect(docAll(fixture, 'project-menu-locate')).toHaveLength(0);
    docOne(fixture, 'project-menu-settings').click();
    expect(projectSettings.project()?.id).toBe(app.id);
    projectSettings.close();

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
});
