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

export const BrowserEvent = Schema.Union([
  Schema.TaggedStruct('State', { state: BrowserState }),
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
  Rpc.make('Browser.events', {
    success: BrowserEvent,
    stream: true,
  }),
);
