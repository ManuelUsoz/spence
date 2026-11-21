import { Context, type Effect, type Stream } from 'effect';
import type {
  BrowserBounds,
  BrowserConsoleError,
  BrowserError,
  BrowserScreenshotResult,
  PageId,
  PickedElement,
} from '../../src/shared/browser/browser.rpc';

export interface BrowserHostPresentation {
  readonly pageId: PageId;
  readonly bounds: BrowserBounds;
  readonly visible: boolean;
}

export type BrowserHostEvent =
  | {
      readonly _tag: 'PageUpdated';
      readonly pageId: PageId;
      readonly url?: string;
      readonly title?: string;
      readonly loading?: boolean;
      readonly canGoBack?: boolean;
      readonly canGoForward?: boolean;
    }
  | {
      readonly _tag: 'PopupRequested';
      readonly openerPageId: PageId;
      readonly url: string;
    }
  | {
      readonly _tag: 'PageClosed';
      readonly pageId: PageId;
    }
  | {
      readonly _tag: 'ConsoleError';
      readonly pageId: PageId;
      readonly error: BrowserConsoleError;
    }
  | {
      readonly _tag: 'ElementPicked';
      readonly pageId: PageId;
      readonly element: PickedElement;
    }
  | {
      readonly _tag: 'ElementPickerCancelled';
      readonly pageId: PageId;
    };

export interface BrowserHostShape {
  readonly createPage: (pageId: PageId, initialUrl: string) => Effect.Effect<void>;
  readonly closePage: (pageId: PageId) => Effect.Effect<void>;
  readonly loadUrl: (pageId: PageId, url: string) => Effect.Effect<void, BrowserError>;
  readonly goBack: (pageId: PageId) => Effect.Effect<void>;
  readonly goForward: (pageId: PageId) => Effect.Effect<void>;
  readonly reload: (pageId: PageId) => Effect.Effect<void>;
  readonly setPresentation: (presentation: BrowserHostPresentation | null) => Effect.Effect<void>;
  readonly capturePageDataUrl?: (pageId: PageId) => Effect.Effect<string | undefined>;
  readonly openDevTools: (pageId: PageId) => Effect.Effect<void, BrowserError>;
  readonly openExternal: (url: string) => Effect.Effect<void, BrowserError>;
  // #215 Composer bridge
  readonly captureScreenshot: (
    pageId: PageId,
  ) => Effect.Effect<BrowserScreenshotResult, BrowserError>;
  readonly startElementPicker: (pageId: PageId) => Effect.Effect<void, BrowserError>;
  readonly cancelElementPicker: (pageId: PageId) => Effect.Effect<void>;
  readonly events: Stream.Stream<BrowserHostEvent>;
}

/** Thin Effect seam over Electron's `WebContentsView`, `BrowserWindow.contentView`, `persist:spence-browser` session, and `shell`. */
export class BrowserHost extends Context.Service<BrowserHost, BrowserHostShape>()(
  'browser/BrowserHost',
) {}
