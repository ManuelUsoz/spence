import { Effect, Layer, Queue, Stream } from 'effect';
import {
  type BrowserError,
  type BrowserScreenshotResult,
  type PageId,
} from '../../src/shared/browser/browser.rpc';
import { isAllowedPopupUrl } from '../../src/shared/browser/url-policy';
import {
  type BrowserElementTarget,
  type BrowserEvalResult,
  BrowserHost,
  type BrowserHostEvent,
  type BrowserHostPresentation,
  type BrowserPageSnapshot,
  type BrowserWaitCondition,
} from './browser-host';

export type FakeBrowserInteraction =
  | {
      readonly kind: 'click';
      readonly pageId: PageId;
      readonly target: BrowserElementTarget;
      readonly options?: {
        readonly button?: 'left' | 'right' | 'middle';
        readonly clickCount?: number;
      };
    }
  | {
      readonly kind: 'fill';
      readonly pageId: PageId;
      readonly target: BrowserElementTarget;
      readonly value: string;
    }
  | {
      readonly kind: 'type';
      readonly pageId: PageId;
      readonly text: string;
      readonly target?: BrowserElementTarget;
    }
  | {
      readonly kind: 'press';
      readonly pageId: PageId;
      readonly key: string;
      readonly target?: BrowserElementTarget;
    }
  | {
      readonly kind: 'select';
      readonly pageId: PageId;
      readonly target: BrowserElementTarget;
      readonly values: ReadonlyArray<string>;
    }
  | { readonly kind: 'hover'; readonly pageId: PageId; readonly target: BrowserElementTarget }
  | {
      readonly kind: 'scroll';
      readonly pageId: PageId;
      readonly options: {
        readonly direction?: 'up' | 'down' | 'left' | 'right';
        readonly amount?: number;
        readonly target?: BrowserElementTarget;
      };
    };

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
  readonly capturedPageIds: Array<PageId>;
  readonly interactions: Array<FakeBrowserInteraction>;
  readonly waits: Array<{ readonly pageId: PageId; readonly condition: BrowserWaitCondition }>;
  readonly evals: Array<{ readonly pageId: PageId; readonly expression: string }>;
  clearDataCount: number;
  currentPresentation: BrowserHostPresentation | null;
  readonly setFrameDataUrl: (pageId: PageId, dataUrl: string | undefined) => void;
  readonly emitHostEvent: (event: BrowserHostEvent) => void;
  readonly setScreenshot: (pageId: PageId, screenshot: BrowserScreenshotResult) => void;
  readonly setSnapshot: (pageId: PageId, snapshot: BrowserPageSnapshot) => void;
  readonly setEvalResult: (pageId: PageId, result: BrowserEvalResult) => void;
  readonly setNextError: (error: BrowserError | undefined) => void;
  readonly simulateRedirect: (pageId: PageId, url: string) => boolean;
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
  const snapshots = new Map<PageId, BrowserPageSnapshot>();
  const evalResults = new Map<PageId, BrowserEvalResult>();
  const capturedPageIds: Array<PageId> = [];
  const frameDataUrls = new Map<PageId, string>();
  const interactions: Array<FakeBrowserInteraction> = [];
  const waits: Array<{ readonly pageId: PageId; readonly condition: BrowserWaitCondition }> = [];
  const evals: Array<{ readonly pageId: PageId; readonly expression: string }> = [];
  let nextError: BrowserError | undefined;
  let redirectGuard: ((pageId: PageId, url: string) => boolean) | undefined;
  let inbox: Queue.Queue<BrowserHostEvent> | undefined;

  const consumeError = (): BrowserError | undefined => {
    const err = nextError;
    nextError = undefined;
    return err;
  };

  const fake: FakeBrowserHost = {
    createdPages,
    closedPages,
    loadedUrls,
    commands,
    devToolsOpenedFor,
    externalUrls,
    pickerActions,
    capturedPageIds,
    interactions,
    waits,
    evals,
    clearDataCount: 0,
    currentPresentation: null,
    setFrameDataUrl: (pageId, dataUrl) => {
      if (dataUrl === undefined) frameDataUrls.delete(pageId);
      else frameDataUrls.set(pageId, dataUrl);
    },
    emitHostEvent: (event) => {
      if (inbox !== undefined) Queue.offerUnsafe(inbox, event);
    },
    setScreenshot: (pageId, screenshot) => {
      screenshots.set(pageId, screenshot);
    },
    setSnapshot: (pageId, snapshot) => {
      snapshots.set(pageId, snapshot);
    },
    setEvalResult: (pageId, result) => {
      evalResults.set(pageId, result);
    },
    setNextError: (error) => {
      nextError = error;
    },
    simulateRedirect: (pageId, url) => {
      const allowedScheme = url === 'about:blank' || isAllowedPopupUrl(url);
      if (!allowedScheme || (redirectGuard !== undefined && !redirectGuard(pageId, url))) {
        if (inbox !== undefined) Queue.offerUnsafe(inbox, { _tag: 'RedirectBlocked', pageId, url });
        return false;
      }
      return true;
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
          setRedirectGuard: (guard) =>
            Effect.sync(() => {
              redirectGuard = guard;
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
          clearBrowsingData: () =>
            Effect.sync(() => {
              fake.clearDataCount += 1;
            }),
          snapshot: (pageId) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              return Effect.succeed(
                snapshots.get(pageId) ?? {
                  pageId,
                  url: 'about:blank',
                  title: '',
                  snapshot: '- RootWebArea',
                  refCount: 0,
                },
              );
            }),
          click: (pageId, target, options) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({
                kind: 'click',
                pageId,
                target,
                ...(options === undefined ? {} : { options }),
              });
              return Effect.succeed({ ok: true as const });
            }),
          fill: (pageId, target, value) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({ kind: 'fill', pageId, target, value });
              return Effect.succeed({ ok: true as const });
            }),
          type: (pageId, text, target) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({
                kind: 'type',
                pageId,
                text,
                ...(target === undefined ? {} : { target }),
              });
              return Effect.succeed({ ok: true as const });
            }),
          press: (pageId, key, target) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({
                kind: 'press',
                pageId,
                key,
                ...(target === undefined ? {} : { target }),
              });
              return Effect.succeed({ ok: true as const });
            }),
          select: (pageId, target, values) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({ kind: 'select', pageId, target, values });
              return Effect.succeed({ ok: true as const });
            }),
          hover: (pageId, target) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({ kind: 'hover', pageId, target });
              return Effect.succeed({ ok: true as const });
            }),
          scroll: (pageId, options) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              interactions.push({ kind: 'scroll', pageId, options });
              return Effect.succeed({ ok: true as const });
            }),
          waitFor: (pageId, condition) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              waits.push({ pageId, condition });
              return Effect.succeed({ ok: true as const });
            }),
          evaluate: (pageId, expression) =>
            Effect.suspend(() => {
              const err = consumeError();
              if (err !== undefined) return Effect.fail(err);
              evals.push({ pageId, expression });
              return Effect.succeed(evalResults.get(pageId) ?? { value: null, type: 'object' });
            }),
          events: Stream.fromQueue(queue),
        });
      }),
    ),
  };

  return fake;
};
