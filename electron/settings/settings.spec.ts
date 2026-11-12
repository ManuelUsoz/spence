import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Logger, Ref } from 'effect';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentId } from '../../src/shared/agents/agents.rpc';
import type {
  Language,
  Settings as SettingsValue,
  Theme,
} from '../../src/shared/settings/settings.rpc';
import { layerStore } from '../store/store';
import { layerRemembered, Remembered } from './remembered';
import { layerSettings, Settings, WindowSettings } from './settings';

const claude = AgentId.make('claude');

const DEFAULTS: SettingsValue = {
  language: 'system',
  theme: 'system',
  notifications: true,
  sidebarLayout: 'oneProject',
  projectOrder: { by: 'lastUsed', direction: 'desc' },
  defaultPermissionMode: 'auto',
  autoArchiveDays: null,
  agents: { [claude]: { model: 'lastUsed', effort: 'lastUsed', models: [], ran: false } },
};

type Applied = { readonly theme?: Theme; readonly language?: Language };

/** Runs `body` against a fresh store root, recording what was applied to the window and what was logged. */
const withSettings = <A, E>(
  body: (ctx: {
    readonly root: string;
    readonly applied: Ref.Ref<ReadonlyArray<Applied>>;
    readonly logs: ReadonlyArray<string>;
  }) => Effect.Effect<A, E, Settings | Remembered>,
) =>
  Effect.gen(function* () {
    const root = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), 'spence-settings-'))),
      (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
    );
    const applied = yield* Ref.make<ReadonlyArray<Applied>>([]);
    const logs: Array<string> = [];
    const window = Layer.succeed(WindowSettings, {
      applyTheme: (theme) => Ref.update(applied, (all) => [...all, { theme }]),
      applyLanguage: (language) => Ref.update(applied, (all) => [...all, { language }]),
    });
    const logger = Logger.make(({ message }) => {
      logs.push(String(message));
    });
    const layer = layerSettings.pipe(
      Layer.provideMerge(layerRemembered),
      Layer.provide(window),
      Layer.provide(layerStore(root)),
    );
    return yield* body({ root, applied, logs }).pipe(
      Effect.provide(layer),
      Effect.provide(Logger.layer([logger])),
    );
  }).pipe(Effect.scoped);

const put = (root: string, file: string, json: unknown) =>
  Effect.promise(async () => {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, file), JSON.stringify(json));
  });
const readJson = (root: string, file: string) =>
  Effect.promise(async (): Promise<unknown> =>
    JSON.parse(await readFile(path.join(root, file), 'utf8')),
  );

describe('Settings', () => {
  it.effect('resolves every Setting to its default when nothing is stored', () =>
    withSettings(() =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        expect(yield* settings.get).toStrictEqual(DEFAULTS);
      }),
    ),
  );

  it.effect('writes only the keys that differ from the defaults', () =>
    withSettings(({ root }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        const updated = yield* settings.update({ notifications: false, autoArchiveDays: 30 });
        expect(updated).toStrictEqual({ ...DEFAULTS, notifications: false, autoArchiveDays: 30 });
        expect(yield* readJson(root, 'settings.json')).toStrictEqual({
          version: 1,
          notifications: false,
          autoArchiveDays: 30,
        });

        yield* settings.update({ notifications: true, agents: { [claude]: { effort: 'high' } } });
        expect(yield* readJson(root, 'settings.json')).toStrictEqual({
          version: 1,
          autoArchiveDays: 30,
          agents: { claude: { model: 'lastUsed', effort: 'high' } },
        });
        expect((yield* settings.get).agents[claude]).toStrictEqual({
          model: 'lastUsed',
          effort: 'high',
          models: [],
          ran: false,
        });
      }),
    ),
  );

  it.effect(
    'falls back to the default for an invalid key, with a log line, and keeps the rest',
    () =>
      withSettings(({ root, logs }) =>
        Effect.gen(function* () {
          yield* put(root, 'settings.json', { version: 1, theme: 'purple', notifications: false });
          const settings = yield* Settings;
          expect(yield* settings.get).toStrictEqual({ ...DEFAULTS, notifications: false });
          expect(logs).toContainEqual(expect.stringContaining('"theme"'));
        }),
      ),
  );

  it.effect('applies a changed Theme or Language to the window, and nothing else', () =>
    withSettings(({ applied }) =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* settings.update({ theme: 'dark' });
        yield* settings.update({ theme: 'dark', notifications: false });
        yield* settings.update({ language: 'es' });
        expect(yield* Ref.get(applied)).toStrictEqual([{ theme: 'dark' }, { language: 'es' }]);
      }),
    ),
  );

  it.effect('refuses to overwrite a settings file from a newer Spence', () =>
    withSettings(({ root, applied }) =>
      Effect.gen(function* () {
        yield* put(root, 'settings.json', { version: 99, theme: 'dark' });
        const settings = yield* Settings;
        const error = yield* Effect.flip(settings.update({ theme: 'light' }));
        expect(error.reason).toBe('NewerVersion');
        expect(yield* readJson(root, 'settings.json')).toStrictEqual({
          version: 99,
          theme: 'dark',
        });
        expect(yield* Ref.get(applied)).toStrictEqual([]);
      }),
    ),
  );

  it.effect('tells an Agent that ran and offered no Models from one never run', () =>
    withSettings(() =>
      Effect.gen(function* () {
        const settings = yield* Settings;
        expect((yield* settings.get).agents[claude]?.ran).toBe(false);
        yield* Remembered.use((remembered) => remembered.rememberModels(claude, []));
        expect((yield* settings.get).agents[claude]).toMatchObject({ models: [], ran: true });
      }),
    ),
  );

  it.effect('includes the Models an Agent offered last time, remembered in state.json', () =>
    withSettings(({ root }) =>
      Effect.gen(function* () {
        const remembered = yield* Remembered;
        const models = [{ id: 'opus', name: 'Opus' }];
        yield* remembered.rememberModels(claude, models);
        yield* remembered.rememberLast(claude, { model: 'opus', effort: 'high' });

        const settings = yield* Settings;
        expect((yield* settings.get).agents[claude]?.models).toStrictEqual(models);
        expect(yield* remembered.get(claude)).toStrictEqual({
          lastModel: 'opus',
          lastEffort: 'high',
          models,
        });
        expect(yield* readJson(root, 'state.json')).toStrictEqual({
          version: 1,
          agents: { claude: { lastModel: 'opus', lastEffort: 'high', models } },
        });
      }),
    ),
  );
});
