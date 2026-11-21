import { Effect, Layer, Queue, Stream } from 'effect';
import type { PageId } from '../../src/shared/browser/browser.rpc';
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
  readonly capturedPageIds: Array<PageId>;
  currentPresentation: BrowserHostPresentation | null;
  readonly setFrameDataUrl: (pageId: PageId, dataUrl: string | undefined) => void;
  readonly emitHostEvent: (event: BrowserHostEvent) => void;
}

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
  const capturedPageIds: Array<PageId> = [];
  const frameDataUrls = new Map<PageId, string>();
  let inbox: Queue.Queue<BrowserHostEvent> | undefined;

  const fake: FakeBrowserHost = {
    createdPages,
    closedPages,
    loadedUrls,
    commands,
    devToolsOpenedFor,
    externalUrls,
    capturedPageIds,
    currentPresentation: null,
    setFrameDataUrl: (pageId, dataUrl) => {
      if (dataUrl === undefined) frameDataUrls.delete(pageId);
      else frameDataUrls.set(pageId, dataUrl);
    },
    emitHostEvent: (event) => {
      if (inbox !== undefined) Queue.offerUnsafe(inbox, event);
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
          capturePageDataUrl: (pageId) =>
            Effect.sync(() => {
              capturedPageIds.push(pageId);
              return frameDataUrls.get(pageId);
            }),
          openDevTools: (pageId) =>
            Effect.sync(() => {
              devToolsOpenedFor.push(pageId);
            }),
          openExternal: (url) =>
            Effect.sync(() => {
              externalUrls.push(url);
            }),
          events: Stream.fromQueue(queue),
        });
      }),
    ),
  };

  return fake;
};
