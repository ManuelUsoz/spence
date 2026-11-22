import { Layer } from 'effect';
import { layerBrowserMain } from '../browser/browser-main';
import { layerBrowserServiceHandlers } from './browser-handlers';

export const layerBrowserHandlers = layerBrowserServiceHandlers.pipe(
  Layer.provide(layerBrowserMain),
);
