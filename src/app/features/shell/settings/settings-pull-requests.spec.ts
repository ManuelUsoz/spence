import { TestBed } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AgentsRpcs } from '../../../../shared/agents/agents.rpc';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  SettingsRpcs,
  type Settings,
} from '../../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { SettingsPullRequests } from './settings-pull-requests';
import { SettingsStore } from './settings-store';

const baseSettings: Settings = {
  pullRequests: DEFAULT_PULL_REQUEST_SETTINGS,
  language: 'en',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder: { by: 'name', direction: 'asc' },
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: 7,
  subagents: 'native',
  agents: {},
};

describe('SettingsPullRequests', () => {
  it('shows autoUpdateBaseBranchAfterMerge enabled by default and persists changes', async () => {
    let state = baseSettings;
    const patches: Array<boolean> = [];

    const layer = makeDesktopTestLayer(
      Layer.mergeAll(
        AgentsRpcs.toLayer({
          'Agents.list': () => Effect.succeed([]),
          'Agents.rescan': () => Effect.succeed([]),
          'Agents.install': () => Effect.die('unused'),
          'Agents.cancelInstall': () => Effect.void,
          'Agents.installStatus': () => Effect.die('unused'),
          'Agents.openInstallLog': () => Effect.void,
        }),
        SettingsRpcs.toLayer({
          'Settings.get': () => Effect.succeed(state),
          'Settings.update': ({ patch }) =>
            Effect.sync(() => {
              if (patch.pullRequests !== undefined) {
                patches.push(patch.pullRequests.autoUpdateBaseBranchAfterMerge);
                state = { ...state, pullRequests: patch.pullRequests };
              }
              return state;
            }),
        }),
      ),
    );

    TestBed.configureTestingModule({
      imports: [SettingsPullRequests],
      providers: [SettingsStore, { provide: DESKTOP_LAYER, useValue: layer }],
    });

    const fixture = TestBed.createComponent(SettingsPullRequests);
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 30));
    fixture.detectChanges();

    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="settings-pr-auto-update-base"]',
    ) as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(
      toggle?.getAttribute('aria-checked') ??
        toggle?.querySelector('[aria-checked]')?.getAttribute('aria-checked'),
    ).toBe('true');

    const btn = toggle?.querySelector('button') ?? toggle;
    btn?.click();
    await new Promise((r) => setTimeout(r, 30));
    fixture.detectChanges();

    expect(patches).toEqual([false]);
  });
});
