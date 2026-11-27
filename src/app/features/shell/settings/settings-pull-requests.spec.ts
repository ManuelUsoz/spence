import { TestBed } from '@angular/core/testing';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { AgentsRpcs } from '../../../../shared/agents/agents.rpc';
import {
  DEFAULT_PULL_REQUEST_SETTINGS,
  SettingsRpcs,
  type Settings,
  type SettingsPatch,
} from '../../../../shared/settings/settings.rpc';
import { makeDesktopTestLayer } from '../../../core/desktop-layers';
import { DESKTOP_LAYER } from '../../../core/effect-runtime';
import { SettingsPullRequests } from './settings-pull-requests';
import { SettingsStore } from './settings-store';

const baseSettings: Settings = {
  language: 'en',
  theme: 'system',
  notifications: true,
  sendMode: 'queue',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  crossProjectAccess: [],
  browserAllowedOrigins: [],
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: 30,
  subagents: 'workers',
  agents: {},
  pullRequests: DEFAULT_PULL_REQUEST_SETTINGS,
};

describe('SettingsPullRequests', () => {
  it('displays and updates worktreeBranchPattern via Settings.update', async () => {
    const patches: SettingsPatch[] = [];
    const layer = makeDesktopTestLayer(
      Layer.mergeAll(
        SettingsRpcs.toLayer({
          'Settings.get': () => Effect.succeed(baseSettings),
          'Settings.update': ({ patch }) => {
            patches.push(patch);
            return Effect.succeed({
              ...baseSettings,
              ...(patch.pullRequests === undefined ? {} : { pullRequests: patch.pullRequests }),
            });
          },
        }),
        AgentsRpcs.toLayer({
          'Agents.list': () => Effect.succeed([]),
          'Agents.rescan': () => Effect.succeed([]),
          'Agents.install': () => Effect.die('unused'),
          'Agents.cancelInstall': () => Effect.void,
          'Agents.installStatus': () => Effect.die('unused'),
          'Agents.openInstallLog': () => Effect.die('unused'),
        }),
      ),
    );

    TestBed.configureTestingModule({
      imports: [SettingsPullRequests],
      providers: [SettingsStore, { provide: DESKTOP_LAYER, useValue: layer }],
    });

    const fixture = TestBed.createComponent(SettingsPullRequests);
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    const input = fixture.nativeElement.querySelector(
      '[data-testid="settings-pr-branch-pattern"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.value).toBe('pr/{number}');

    if (input) {
      input.value = 'review/{number}-{author}';
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('blur'));
    }
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(patches).toHaveLength(1);
    expect(patches[0]?.pullRequests?.worktreeBranchPattern).toBe('review/{number}-{author}');
  });
});
