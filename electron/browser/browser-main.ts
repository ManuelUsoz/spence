import { Layer } from 'effect';
import { layerBrowserService } from './browser-service';
import { layerElectronBrowserHost } from './electron-browser-host';

/**
 * The app's single `BrowserService` over `WebContentsView`. Provide this exact reference wherever main or RPC
 * handlers touch Browser state so Effect memoizes one instance across `MainRuntime`.
 */
export const layerBrowserMain = layerBrowserService.pipe(Layer.provide(layerElectronBrowserHost));
