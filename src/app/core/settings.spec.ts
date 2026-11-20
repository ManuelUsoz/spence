import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { AgentId } from '../../shared/agents/agents.rpc';
import {
  SettingsError,
  SettingsRpcs,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings/settings.rpc';
import { DesktopApi } from './desktop-api';
import { makeDesktopTestLayer } from './desktop-layers';

const claude = AgentId.make('claude');

const settings: Settings = {
  language: 'system',
  theme: 'system',
  notifications: true,
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  defaultAgent: 'claude',
  autoArchiveDays: null,
  crossProjectAccess: [],
  filesTreeWidth: 288,
  agents: {
    [claude]: {
      model: 'opus',
      effort: 'lastUsed',
      models: [{ id: 'opus', name: 'Opus' }],
      ran: true,
    },
  },
};

const handlers = SettingsRpcs.toLayer({
  'Settings.get': () => Effect.succeed(settings),
  'Settings.update': ({ patch }: { readonly patch: SettingsPatch }) =>
    patch.language === 'es'
      ? Effect.fail(new SettingsError({ reason: 'NewerVersion', detail: 'settings.json is v2' }))
      : Effect.succeed({ ...settings, ...patch, agents: settings.agents }),
});

describe('DesktopApi Settings', () => {
  it.effect('serves the resolved Settings and an update through the real contract', () =>
    Effect.gen(function* () {
      const api = yield* DesktopApi;
      expect(yield* api['Settings.get']()).toEqual(settings);
      expect(yield* api['Settings.update']({ patch: { theme: 'dark' } })).toEqual({
        ...settings,
        theme: 'dark',
      });
      const error = yield* Effect.flip(api['Settings.update']({ patch: { language: 'es' } }));
      expect(error).toBeInstanceOf(SettingsError);
    }).pipe(Effect.provide(makeDesktopTestLayer(handlers))),
  );
});
