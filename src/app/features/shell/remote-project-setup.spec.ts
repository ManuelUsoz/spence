import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_SCOPE_HEADER,
  DeviceId,
  DevicesRpcs,
  type DeviceConnection,
} from '../../../shared/devices/devices.rpc';
import { FoldersError, FoldersRpcs, type FolderListing } from '../../../shared/folders/folders.rpc';
import {
  ProjectId,
  ProjectsRpcs,
  type Project,
  type ProjectSettingsPatch,
} from '../../../shared/projects/projects.rpc';
import { SessionsRpcs } from '../../../shared/sessions/sessions.rpc';
import { ExecutionSettingsRpcs } from '../../../shared/settings/settings.rpc';
import { TabsRpcs } from '../../../shared/tabs/tabs.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM } from '../../core/keymap';
import { AppSidebar } from './app-sidebar';
import { FolderBrowserDialog } from './folder-browser-dialog';
import { ProjectSettingsSheet } from './project-settings-sheet';

const studio = DeviceId.make('device-studio');

const project = (id: string, name: string, overrides: Partial<Project> = {}): Project => ({
  id: ProjectId.make(id),
  name,
  path: `/home/ana/${name}`,
  addedAt: 1,
  lastUsedAt: 1,
  settings: {},
  folderMissing: false,
  ...overrides,
});

const localApp = project('local-app', 'app');

const online: ReadonlyArray<DeviceConnection> = [
  { id: studio, name: 'Studio PC', status: { _tag: 'Online', name: 'Studio PC' } },
];

/** The Studio PC's disk: its home with two folders (one hidden), and the folders inside `site`. */
const listing = (path: string, hidden: boolean): FolderListing => {
  if (path === '/home/ana') {
    return {
      path,
      parent: '/home',
      home: '/home/ana',
      roots: ['/'],
      entries: [
        ...(hidden
          ? [{ name: '.config', path: '/home/ana/.config', hidden: true, link: false }]
          : []),
        { name: 'site', path: '/home/ana/site', hidden: false, link: false },
      ],
    };
  }
  return { path, parent: '/home/ana', home: '/home/ana', roots: ['/'], entries: [] };
};

interface Served {
  remote: Array<Project>;
  /** Every call with the Device it was made of (`local` for none). */
  readonly calls: Array<readonly [string, string]>;
  readonly patches: Array<ProjectSettingsPatch>;
}

const deviceOf = (headers: Readonly<Record<string, string | undefined>>): string =>
  headers[DEVICE_SCOPE_HEADER] ?? 'local';

const die = () => Effect.die('unused');

const layer = (served: Served) =>
  makeDesktopTestLayer(
    Layer.mergeAll(
      DevicesRpcs.toLayer({
        'Devices.local': die,
        'Devices.rename': die,
        'Devices.setHosting': die,
        'Devices.watch': () => Stream.die('unused'),
        'Devices.nearby': () => Stream.die('unused'),
        'Devices.startPairing': die,
        'Devices.cancelPairing': die,
        'Devices.pair': die,
        'Devices.check': die,
        'Devices.connections': () => Stream.concat(Stream.make(online), Stream.never),
        'Devices.connect': () => Effect.void,
        'Devices.unpair': die,
        'Devices.setAllowAgents': die,
      }),
      FoldersRpcs.toLayer({
        'Folders.browse': ({ path, hidden }, { headers }) =>
          Effect.suspend(() => {
            served.calls.push([deviceOf(headers), `browse ${path ?? 'home'}`]);
            if (path === '/gone') {
              return Effect.fail(new FoldersError({ reason: 'Missing', detail: path }));
            }
            return Effect.succeed(listing(path ?? '/home/ana', hidden));
          }),
      }),
      ExecutionSettingsRpcs.toLayer({
        'ExecutionSettings.get': (_payload, { headers }) =>
          Effect.sync(() => {
            served.calls.push([deviceOf(headers), 'settings']);
            return {
              defaultPermissionMode: deviceOf(headers) === studio ? 'ask' : 'auto',
              defaultAgent: 'claude',
              autoArchiveDays: null,
              agents: {},
            } as const;
          }),
        'ExecutionSettings.update': die,
      }),
      ProjectsRpcs.toLayer({
        'Projects.list': (_payload, { headers }) =>
          Effect.sync(() => (deviceOf(headers) === studio ? served.remote : [localApp])),
        'Projects.add': () =>
          Effect.sync(() => {
            served.calls.push(['local', 'native picker']);
            return null;
          }),
        'Projects.addFolder': ({ path }, { headers }) =>
          Effect.sync(() => {
            served.calls.push([deviceOf(headers), `add ${path}`]);
            return project('remote-site', 'site', { path });
          }),
        'Projects.locate': die,
        'Projects.locateFolder': ({ id, path }, { headers }) =>
          Effect.sync(() => {
            served.calls.push([deviceOf(headers), `locate ${id} ${path}`]);
            return project(id, 'old', { path });
          }),
        'Projects.rename': die,
        'Projects.remove': die,
        'Projects.check': (_payload, { headers }) =>
          Effect.sync(() => served.remote[0] ?? localApp).pipe(
            Effect.tap(() => Effect.sync(() => served.calls.push([deviceOf(headers), 'check']))),
          ),
        'Projects.setSettings': ({ id, patch }, { headers }) =>
          Effect.sync(() => {
            served.calls.push([deviceOf(headers), `setSettings ${id}`]);
            served.patches.push(patch);
            return project(id, 'old', { settings: { defaultPermissionMode: 'auto' } });
          }),
      }),
      SessionsRpcs.toLayer({
        'Session.changes': () => Stream.never,
        'Session.list': () => Effect.succeed([]),
        'Session.create': die,
        'Session.setAgent': die,
        'Session.prompt': die,
        'Session.steer': die,
        'Session.enqueue': die,
        'Session.setQueue': die,
        'Session.clearQueue': die,
        'Session.cancel': die,
        'Session.stopAgent': die,
        'Session.rename': die,
        'Session.retryAgent': () => Effect.void,
        'Session.loginAgent': () => Effect.void,
        'Session.openAgentLog': () => Effect.void,
        'Session.answerPermission': die,
        'Session.setOption': die,
        'Session.clearContext': die,
        'Session.compact': die,
        'Session.startEmptyContext': die,
        'Session.archive': die,
        'Session.unarchive': die,
        'Session.delete': die,
        'Session.countWorkers': die,
        'Session.events': () => Stream.die('unused'),
        'Session.getComposer': die,
        'Session.setComposer': die,
        'Session.prepareHandoff': die,
        'Session.revalidateHandoff': die,
        'Session.executeHandoff': die,
        'Session.listHandoffAttempts': die,
      }),
      TabsRpcs.toLayer({
        'Tabs.restore': () => Effect.succeed({ tabs: [] }),
        'Tabs.update': () => Effect.void,
        'Tabs.activations': () => Stream.empty,
      }),
    ),
  );

@Component({
  selector: 'app-remote-setup-host',
  imports: [AppSidebar, FolderBrowserDialog, ProjectSettingsSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-sidebar /><app-folder-browser-dialog /><app-project-settings-sheet />`,
})
class Host {}

const mount = (served: Served): ComponentFixture<Host> => {
  TestBed.configureTestingModule({
    providers: [
      { provide: DESKTOP_LAYER, useValue: layer(served) },
      { provide: KEYMAP_PLATFORM, useValue: 'other' },
    ],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return fixture;
};

/** Menus and dialogs open in overlays outside the component. */
const all = (fixture: ComponentFixture<Host>, testId: string): HTMLElement[] => {
  fixture.detectChanges();
  return [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
};

const texts = (fixture: ComponentFixture<Host>, testId: string): string[] =>
  all(fixture, testId).map((element) => element.textContent?.trim() ?? '');

const click = (fixture: ComponentFixture<Host>, testId: string, index = 0): void => {
  const element = all(fixture, testId)[index];
  if (element === undefined) throw new Error(`no ${testId} #${index}`);
  element.click();
  fixture.detectChanges();
};

const served = (remote: Array<Project> = []): Served => ({ remote, calls: [], patches: [] });

/** Opens the Project switcher once the Studio PC's group is listed. */
const openSwitcher = async (fixture: ComponentFixture<Host>) => {
  await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('app'));
  click(fixture, 'current-project');
  await vi.waitFor(() => expect(texts(fixture, 'project-group-name')).toContain('Studio PC'));
};

describe('Setting up Projects on a Remote device', () => {
  afterEach(() => TestBed.resetTestingModule());

  it("adds a Project on a Remote device through the folder browser over that Device's disk", async () => {
    const state = served();
    const fixture = mount(state);
    await openSwitcher(fixture);

    expect(texts(fixture, 'add-project-remote')).toEqual(['Add Project on Studio PC…']);
    click(fixture, 'add-project-remote');

    await vi.waitFor(() => expect(texts(fixture, 'folder-entry-name')).toEqual(['site']));
    expect(texts(fixture, 'folder-browser-title')).toEqual(['Add a Project on Studio PC']);
    expect(texts(fixture, 'folder-path')).toEqual(['/home/ana']);

    // Hidden folders only on request.
    click(fixture, 'folder-hidden');
    await vi.waitFor(() =>
      expect(texts(fixture, 'folder-entry-name')).toEqual(['.config', 'site']),
    );

    click(fixture, 'folder-entry', 1);
    await vi.waitFor(() => expect(texts(fixture, 'folder-path')).toEqual(['/home/ana/site']));
    expect(texts(fixture, 'folder-empty')).toHaveLength(1);
    click(fixture, 'folder-choose');

    await vi.waitFor(() => expect(state.calls).toContainEqual([studio, 'add /home/ana/site']));
    expect(state.calls.filter(([device]) => device === 'local')).toEqual([]);
    await vi.waitFor(() => expect(all(fixture, 'folder-browser')).toEqual([]));
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('site'));
  });

  it('a Local Project is still added with the native dialog, never the folder browser', async () => {
    const state = served();
    const fixture = mount(state);
    await openSwitcher(fixture);

    click(fixture, 'add-project');

    await vi.waitFor(() => expect(state.calls).toEqual([['local', 'native picker']]));
    expect(all(fixture, 'folder-browser')).toEqual([]);
  });

  it('a folder that is gone says so, and cancelling adds nothing', async () => {
    const state = served();
    const fixture = mount(state);
    await openSwitcher(fixture);
    click(fixture, 'add-project-remote');
    await vi.waitFor(() => expect(texts(fixture, 'folder-entry-name')).toEqual(['site']));

    click(fixture, 'folder-up');
    await vi.waitFor(() => expect(texts(fixture, 'folder-path')).toEqual(['/home']));
    click(fixture, 'folder-cancel');

    await vi.waitFor(() => expect(all(fixture, 'folder-browser')).toEqual([]));
    expect(state.calls.some(([, call]) => call.startsWith('add'))).toBe(false);
  });

  it("locates a Remote Project's moved folder on its Device", async () => {
    const missing = project('remote-old', 'old', { folderMissing: true });
    const state = served([missing]);
    const fixture = mount(state);
    await openSwitcher(fixture);
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('old'));

    const current = all(fixture, 'current-project')[0];
    current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 20,
        clientY: 20,
      }),
    );
    click(fixture, 'project-menu-locate');
    await vi.waitFor(() => expect(texts(fixture, 'folder-entry-name')).toEqual(['site']));
    click(fixture, 'folder-entry');
    await vi.waitFor(() => expect(texts(fixture, 'folder-path')).toEqual(['/home/ana/site']));
    click(fixture, 'folder-choose');

    await vi.waitFor(() =>
      expect(state.calls).toContainEqual([studio, 'locate remote-old /home/ana/site']),
    );
  });

  it("a Remote Project's settings come from, and change on, its Device", async () => {
    const state = served([project('remote-old', 'old')]);
    const fixture = mount(state);
    await openSwitcher(fixture);
    click(fixture, 'project-option', 1);
    await vi.waitFor(() => expect(texts(fixture, 'current-project')[0]).toContain('old'));

    click(fixture, 'current-project');
    click(fixture, 'switcher-project-settings');

    await vi.waitFor(() =>
      expect(all(fixture, 'project-permission')[0]?.getAttribute('data-inherited')).toBe('true'),
    );
    expect(state.calls).toContainEqual([studio, 'settings']);
    expect(texts(fixture, 'project-settings-device')).toEqual(['· Studio PC']);
    // Inherited from the Studio PC's Settings (Ask), not this Device's (Auto).
    expect(all(fixture, 'project-permission-ask')[0]?.getAttribute('aria-pressed')).toBe('true');

    click(fixture, 'project-permission-auto');
    await vi.waitFor(() => expect(state.calls).toContainEqual([studio, 'setSettings remote-old']));
    expect(state.patches).toEqual([{ defaultPermissionMode: 'auto' }]);
  });
});
