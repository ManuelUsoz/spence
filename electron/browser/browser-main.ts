import { Layer } from 'effect';
import { layerAgentLifetimeMain } from '../acp/acpMain';
import { layerSettingsMain } from '../settings/window';
import { layerStoreUserData } from '../store/store';
import { layerBrowserService } from './browser-service';
import { layerBrowserStore } from './browser-store';
import { layerElectronBrowserHost } from './electron-browser-host';

/**
 * The app's single `BrowserService` over `WebContentsView`. Provide this exact reference wherever main or RPC
 * handlers touch Browser state so Effect memoizes one instance across `MainRuntime`.
 */
export const layerBrowserMain = layerBrowserService.pipe(
  Layer.provide(layerElectronBrowserHost),
  Layer.provide(layerBrowserStore.pipe(Layer.provide(layerStoreUserData))),
  Layer.provide(layerAgentLifetimeMain),
  Layer.provide(layerSettingsMain),
);
