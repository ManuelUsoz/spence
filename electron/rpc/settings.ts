import { Effect, Layer } from 'effect';
import { ExecutionSettingsRpcs, SettingsRpcs } from '../../src/shared/settings/settings.rpc';
import { executionOf, Settings } from '../settings/settings';
import { layerSettingsMain } from '../settings/window';

export const layerSettingsHandlers = SettingsRpcs.toLayer({
  'Settings.get': () => Settings.use((settings) => settings.get),
  'Settings.update': ({ patch }) => Settings.use((settings) => settings.update(patch)),
}).pipe(Layer.provide(layerSettingsMain));

/** Unbound: needs `Settings`, so a test Device can serve it over its own Store. */
export const layerExecutionSettingsHandlersWith = ExecutionSettingsRpcs.toLayer({
  'ExecutionSettings.get': () => Settings.use((settings) => Effect.map(settings.get, executionOf)),
  'ExecutionSettings.update': ({ patch }) =>
    Settings.use((settings) => Effect.map(settings.update(patch), executionOf)),
});

/** The same `Settings` as `layerSettingsHandlers` (one memoized `layerSettingsMain`). */
export const layerExecutionSettingsHandlers = layerExecutionSettingsHandlersWith.pipe(
  Layer.provide(layerSettingsMain),
);
