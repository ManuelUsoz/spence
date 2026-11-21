import { Effect, Stream } from 'effect';
import { BrowserRpcs } from '../../src/shared/browser/browser.rpc';
import { BrowserService } from '../browser/browser-service';

/** Pure RPC controller mapping `BrowserRpcs` to `BrowserService` (with no Electron import). */
export const layerBrowserServiceHandlers = BrowserRpcs.toLayer({
  'Browser.getState': ({ sessionId }) =>
    BrowserService.use((browser) => browser.getState(sessionId)),
  'Browser.setOpen': ({ sessionId, open }) =>
    BrowserService.use((browser) => browser.setOpen(sessionId, open)),
  'Browser.setWidth': ({ sessionId, width }) =>
    BrowserService.use((browser) => browser.setWidth(sessionId, width)),
  'Browser.setActiveSession': ({ sessionId }) =>
    BrowserService.use((browser) => browser.setActiveSession(sessionId)),
  'Browser.setBounds': ({ sessionId, bounds }) =>
    BrowserService.use((browser) => browser.setBounds(sessionId, bounds)),
  // Occlusion (#214)
  'Browser.setOccluded': ({ occluded, captureFrame }) =>
    BrowserService.use((browser) => browser.setOccluded(occluded, captureFrame)),
  'Browser.navigate': ({ sessionId, url }) =>
    BrowserService.use((browser) => browser.navigate(sessionId, url)),
  'Browser.goBack': ({ sessionId }) => BrowserService.use((browser) => browser.goBack(sessionId)),
  'Browser.goForward': ({ sessionId }) =>
    BrowserService.use((browser) => browser.goForward(sessionId)),
  'Browser.reload': ({ sessionId }) => BrowserService.use((browser) => browser.reload(sessionId)),
  'Browser.openExternal': ({ sessionId }) =>
    BrowserService.use((browser) => browser.openExternal(sessionId)),
  'Browser.openDevTools': ({ sessionId }) =>
    BrowserService.use((browser) => browser.openDevTools(sessionId)),
  // #213: Multi-Page management
  'Browser.createPage': ({ sessionId, url }) =>
    BrowserService.use((browser) => browser.createPage(sessionId, url)),
  'Browser.selectPage': ({ sessionId, pageId }) =>
    BrowserService.use((browser) => browser.selectPage(sessionId, pageId)),
  'Browser.closePage': ({ sessionId, pageId }) =>
    BrowserService.use((browser) => browser.closePage(sessionId, pageId)),
  // #215 Composer bridge
  'Browser.captureScreenshot': ({ sessionId }) =>
    BrowserService.use((browser) => browser.captureScreenshot(sessionId)),
  'Browser.startElementPicker': ({ sessionId }) =>
    BrowserService.use((browser) => browser.startElementPicker(sessionId)),
  'Browser.cancelElementPicker': ({ sessionId }) =>
    BrowserService.use((browser) => browser.cancelElementPicker(sessionId)),
  'Browser.getConsoleErrors': ({ sessionId }) =>
    BrowserService.use((browser) => browser.getConsoleErrors(sessionId)),
  'Browser.events': () =>
    Stream.unwrap(BrowserService.use((browser) => Effect.succeed(browser.events))),
});
