import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectId,
  ProjectsRpcs,
  type Project,
  type ProjectSettingsPatch,
} from '../../../shared/projects/projects.rpc';
import { SettingsRpcs, type Settings } from '../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../core/effect-runtime';
import { KEYMAP_PLATFORM, Keymap } from '../../core/keymap';
import { ProjectSettingsSheet } from './project-settings-sheet';
import { ProjectSettingsState } from './project-settings-state';

const settings: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: {},
};

const demo: Project = {
  id: ProjectId.make('p1'),
  name: 'demo-project',
  path: '/work/demo-project',
  addedAt: 1,
  lastUsedAt: 1,
  settings: {},
  folderMissing: false,
};

let patches: ProjectSettingsPatch[] = [];
let settingsFail = false;
let current: Project = demo;

/** Main applies the patch as `Projects.setSettings` does: `null` clears the key. */
const apply = (project: Project, patch: ProjectSettingsPatch): Project => {
  const mode = patch.defaultPermissionMode;
  if (mode === undefined) return project;
  return { ...project, settings: mode === null ? {} : { defaultPermissionMode: mode } };
};

const handlers = Layer.mergeAll(
  SettingsRpcs.toLayer({
    'Settings.get': () =>
      settingsFail ? Effect.die('Settings unreadable') : Effect.succeed(settings),
    'Settings.update': () => Effect.die('not served'),
  }),
  ProjectsRpcs.toLayer({
    'Projects.list': () => Effect.succeed([demo]),
    'Projects.add': () => Effect.die('not served'),
    'Projects.rename': () => Effect.die('not served'),
    'Projects.remove': () => Effect.die('not served'),
    'Projects.locate': () => Effect.die('not served'),
    'Projects.check': () => Effect.die('not served'),
    'Projects.setSettings': ({ patch }) =>
      Effect.sync(() => {
        patches.push(patch);
        return apply(current, patch);
      }),
  }),
);

const mountSheet = (project: Project): ComponentFixture<ProjectSettingsSheet> => {
  current = project;
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });
  const fixture = TestBed.createComponent(ProjectSettingsSheet);
  TestBed.inject(ProjectSettingsState).show(project);
  return fixture;
};

const open = async (project: Project): Promise<ComponentFixture<ProjectSettingsSheet>> => {
  const fixture = mountSheet(project);
  await vi.waitFor(() => {
    fixture.detectChanges();
    expect(byTestId('project-permission')).not.toBeNull();
  });
  return fixture;
};

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const get = (id: string): HTMLElement => {
  const element = byTestId(id);
  if (element === null) throw new Error(`no ${id}`);
  return element;
};

const pressed = (id: string): boolean => get(id).getAttribute('aria-pressed') === 'true';

const settle = (fixture: ComponentFixture<ProjectSettingsSheet>, check: () => void) =>
  vi.waitFor(() => {
    fixture.detectChanges();
    check();
  });

beforeEach(() => {
  patches = [];
  settingsFail = false;
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ProjectSettingsSheet', () => {
  it('shows that Settings could not be loaded, not a loading row forever', async () => {
    settingsFail = true;
    const fixture = mountSheet(demo);
    await settle(fixture, () => expect(byTestId('project-settings-failed')).not.toBeNull());
    expect(byTestId('project-settings-loading')).toBeNull();
    expect(byTestId('project-permission')).toBeNull();
  });

  it('shows the inherited Default permission mode greyed, with nothing to clear', async () => {
    await open(demo);
    expect(get('project-permission').dataset['inherited']).toBe('true');
    expect(pressed('project-permission-auto')).toBe(true);
    expect(get('project-permission').textContent).toContain('From Settings');
    expect(byTestId('project-permission-clear')).toBeNull();
  });

  it('overrides the Default permission mode', async () => {
    const fixture = await open(demo);
    get('project-permission-ask').click();
    await settle(fixture, () => {
      expect(patches).toEqual([{ defaultPermissionMode: 'ask' }]);
      expect(get('project-permission').dataset['inherited']).toBe('false');
    });
    expect(pressed('project-permission-ask')).toBe(true);
    expect(byTestId('project-permission-clear')).not.toBeNull();
  });

  it('clears an override, going back to the inherited value', async () => {
    const fixture = await open({ ...demo, settings: { defaultPermissionMode: 'ask' } });
    expect(get('project-permission').dataset['inherited']).toBe('false');
    expect(pressed('project-permission-ask')).toBe(true);

    get('project-permission-clear').click();
    await settle(fixture, () => {
      expect(patches).toEqual([{ defaultPermissionMode: null }]);
      expect(get('project-permission').dataset['inherited']).toBe('true');
    });
    expect(pressed('project-permission-auto')).toBe(true);
  });

  it('locks global shortcuts while open, closes on Escape, and restores focus to the opener', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) },
        { provide: KEYMAP_PLATFORM, useValue: 'other' },
      ],
    });
    const opener = document.createElement('button');
    opener.textContent = 'Project settings';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const fixture = TestBed.createComponent(ProjectSettingsSheet);
    const state = TestBed.inject(ProjectSettingsState);
    const keymap = TestBed.inject(Keymap);
    const onGlobal = vi.fn();
    keymap.register({ binding: { mod: true, key: 'w' }, run: onGlobal });

    state.show(demo);
    await settle(fixture, () => expect(byTestId('project-permission')).not.toBeNull());

    expect(keymap.modalOpen()).toBe(true);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true }),
    );
    expect(onGlobal).not.toHaveBeenCalled();

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }),
    );
    fixture.detectChanges();

    expect(state.project()).toBeNull();
    expect(keymap.modalOpen()).toBe(false);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  });
});
