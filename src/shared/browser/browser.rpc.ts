import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/rpc';
import { SessionId } from '../sessions/sessions.rpc';

export const BROWSER_MIN_WIDTH = 320;
export const BROWSER_MAX_WIDTH = 960;
export const BROWSER_DEFAULT_WIDTH = 480;

/** Clamps a Browser side pane width into the supported `320..960` DIP range. */
export const clampBrowserWidth = (width: number): number =>
  Math.min(BROWSER_MAX_WIDTH, Math.max(BROWSER_MIN_WIDTH, Math.round(width)));

export const PageId = Schema.String.pipe(Schema.brand('PageId')).annotate({ identifier: 'PageId' });
export type PageId = typeof PageId.Type;

export const BrowserBounds = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
}).annotate({ identifier: 'BrowserBounds' });
export type BrowserBounds = typeof BrowserBounds.Type;

export const BrowserControlState = Schema.Union([
  Schema.TaggedStruct('idle', {}),
  Schema.TaggedStruct('agentActive', {
    pageId: Schema.optionalKey(PageId),
    action: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct('userTakeover', {
    pausedCount: Schema.Number,
  }),
  Schema.TaggedStruct('handoffWaiting', {
    pageId: PageId,
    reason: Schema.String,
  }),
]).annotate({ identifier: 'BrowserControlState' });
export type BrowserControlState = typeof BrowserControlState.Type;

export const BrowserPage = Schema.Struct({
  id: PageId,
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  canGoBack: Schema.Boolean,
  canGoForward: Schema.Boolean,
  suspended: Schema.Boolean,
}).annotate({ identifier: 'BrowserPage' });
export type BrowserPage = typeof BrowserPage.Type;

export const BrowserState = Schema.Struct({
  sessionId: SessionId,
  open: Schema.Boolean,
  width: Schema.Number,
  pages: Schema.Array(BrowserPage),
  activePageId: Schema.NullOr(PageId),
  control: BrowserControlState,
  pickerActive: Schema.Boolean,
  occluded: Schema.Boolean,
  lastFrameDataUrl: Schema.optionalKey(Schema.String),
}).annotate({ identifier: 'BrowserState' });
export type BrowserState = typeof BrowserState.Type;

export const BrowserScreenshotResult = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.Literal('image/png'),
  data: Schema.String,
}).annotate({ identifier: 'BrowserScreenshotResult' });
export type BrowserScreenshotResult = typeof BrowserScreenshotResult.Type;

export const BrowserConsoleError = Schema.Struct({
  kind: Schema.Literals(['console', 'network']),
  message: Schema.String,
  url: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Number),
  at: Schema.Number,
}).annotate({ identifier: 'BrowserConsoleError' });
export type BrowserConsoleError = typeof BrowserConsoleError.Type;

export const BrowserConsoleErrorsResult = Schema.Struct({
  errors: Schema.Array(BrowserConsoleError),
}).annotate({ identifier: 'BrowserConsoleErrorsResult' });
export type BrowserConsoleErrorsResult = typeof BrowserConsoleErrorsResult.Type;

export const PickedElement = Schema.Struct({
  selector: Schema.String,
  tagName: Schema.String,
  text: Schema.String,
  htmlExcerpt: Schema.String,
}).annotate({ identifier: 'PickedElement' });
export type PickedElement = typeof PickedElement.Type;

export const BrowserEvent = Schema.Union([
  Schema.TaggedStruct('State', { state: BrowserState }),
  Schema.TaggedStruct('ElementPicked', { sessionId: SessionId, element: PickedElement }),
]).annotate({ identifier: 'BrowserEvent' });
export type BrowserEvent = typeof BrowserEvent.Type;

export class BrowserError extends Schema.TaggedError<BrowserError>()('BrowserError', {
  reason: Schema.Literals([
    'NotFound',
    'PageNotFound',
    'InvalidUrl',
    'SchemeBlocked',
    'RemoteUnsupported',
    'NoActivePage',
    'PickerCancelled',
    'CaptureFailed',
    'Unavailable',
  ]),
  detail: Schema.String,
}) {}

export const BrowserRpcs = RpcGroup.make(
  Rpc.make('Browser.getState', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.setOpen', {
    payload: { sessionId: SessionId, open: Schema.Boolean },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.setWidth', {
    payload: { sessionId: SessionId, width: Schema.Number },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.setActiveSession', {
    payload: { sessionId: Schema.NullOr(SessionId) },
  }),
  Rpc.make('Browser.setBounds', {
    payload: { sessionId: SessionId, bounds: BrowserBounds },
  }),
  // Occlusion (#214)
  Rpc.make('Browser.setOccluded', {
    payload: {
      occluded: Schema.Boolean,
      captureFrame: Schema.optionalKey(Schema.Boolean),
    },
  }),
  Rpc.make('Browser.navigate', {
    payload: { sessionId: SessionId, url: Schema.String },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.goBack', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.goForward', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.reload', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.openExternal', {
    payload: { sessionId: SessionId },
    error: BrowserError,
  }),
  Rpc.make('Browser.openDevTools', {
    payload: { sessionId: SessionId },
    error: BrowserError,
  }),
  // #213: Multi-Page management
  Rpc.make('Browser.createPage', {
    payload: {
      sessionId: SessionId,
      url: Schema.optionalKey(Schema.String),
    },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.selectPage', {
    payload: {
      sessionId: SessionId,
      pageId: PageId,
    },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.closePage', {
    payload: {
      sessionId: SessionId,
      pageId: PageId,
    },
    success: BrowserState,
    error: BrowserError,
  }),
  // #215 Composer bridge: screenshot, element picker, and console/network errors.
  Rpc.make('Browser.captureScreenshot', {
    payload: { sessionId: SessionId },
    success: BrowserScreenshotResult,
    error: BrowserError,
  }),
  Rpc.make('Browser.startElementPicker', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.cancelElementPicker', {
    payload: { sessionId: SessionId },
    success: BrowserState,
    error: BrowserError,
  }),
  Rpc.make('Browser.getConsoleErrors', {
    payload: { sessionId: SessionId },
    success: BrowserConsoleErrorsResult,
    error: BrowserError,
  }),
  Rpc.make('Browser.events', {
    success: BrowserEvent,
    stream: true,
  }),
);
