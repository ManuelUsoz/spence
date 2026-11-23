import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProjectId,
  ProjectsRpcs,
  type Project,
  type ProjectSettingsPatch,
} from '../../../../shared/projects/projects.rpc';
import {
  ExecutionSettingsRpcs,
  type ExecutionSettings,
} from '../../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { ProjectsState } from '../projects-state';
import { SettingsProjects } from './settings-projects';
import { SettingsState } from '../settings-state';

// jsdom does not implement the layout APIs used by Helm Select.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof ResizeObserver === 'undefined') {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
}

const settings: ExecutionSettings = {
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  subagents: 'workers' as const,
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
let saveFail = false;
let current: Project = demo;

/** Main applies the patch as `Projects.setSettings` does: `null` clears the key. */
const apply = (project: Project, patch: ProjectSettingsPatch): Project => {
  let settings = project.settings;
  if (patch.defaultPermissionMode !== undefined) {
    const { defaultPermissionMode: _cleared, ...rest } = settings;
    settings =
      patch.defaultPermissionMode === null
        ? rest
        : { ...rest, defaultPermissionMode: patch.defaultPermissionMode };
  }
  if (patch.worktreeSetupCommand !== undefined) {
    const { worktreeSetupCommand: _cleared, ...rest } = settings;
    const trimmed = patch.worktreeSetupCommand === null ? '' : patch.worktreeSetupCommand.trim();
    settings = trimmed.length === 0 ? rest : { ...rest, worktreeSetupCommand: trimmed };
  }
  return { ...project, settings };
};

const handlers = Layer.mergeAll(
  ExecutionSettingsRpcs.toLayer({
    'ExecutionSettings.get': () =>
      settingsFail ? Effect.die('Settings unreadable') : Effect.succeed(settings),
    'ExecutionSettings.update': () => Effect.die('not served'),
  }),
  ProjectsRpcs.toLayer({
    'Projects.list': () =>
      Effect.succeed([
        current,
        { ...demo, id: ProjectId.make('p2'), path: '/other/demo-project', folderMissing: true },
      ]),
    'Projects.add': () => Effect.die('not served'),
    'Projects.rename': () => Effect.die('not served'),
    'Projects.remove': () => Effect.die('not served'),
    'Projects.locate': () => Effect.die('not served'),
    'Projects.addFolder': () => Effect.die('unused'),
    'Projects.locateFolder': () => Effect.die('unused'),
    'Projects.check': () => Effect.die('not served'),
    'Projects.setSettings': ({ patch }) =>
      saveFail
        ? Effect.die('Could not save')
        : Effect.sync(() => {
            patches.push(patch);
            current = apply(current, patch);
            return current;
          }),
  }),
);

const mount = (project: Project): ComponentFixture<SettingsProjects> => {
  current = project;
  TestBed.configureTestingModule({
    providers: [{ provide: DESKTOP_LAYER, useValue: makeDesktopTestLayer(handlers) }],
  });
  const fixture = TestBed.createComponent(SettingsProjects);
  return fixture;
};

const trigger = (): HTMLButtonElement => {
  const element = document.querySelector('[data-testid="project-permission"] button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('Missing permission selector');
  return element;
};

const choose = async (
  fixture: ComponentFixture<SettingsProjects>,
  value: string,
): Promise<void> => {
  trigger().click();
  await settle(fixture, () => {
    const option = document.querySelector<HTMLElement>(`[data-testid="project-mode-${value}"]`);
    if (option === null) throw new Error('Missing permission option');
    option.click();
  });
};

const settle = (fixture: ComponentFixture<SettingsProjects>, check: () => void) =>
  vi.waitFor(() => {
    fixture.detectChanges();
    check();
  });

beforeEach(() => {
  patches = [];
  settingsFail = false;
  saveFail = false;
});

describe('SettingsProjects', () => {
  it('shows both project settings inline and scrolls to the project from the shortcut', async () => {
    const fixture = mount(demo);
    const rows = () =>
      document.querySelectorAll<HTMLElement>('[data-testid="settings-project-row"]');
    await settle(fixture, () => expect(rows()).toHaveLength(2));
    expect(rows()[0]?.textContent).toContain('/work/demo-project');
    expect(rows()[1]?.textContent).toContain('/other/demo-project');
    const row = rows()[1];
    if (row === undefined) throw new Error('Missing second project');
    const scroll = vi.fn();
    row.scrollIntoView = scroll;
    TestBed.inject(SettingsState).showProject(ProjectId.make('p2'));
    await settle(fixture, () => expect(scroll).toHaveBeenCalledOnce());
    await settle(fixture, () =>
      expect(document.querySelectorAll('[data-testid="project-permission"]')).toHaveLength(2),
    );
  });

  it('shows the settings load error', async () => {
    settingsFail = true;
    const fixture = mount(demo);
    await settle(fixture, () =>
      expect(document.querySelector('[data-testid="project-settings-failed"]')).not.toBeNull(),
    );
  });

  it('sets an explicit mode that matches the default and can clear it again', async () => {
    const fixture = mount(demo);
    await settle(fixture, () =>
      expect(trigger().textContent?.trim()).toBe('Use global default (Auto)'),
    );
    await choose(fixture, 'auto');
    await settle(fixture, () => {
      expect(patches).toEqual([{ defaultPermissionMode: 'auto' }]);
      expect(trigger().disabled).toBe(false);
      expect(trigger().textContent?.trim()).toBe('Auto');
    });
    await choose(fixture, 'inherit');
    await settle(fixture, () => {
      expect(patches).toEqual([{ defaultPermissionMode: 'auto' }, { defaultPermissionMode: null }]);
      expect(trigger().disabled).toBe(false);
      expect(trigger().textContent?.trim()).toBe('Use global default (Auto)');
    });
  });

  it('restores the previous selection when saving fails', async () => {
    saveFail = true;
    const fixture = mount({ ...demo, settings: { defaultPermissionMode: 'auto' } });
    await settle(fixture, () => expect(trigger().textContent?.trim()).toBe('Auto'));
    await choose(fixture, 'ask');
    await settle(fixture, () => {
      expect(trigger().disabled).toBe(false);
      expect(trigger().textContent?.trim()).toBe('Auto');
    });
  });

  it('saves and clears the worktree setup command on blur', async () => {
    const fixture = mount(demo);
    const input = () =>
      document.querySelector<HTMLInputElement>('[data-testid="project-worktree-setup"]');
    await settle(fixture, () => expect(input()).not.toBeNull());
    const el = input();
    if (el === null) throw new Error('Missing setup input');
    el.value = 'pnpm install --frozen-lockfile';
    el.dispatchEvent(new Event('blur'));
    const projects = TestBed.inject(ProjectsState);
    await settle(fixture, () => {
      expect(patches).toEqual([{ worktreeSetupCommand: 'pnpm install --frozen-lockfile' }]);
      expect(projects.ordered()[0]?.settings.worktreeSetupCommand).toBe(
        'pnpm install --frozen-lockfile',
      );
    });

    el.value = '   ';
    el.dispatchEvent(new Event('blur'));
    await settle(fixture, () => {
      expect(patches).toEqual([
        { worktreeSetupCommand: 'pnpm install --frozen-lockfile' },
        { worktreeSetupCommand: null },
      ]);
    });
  });
});
