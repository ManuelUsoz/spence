import { Layer } from 'effect';
import { SettingsRpcs } from '../../src/shared/settings/settings.rpc';
import { Settings } from '../settings/settings';
import { layerSettingsMain } from '../settings/window';

export const layerSettingsHandlers = SettingsRpcs.toLayer({
  'Settings.get': () => Settings.use((settings) => settings.get),
  'Settings.update': ({ patch }) => Settings.use((settings) => settings.update(patch)),
}).pipe(Layer.provide(layerSettingsMain));
