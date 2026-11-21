import { Effect, Layer, Queue, Stream } from 'effect';
import type { BrowserScreenshotResult, PageId } from '../../src/shared/browser/browser.rpc';
import { BrowserHost, type BrowserHostEvent, type BrowserHostPresentation } from './browser-host';

export interface FakeBrowserHost {
  readonly layer: Layer.Layer<BrowserHost>;
  readonly createdPages: Array<{ readonly pageId: PageId; readonly initialUrl: string }>;
  readonly closedPages: Array<PageId>;
  readonly loadedUrls: Array<{ readonly pageId: PageId; readonly url: string }>;
  readonly commands: Array<{
    readonly kind: 'goBack' | 'goForward' | 'reload';
    readonly pageId: PageId;
  }>;
  readonly devToolsOpenedFor: Array<PageId>;
  readonly externalUrls: Array<string>;
  readonly pickerActions: Array<{ readonly kind: 'start' | 'cancel'; readonly pageId: PageId }>;
  currentPresentation: BrowserHostPresentation | null;
  readonly emitHostEvent: (event: BrowserHostEvent) => void;
  readonly setScreenshot: (pageId: PageId, screenshot: BrowserScreenshotResult) => void;
}

const defaultScreenshot: BrowserScreenshotResult = {
  name: 'browser-screenshot.png',
  mimeType: 'image/png',
  data: 'iVBORw0KGgo=',
};

/** Deterministic in-memory `BrowserHost` test double for Vitest. */
export const makeFakeBrowserHost = (): FakeBrowserHost => {
  const createdPages: Array<{ readonly pageId: PageId; readonly initialUrl: string }> = [];
  const closedPages: Array<PageId> = [];
  const loadedUrls: Array<{ readonly pageId: PageId; readonly url: string }> = [];
  const commands: Array<{
    readonly kind: 'goBack' | 'goForward' | 'reload';
    readonly pageId: PageId;
  }> = [];
  const devToolsOpenedFor: Array<PageId> = [];
  const externalUrls: Array<string> = [];
  const pickerActions: Array<{ readonly kind: 'start' | 'cancel'; readonly pageId: PageId }> = [];
  const screenshots = new Map<PageId, BrowserScreenshotResult>();
  let inbox: Queue.Queue<BrowserHostEvent> | undefined;

  const fake: FakeBrowserHost = {
    createdPages,
    closedPages,
    loadedUrls,
    commands,
    devToolsOpenedFor,
    externalUrls,
    pickerActions,
    currentPresentation: null,
    emitHostEvent: (event) => {
      if (inbox !== undefined) Queue.offerUnsafe(inbox, event);
    },
    setScreenshot: (pageId, screenshot) => {
      screenshots.set(pageId, screenshot);
    },
    layer: Layer.effect(
      BrowserHost,
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<BrowserHostEvent>();
        inbox = queue;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            inbox = undefined;
          }),
        );
        return BrowserHost.of({
          createPage: (pageId, initialUrl) =>
            Effect.sync(() => {
              createdPages.push({ pageId, initialUrl });
            }),
          closePage: (pageId) =>
            Effect.sync(() => {
              closedPages.push(pageId);
              if (fake.currentPresentation?.pageId === pageId) {
                fake.currentPresentation = null;
              }
            }),
          loadUrl: (pageId, url) =>
            Effect.sync(() => {
              loadedUrls.push({ pageId, url });
            }),
          goBack: (pageId) =>
            Effect.sync(() => {
              commands.push({ kind: 'goBack', pageId });
            }),
          goForward: (pageId) =>
            Effect.sync(() => {
              commands.push({ kind: 'goForward', pageId });
            }),
          reload: (pageId) =>
            Effect.sync(() => {
              commands.push({ kind: 'reload', pageId });
            }),
          setPresentation: (presentation) =>
            Effect.sync(() => {
              fake.currentPresentation = presentation;
            }),
          openDevTools: (pageId) =>
            Effect.sync(() => {
              devToolsOpenedFor.push(pageId);
            }),
          openExternal: (url) =>
            Effect.sync(() => {
              externalUrls.push(url);
            }),
          captureScreenshot: (pageId) =>
            Effect.succeed(screenshots.get(pageId) ?? defaultScreenshot),
          startElementPicker: (pageId) =>
            Effect.sync(() => {
              pickerActions.push({ kind: 'start', pageId });
            }),
          cancelElementPicker: (pageId) =>
            Effect.sync(() => {
              pickerActions.push({ kind: 'cancel', pageId });
            }),
          events: Stream.fromQueue(queue),
        });
      }),
    ),
  };

  return fake;
};
