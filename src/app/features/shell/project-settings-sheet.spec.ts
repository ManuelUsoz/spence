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
let current: Project = demo;

/** Main applies the patch as `Projects.setSettings` does: `null` clears the key. */
const apply = (project: Project, patch: ProjectSettingsPatch): Project => {
  const mode = patch.defaultPermissionMode;
  if (mode === undefined) return project;
  return { ...project, settings: mode === null ? {} : { defaultPermissionMode: mode } };
};

const handlers = Layer.mergeAll(
  SettingsRpcs.toLayer({
    'Settings.get': () => Effect.succeed(settings),
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

const open = async (project: Project): Promise<ComponentFixture<ProjectSettingsSheet>> => {
  current = project;
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });
  const fixture = TestBed.createComponent(ProjectSettingsSheet);
  TestBed.inject(ProjectSettingsState).show(project);
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
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ProjectSettingsSheet', () => {
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
});
