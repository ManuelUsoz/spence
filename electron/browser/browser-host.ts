import { Context, type Effect, type Stream } from 'effect';
import type {
  BrowserBounds,
  BrowserConsoleError,
  BrowserError,
  BrowserScreenshotResult,
  PageId,
  PickedElement,
} from '../../src/shared/browser/browser.rpc';
import type { NetworkLogEntryInput } from './redaction';

export type BrowserConsoleLogLevel = 'info' | 'warning' | 'error' | 'debug';

export interface BrowserConsoleLogEntry {
  readonly level: BrowserConsoleLogLevel;
  readonly message: string;
  readonly source?: string;
  readonly lineNumber?: number;
  readonly at: number;
}

export type BrowserNetworkEntry = NetworkLogEntryInput;

export interface BrowserElementTarget {
  readonly ref?: string;
  readonly selector?: string;
  readonly text?: string;
}

export interface BrowserPageSnapshot {
  readonly pageId: PageId;
  readonly url: string;
  readonly title: string;
  readonly snapshot: string;
  readonly refCount: number;
}

export interface BrowserActionResult {
  readonly ok: true;
  readonly detail?: string;
}

export interface BrowserWaitCondition {
  readonly text?: string;
  readonly url?: string;
  readonly selector?: string;
  readonly timeoutMs?: number;
}

export interface BrowserEvalResult {
  readonly value: unknown;
  readonly type: string;
}

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
      readonly _tag: 'ConsoleEntry';
      readonly pageId: PageId;
      readonly entry: BrowserConsoleLogEntry;
    }
  | {
      readonly _tag: 'NetworkEntry';
      readonly pageId: PageId;
      readonly entry: BrowserNetworkEntry;
    }
  | {
      readonly _tag: 'ElementPicked';
      readonly pageId: PageId;
      readonly element: PickedElement;
    }
  | {
      readonly _tag: 'ElementPickerCancelled';
      readonly pageId: PageId;
    }
  | {
      readonly _tag: 'RedirectBlocked';
      readonly pageId: PageId;
      readonly url: string;
    };

export interface BrowserHostShape {
  readonly createPage: (pageId: PageId, initialUrl: string) => Effect.Effect<void>;
  readonly closePage: (pageId: PageId) => Effect.Effect<void>;
  readonly loadUrl: (pageId: PageId, url: string) => Effect.Effect<void, BrowserError>;
  readonly setRedirectGuard?: (
    guard: (pageId: PageId, url: string) => boolean,
  ) => Effect.Effect<void>;
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
  // #216 Clear browsing data
  readonly clearBrowsingData: () => Effect.Effect<void, BrowserError>;
  // #217 Agent CDP automation
  readonly snapshot: (pageId: PageId) => Effect.Effect<BrowserPageSnapshot, BrowserError>;
  readonly click: (
    pageId: PageId,
    target: BrowserElementTarget,
    options?: { readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: number },
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly fill: (
    pageId: PageId,
    target: BrowserElementTarget,
    value: string,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly type: (
    pageId: PageId,
    text: string,
    target?: BrowserElementTarget,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly press: (
    pageId: PageId,
    key: string,
    target?: BrowserElementTarget,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly select: (
    pageId: PageId,
    target: BrowserElementTarget,
    values: ReadonlyArray<string>,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly hover: (
    pageId: PageId,
    target: BrowserElementTarget,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly scroll: (
    pageId: PageId,
    options: {
      readonly direction?: 'up' | 'down' | 'left' | 'right';
      readonly amount?: number;
      readonly target?: BrowserElementTarget;
    },
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly waitFor: (
    pageId: PageId,
    condition: BrowserWaitCondition,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly evaluate: (
    pageId: PageId,
    expression: string,
  ) => Effect.Effect<BrowserEvalResult, BrowserError>;
  readonly events: Stream.Stream<BrowserHostEvent>;
}

/** Thin Effect seam over Electron's `WebContentsView`, `BrowserWindow.contentView`, `persist:spence-browser` session, and `shell`. */
export class BrowserHost extends Context.Service<BrowserHost, BrowserHostShape>()(
  'browser/BrowserHost',
) {}
