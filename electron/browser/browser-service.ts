import { Context, Effect, Layer, PubSub, Semaphore, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserBounds,
  type BrowserConsoleError,
  type BrowserConsoleErrorsResult,
  type BrowserControlState,
  BrowserError,
  type BrowserEvent,
  type BrowserPage,
  type BrowserScreenshotResult,
  type BrowserState,
  clampBrowserWidth,
  PageId,
} from '../../src/shared/browser/browser.rpc';
import {
  classifyAgentUrl,
  isAllowedExternalBrowserUrl,
  isAllowedPopupUrl,
  isRemoteDevice,
  parseUserUrl,
} from '../../src/shared/browser/url-policy';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import {
  type BrowserActionResult,
  type BrowserConsoleLogEntry,
  type BrowserConsoleLogLevel,
  type BrowserElementTarget,
  type BrowserEvalResult,
  BrowserHost,
  type BrowserHostEvent,
  type BrowserHostPresentation,
  type BrowserPageSnapshot,
  type BrowserWaitCondition,
} from './browser-host';
import { redactNetworkEntry, type RedactedNetworkEntry } from './redaction';

export interface AgentPageInfoResult {
  readonly pageId: PageId;
  readonly url: string;
  readonly title: string;
}

export interface AgentPagesResult {
  readonly activePageId: PageId | null;
  readonly pages: ReadonlyArray<BrowserPage>;
}

export interface AgentConsoleResult {
  readonly pageId: PageId;
  readonly entries: ReadonlyArray<BrowserConsoleLogEntry>;
}

export interface AgentNetworkResult {
  readonly pageId: PageId;
  readonly entries: ReadonlyArray<RedactedNetworkEntry>;
}

export interface BrowserServiceShape {
  readonly getState: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly setOpen: (
    sessionId: SessionId,
    open: boolean,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly setWidth: (
    sessionId: SessionId,
    width: number,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly setActiveSession: (sessionId: SessionId | null) => Effect.Effect<void>;
  readonly setBounds: (sessionId: SessionId, bounds: BrowserBounds) => Effect.Effect<void>;
  // Occlusion (#214)
  readonly setOccluded: (occluded: boolean, captureFrame?: boolean) => Effect.Effect<void>;
  readonly navigate: (
    sessionId: SessionId,
    url: string,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly goBack: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly goForward: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly reload: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly openExternal: (sessionId: SessionId) => Effect.Effect<void, BrowserError>;
  readonly openDevTools: (sessionId: SessionId) => Effect.Effect<void, BrowserError>;
  // #213: Multi-Page management
  readonly createPage: (
    sessionId: SessionId,
    url?: string,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly selectPage: (
    sessionId: SessionId,
    pageId: PageId,
  ) => Effect.Effect<BrowserState, BrowserError>;
  readonly closePage: (
    sessionId: SessionId,
    pageId: PageId,
  ) => Effect.Effect<BrowserState, BrowserError>;
  // #215 Composer bridge
  readonly captureScreenshot: (
    sessionId: SessionId,
  ) => Effect.Effect<BrowserScreenshotResult, BrowserError>;
  readonly startElementPicker: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly cancelElementPicker: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly getConsoleErrors: (
    sessionId: SessionId,
  ) => Effect.Effect<BrowserConsoleErrorsResult, BrowserError>;
  // #217 Agent Browser MCP capabilities
  readonly setSessionDevice: (
    sessionId: SessionId,
    deviceId: string | undefined,
  ) => Effect.Effect<void>;
  readonly agentNavigate: (
    sessionId: SessionId,
    url: string,
    pageId?: PageId,
  ) => Effect.Effect<AgentPageInfoResult, BrowserError>;
  readonly agentBack: (
    sessionId: SessionId,
    pageId?: PageId,
  ) => Effect.Effect<AgentPageInfoResult, BrowserError>;
  readonly agentForward: (
    sessionId: SessionId,
    pageId?: PageId,
  ) => Effect.Effect<AgentPageInfoResult, BrowserError>;
  readonly agentReload: (
    sessionId: SessionId,
    pageId?: PageId,
  ) => Effect.Effect<AgentPageInfoResult, BrowserError>;
  readonly agentListPages: (sessionId: SessionId) => Effect.Effect<AgentPagesResult, BrowserError>;
  readonly agentCreatePage: (
    sessionId: SessionId,
    url?: string,
  ) => Effect.Effect<BrowserPage, BrowserError>;
  readonly agentSelectPage: (
    sessionId: SessionId,
    pageId: PageId,
  ) => Effect.Effect<AgentPagesResult, BrowserError>;
  readonly agentClosePage: (
    sessionId: SessionId,
    pageId: PageId,
  ) => Effect.Effect<AgentPagesResult, BrowserError>;
  readonly agentSnapshot: (
    sessionId: SessionId,
    pageId?: PageId,
  ) => Effect.Effect<BrowserPageSnapshot, BrowserError>;
  readonly agentScreenshot: (
    sessionId: SessionId,
    pageId?: PageId,
  ) => Effect.Effect<BrowserScreenshotResult & { readonly pageId: PageId }, BrowserError>;
  readonly agentConsole: (
    sessionId: SessionId,
    options?: {
      readonly pageId?: PageId;
      readonly level?: BrowserConsoleLogLevel;
      readonly limit?: number;
    },
  ) => Effect.Effect<AgentConsoleResult, BrowserError>;
  readonly agentNetwork: (
    sessionId: SessionId,
    options?: {
      readonly pageId?: PageId;
      readonly limit?: number;
      readonly statusMin?: number;
      readonly urlContains?: string;
    },
  ) => Effect.Effect<AgentNetworkResult, BrowserError>;
  readonly agentClick: (
    sessionId: SessionId,
    target: BrowserElementTarget,
    options?: {
      readonly pageId?: PageId;
      readonly button?: 'left' | 'right' | 'middle';
      readonly clickCount?: number;
    },
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentFill: (
    sessionId: SessionId,
    target: BrowserElementTarget,
    value: string,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentType: (
    sessionId: SessionId,
    text: string,
    target?: BrowserElementTarget,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentPress: (
    sessionId: SessionId,
    key: string,
    target?: BrowserElementTarget,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentSelect: (
    sessionId: SessionId,
    target: BrowserElementTarget,
    values: ReadonlyArray<string>,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentHover: (
    sessionId: SessionId,
    target: BrowserElementTarget,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentScroll: (
    sessionId: SessionId,
    options: {
      readonly direction?: 'up' | 'down' | 'left' | 'right';
      readonly amount?: number;
      readonly target?: BrowserElementTarget;
      readonly pageId?: PageId;
    },
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentWaitFor: (
    sessionId: SessionId,
    condition: BrowserWaitCondition,
    pageId?: PageId,
  ) => Effect.Effect<BrowserActionResult, BrowserError>;
  readonly agentEval: (
    sessionId: SessionId,
    expression: string,
    pageId?: PageId,
  ) => Effect.Effect<BrowserEvalResult, BrowserError>;
  readonly onSessionDeleted: (sessionId: SessionId) => Effect.Effect<void>;
  readonly events: Stream.Stream<BrowserEvent>;
}

/** Main-process Browser domain service owning per-Session Browser state, Page lifecycle, and host presentation. */
export class BrowserService extends Context.Service<BrowserService, BrowserServiceShape>()(
  'browser/BrowserService',
) {}

interface SessionBrowserRecord {
  readonly sessionId: SessionId;
  deviceId: string | undefined;
  open: boolean;
  width: number;
  pages: Array<BrowserPage>;
  activePageId: PageId | null;
  control: BrowserControlState;
  pickerActive: boolean;
  occluded: boolean;
  bounds: BrowserBounds | null;
  lastFrameDataUrl: string | undefined;
}

const makeDefaultRecord = (sessionId: SessionId): SessionBrowserRecord => ({
  sessionId,
  deviceId: undefined,
  open: false,
  width: BROWSER_DEFAULT_WIDTH,
  pages: [],
  activePageId: null,
  control: { _tag: 'idle' },
  pickerActive: false,
  occluded: false,
  bounds: null,
  lastFrameDataUrl: undefined,
});

const snapshotOf = (record: SessionBrowserRecord, windowOccluded = false): BrowserState => ({
  sessionId: record.sessionId,
  open: record.open,
  width: record.width,
  pages: record.pages.map((page) => ({ ...page })),
  activePageId: record.activePageId,
  control: record.control,
  pickerActive: record.pickerActive,
  occluded: windowOccluded || record.occluded,
  ...(record.lastFrameDataUrl === undefined ? {} : { lastFrameDataUrl: record.lastFrameDataUrl }),
});

const sanitizeBounds = (bounds: BrowserBounds): BrowserBounds => ({
  x: Math.round(bounds.x),
  y: Math.round(bounds.y),
  width: Math.max(0, Math.round(bounds.width)),
  height: Math.max(0, Math.round(bounds.height)),
});

const sameBounds = (a: BrowserBounds | null, b: BrowserBounds): boolean =>
  a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const samePresentation = (
  a: BrowserHostPresentation | null,
  b: BrowserHostPresentation | null,
): boolean => {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.pageId === b.pageId &&
    a.visible === b.visible &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
};

const MAX_PAGE_CONSOLE_ERRORS = 50;
const MAX_PAGE_CONSOLE_ENTRIES = 200;
const MAX_PAGE_NETWORK_ENTRIES = 200;

export const layerBrowserService = Layer.effect(
  BrowserService,
  Effect.gen(function* () {
    const host = yield* BrowserHost;
    const lock = (yield* Semaphore.make(1)).withPermit;
    const eventsHub = yield* PubSub.unbounded<BrowserEvent>();
    const sessions = new Map<SessionId, SessionBrowserRecord>();
    const pageOwners = new Map<PageId, SessionId>();
    const pageErrors = new Map<PageId, Array<BrowserConsoleError>>();
    const pageConsoleEntries = new Map<PageId, Array<BrowserConsoleLogEntry>>();
    const pageNetworkEntries = new Map<PageId, Array<RedactedNetworkEntry>>();
    let activeSessionId: SessionId | null = null;
    let windowOccluded = false;
    let lastPresentation: BrowserHostPresentation | null = null;

    const getOrCreateRecord = (sessionId: SessionId): SessionBrowserRecord => {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) return existing;
      const created = makeDefaultRecord(sessionId);
      sessions.set(sessionId, created);
      return created;
    };

    const currentSnapshot = (record: SessionBrowserRecord): BrowserState =>
      snapshotOf(record, windowOccluded);

    const emitState = (record: SessionBrowserRecord) => {
      const event: BrowserEvent = { _tag: 'State', state: currentSnapshot(record) };
      return PubSub.publish(eventsHub, event);
    };

    const targetPresentation = (): BrowserHostPresentation | null => {
      if (windowOccluded || activeSessionId === null) return null;
      const record = sessions.get(activeSessionId);
      if (
        record === undefined ||
        !record.open ||
        record.occluded ||
        record.activePageId === null ||
        record.bounds === null ||
        record.bounds.width <= 0 ||
        record.bounds.height <= 0
      ) {
        return null;
      }
      return {
        pageId: record.activePageId,
        bounds: record.bounds,
        visible: true,
      };
    };

    const syncPresentation = Effect.fnUntraced(function* () {
      const next = targetPresentation();
      if (samePresentation(lastPresentation, next)) return;
      lastPresentation = next;
      yield* host.setPresentation(next);
    });

    const appendPage = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      initialUrl: string,
    ) {
      const pageId = PageId.make(`page-${randomUUID()}`);
      const page: BrowserPage = {
        id: pageId,
        url: initialUrl,
        title: '',
        loading: initialUrl !== 'about:blank',
        canGoBack: false,
        canGoForward: false,
        suspended: false,
      };
      record.pages.push(page);
      record.activePageId = pageId;
      pageOwners.set(pageId, record.sessionId);
      yield* host.createPage(pageId, initialUrl);
      return page;
    });

    const activePageOf = (
      record: SessionBrowserRecord,
    ): Effect.Effect<BrowserPage, BrowserError> => {
      const page =
        record.activePageId === null
          ? undefined
          : record.pages.find((candidate) => candidate.id === record.activePageId);
      return page === undefined
        ? Effect.fail(
            new BrowserError({
              reason: 'NoActivePage',
              detail: 'No active Page is open in this Session.',
            }),
          )
        : Effect.succeed(page);
    };

    const appendBounded = <T>(map: Map<PageId, Array<T>>, pageId: PageId, item: T, max: number) => {
      let list = map.get(pageId);
      if (list === undefined) {
        list = [];
        map.set(pageId, list);
      }
      list.push(item);
      if (list.length > max) {
        list.splice(0, list.length - max);
      }
    };

    const clearPageLogs = (pageId: PageId): void => {
      pageErrors.delete(pageId);
      pageConsoleEntries.delete(pageId);
      pageNetworkEntries.delete(pageId);
    };

    const removePage = (record: SessionBrowserRecord, pageId: PageId): boolean => {
      const index = record.pages.findIndex((page) => page.id === pageId);
      if (index === -1) return false;
      pageOwners.delete(pageId);
      clearPageLogs(pageId);
      const nextPages = record.pages.filter((page) => page.id !== pageId);
      record.pages = nextPages;
      if (record.activePageId === pageId) {
        record.pickerActive = false;
        record.activePageId = (nextPages[index] ?? nextPages[index - 1])?.id ?? null;
      }
      return true;
    };

    const ensurePageLive = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      pageId: PageId,
    ): Effect.fn.Return<BrowserPage, BrowserError> {
      const index = record.pages.findIndex((candidate) => candidate.id === pageId);
      const page = index === -1 ? undefined : record.pages[index];
      if (page === undefined) {
        return yield* new BrowserError({
          reason: 'PageNotFound',
          detail: `Page ${pageId} was not found in this Session.`,
        });
      }
      if (page.suspended) {
        yield* host.createPage(page.id, page.url);
        const livePage: BrowserPage = {
          ...page,
          suspended: false,
          loading: page.url !== 'about:blank',
        };
        record.pages[index] = livePage;
        yield* emitState(record);
        return livePage;
      }
      return page;
    });

    const requireLocalRecord = (
      sessionId: SessionId,
    ): Effect.Effect<SessionBrowserRecord, BrowserError> =>
      Effect.suspend(() => {
        const record = getOrCreateRecord(sessionId);
        if (isRemoteDevice(record.deviceId)) {
          return Effect.fail(
            new BrowserError({
              reason: 'RemoteUnsupported',
              detail: 'Browser control is not available for remote Sessions.',
            }),
          );
        }
        return Effect.succeed(record);
      });

    const resolveAgentPage = Effect.fnUntraced(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ): Effect.fn.Return<BrowserPage, BrowserError> {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const targetId = pageId ?? record.activePageId;
          if (targetId === null) {
            return yield* new BrowserError({
              reason: 'NoActivePage',
              detail: 'No active Page is open in this Session.',
            });
          }
          return yield* ensurePageLive(record, targetId);
        }),
      );
    });

    const validateAgentUrl = (rawUrl: string): Effect.Effect<string, BrowserError> =>
      Effect.suspend(() => {
        const classified = classifyAgentUrl(rawUrl);
        if (classified.kind === 'blocked') {
          const hasNonHttpScheme =
            /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(rawUrl.trim()) && !/^https?:/i.test(rawUrl.trim());
          const reason =
            hasNonHttpScheme ||
            classified.reason.includes('Scheme') ||
            classified.reason.includes('Credentials')
              ? 'SchemeBlocked'
              : 'InvalidUrl';
          return Effect.fail(new BrowserError({ reason, detail: classified.reason }));
        }
        return Effect.succeed(classified.url);
      });

    const handleHostEvent = Effect.fnUntraced(function* (event: BrowserHostEvent) {
      switch (event._tag) {
        case 'PageUpdated': {
          const owner = pageOwners.get(event.pageId);
          if (owner === undefined) return;
          const record = sessions.get(owner);
          if (record === undefined) return;
          const index = record.pages.findIndex((page) => page.id === event.pageId);
          if (index === -1) return;
          const current = record.pages[index];
          if (current === undefined) return;
          record.pages[index] = {
            ...current,
            ...(event.url === undefined ? {} : { url: event.url }),
            ...(event.title === undefined ? {} : { title: event.title }),
            ...(event.loading === undefined ? {} : { loading: event.loading }),
            ...(event.canGoBack === undefined ? {} : { canGoBack: event.canGoBack }),
            ...(event.canGoForward === undefined ? {} : { canGoForward: event.canGoForward }),
          };
          yield* emitState(record);
          return;
        }
        case 'PopupRequested': {
          if (!isAllowedPopupUrl(event.url)) return;
          const owner = pageOwners.get(event.openerPageId);
          if (owner === undefined) return;
          const record = sessions.get(owner);
          if (record === undefined) return;
          if (record.pickerActive && record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
            record.pickerActive = false;
          }
          yield* appendPage(record, event.url);
          yield* syncPresentation();
          yield* emitState(record);
          return;
        }
        case 'ConsoleError': {
          if (!pageOwners.has(event.pageId)) return;
          appendBounded(pageErrors, event.pageId, event.error, MAX_PAGE_CONSOLE_ERRORS);
          return;
        }
        case 'ConsoleEntry': {
          if (!pageOwners.has(event.pageId)) return;
          appendBounded(pageConsoleEntries, event.pageId, event.entry, MAX_PAGE_CONSOLE_ENTRIES);
          return;
        }
        case 'NetworkEntry': {
          if (!pageOwners.has(event.pageId)) return;
          appendBounded(
            pageNetworkEntries,
            event.pageId,
            redactNetworkEntry(event.entry),
            MAX_PAGE_NETWORK_ENTRIES,
          );
          return;
        }
        case 'ElementPicked': {
          const owner = pageOwners.get(event.pageId);
          if (owner === undefined) return;
          const record = sessions.get(owner);
          if (record === undefined) return;
          record.pickerActive = false;
          yield* emitState(record);
          yield* PubSub.publish(eventsHub, {
            _tag: 'ElementPicked',
            sessionId: owner,
            element: event.element,
          });
          return;
        }
        case 'ElementPickerCancelled': {
          const owner = pageOwners.get(event.pageId);
          if (owner === undefined) return;
          const record = sessions.get(owner);
          if (record === undefined || !record.pickerActive) return;
          record.pickerActive = false;
          yield* emitState(record);
          return;
        }
        case 'PageClosed': {
          const owner = pageOwners.get(event.pageId);
          if (owner === undefined) {
            clearPageLogs(event.pageId);
            return;
          }
          const record = sessions.get(owner);
          if (record === undefined) {
            pageOwners.delete(event.pageId);
            clearPageLogs(event.pageId);
            return;
          }
          const prevActive = record.activePageId;
          if (!removePage(record, event.pageId)) return;
          if (prevActive === event.pageId) {
            yield* syncPresentation();
          }
          yield* emitState(record);
          return;
        }
      }
    });

    yield* host.events.pipe(
      Stream.runForEach((event) => lock(handleHostEvent(event))),
      Effect.forkScoped,
    );

    const getState = Effect.fn('BrowserService.getState')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.sync(() => {
          const existing = sessions.get(sessionId);
          return existing === undefined
            ? currentSnapshot(makeDefaultRecord(sessionId))
            : currentSnapshot(existing);
        }),
      );
    });

    const setOpen = Effect.fn('BrowserService.setOpen')(function* (
      sessionId: SessionId,
      open: boolean,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          if (open && record.pages.length === 0) {
            yield* appendPage(record, 'about:blank');
          }
          if (!open && record.pickerActive) {
            if (record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
            }
            record.pickerActive = false;
          }
          record.open = open;
          if (!open) {
            record.lastFrameDataUrl = undefined;
          }
          yield* syncPresentation();
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    const setWidth = Effect.fn('BrowserService.setWidth')(function* (
      sessionId: SessionId,
      width: number,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const clamped = clampBrowserWidth(width);
          if (record.width !== clamped) {
            record.width = clamped;
            yield* emitState(record);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const setActiveSession = Effect.fn('BrowserService.setActiveSession')(function* (
      sessionId: SessionId | null,
    ) {
      yield* lock(
        Effect.gen(function* () {
          activeSessionId = sessionId;
          yield* syncPresentation();
        }),
      );
    });

    const setBounds = Effect.fn('BrowserService.setBounds')(function* (
      sessionId: SessionId,
      bounds: BrowserBounds,
    ) {
      yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const sanitized = sanitizeBounds(bounds);
          if (sameBounds(record.bounds, sanitized)) return;
          record.bounds = sanitized;
          if (activeSessionId === sessionId) {
            yield* syncPresentation();
          }
        }),
      );
    });

    // Occlusion (#214)
    const setOccluded = Effect.fn('BrowserService.setOccluded')(function* (
      occluded: boolean,
      captureFrame = true,
    ) {
      yield* lock(
        Effect.gen(function* () {
          if (windowOccluded === occluded) return;
          if (occluded) {
            const activeRecord =
              activeSessionId === null ? undefined : sessions.get(activeSessionId);
            if (
              captureFrame &&
              activeRecord !== undefined &&
              activeRecord.open &&
              activeRecord.activePageId !== null &&
              lastPresentation !== null &&
              lastPresentation.visible &&
              lastPresentation.pageId === activeRecord.activePageId
            ) {
              const capture = host.capturePageDataUrl;
              activeRecord.lastFrameDataUrl =
                capture === undefined
                  ? undefined
                  : yield* capture(activeRecord.activePageId).pipe(
                      Effect.catch(() => Effect.succeed(undefined)),
                    );
            }
            windowOccluded = true;
            yield* syncPresentation();
            for (const record of sessions.values()) {
              yield* emitState(record);
            }
            return;
          }

          windowOccluded = false;
          for (const record of sessions.values()) {
            record.lastFrameDataUrl = undefined;
          }
          yield* syncPresentation();
          for (const record of sessions.values()) {
            yield* emitState(record);
          }
        }),
      );
    });

    const navigate = Effect.fn('BrowserService.navigate')(function* (
      sessionId: SessionId,
      rawUrl: string,
    ) {
      const parsed = parseUserUrl(rawUrl);
      if (!parsed.ok) {
        return yield* new BrowserError({ reason: parsed.reason, detail: parsed.detail });
      }
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          if (record.activePageId === null || record.pages.length === 0) {
            const created = yield* appendPage(record, 'about:blank');
            record.activePageId = created.id;
          }
          const page = yield* activePageOf(record);
          if (record.pickerActive) {
            yield* host.cancelElementPicker(page.id);
            record.pickerActive = false;
          }
          const index = record.pages.findIndex((candidate) => candidate.id === page.id);
          if (index !== -1) {
            record.pages[index] = {
              ...page,
              url: parsed.url,
              loading: parsed.url !== 'about:blank',
            };
          }
          yield* host.loadUrl(page.id, parsed.url);
          yield* syncPresentation();
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    const goBack = Effect.fn('BrowserService.goBack')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          yield* host.goBack(page.id);
          return currentSnapshot(record);
        }),
      );
    });

    const goForward = Effect.fn('BrowserService.goForward')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          yield* host.goForward(page.id);
          return currentSnapshot(record);
        }),
      );
    });

    const reload = Effect.fn('BrowserService.reload')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          yield* host.reload(page.id);
          return currentSnapshot(record);
        }),
      );
    });

    const openExternal = Effect.fn('BrowserService.openExternal')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          if (!isAllowedExternalBrowserUrl(page.url)) {
            return yield* new BrowserError({
              reason: 'SchemeBlocked',
              detail: 'Only http:// and https:// pages can open in the default browser.',
            });
          }
          yield* host.openExternal(page.url);
        }),
      );
    });

    const openDevTools = Effect.fn('BrowserService.openDevTools')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          yield* host.openDevTools(page.id);
        }),
      );
    });

    // #213: Multi-Page management
    const createPage = Effect.fn('BrowserService.createPage')(function* (
      sessionId: SessionId,
      rawUrl?: string,
    ) {
      let initialUrl = 'about:blank';
      if (rawUrl !== undefined) {
        const parsed = parseUserUrl(rawUrl);
        if (!parsed.ok) {
          return yield* new BrowserError({ reason: parsed.reason, detail: parsed.detail });
        }
        initialUrl = parsed.url;
      }
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          if (record.pickerActive && record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
            record.pickerActive = false;
          }
          record.lastFrameDataUrl = undefined;
          yield* appendPage(record, initialUrl);
          yield* syncPresentation();
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    const selectPage = Effect.fn('BrowserService.selectPage')(function* (
      sessionId: SessionId,
      pageId: PageId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = record.pages.find((candidate) => candidate.id === pageId);
          if (page === undefined) {
            return yield* new BrowserError({
              reason: 'PageNotFound',
              detail: `Page ${pageId} was not found in this Session.`,
            });
          }
          if (record.activePageId !== pageId) {
            if (record.pickerActive && record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
              record.pickerActive = false;
            }
            record.activePageId = pageId;
            record.lastFrameDataUrl = undefined;
            yield* syncPresentation();
            yield* emitState(record);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const closePage = Effect.fn('BrowserService.closePage')(function* (
      sessionId: SessionId,
      pageId: PageId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const wasActive = record.activePageId === pageId;
          const wasPickerActive = wasActive && record.pickerActive;
          if (!removePage(record, pageId)) {
            return yield* new BrowserError({
              reason: 'PageNotFound',
              detail: `Page ${pageId} was not found in this Session.`,
            });
          }
          if (wasPickerActive) {
            yield* host.cancelElementPicker(pageId);
          }
          if (wasActive) {
            record.lastFrameDataUrl = undefined;
          }
          yield* host.closePage(pageId);
          yield* syncPresentation();
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    // #215 Composer bridge
    const captureScreenshot = Effect.fn('BrowserService.captureScreenshot')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          return yield* host.captureScreenshot(page.id);
        }),
      );
    });

    const startElementPicker = Effect.fn('BrowserService.startElementPicker')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          yield* host.startElementPicker(page.id);
          record.pickerActive = true;
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    const cancelElementPicker = Effect.fn('BrowserService.cancelElementPicker')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          if (record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
          }
          if (record.pickerActive) {
            record.pickerActive = false;
            yield* emitState(record);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const getConsoleErrors = Effect.fn('BrowserService.getConsoleErrors')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = getOrCreateRecord(sessionId);
          const page = yield* activePageOf(record);
          return { errors: [...(pageErrors.get(page.id) ?? [])] };
        }),
      );
    });

    const onSessionDeleted = Effect.fn('BrowserService.onSessionDeleted')(function* (
      sessionId: SessionId,
    ) {
      yield* lock(
        Effect.gen(function* () {
          const record = sessions.get(sessionId);
          if (record !== undefined) {
            for (const page of record.pages) {
              if (record.pickerActive && record.activePageId === page.id) {
                yield* host.cancelElementPicker(page.id);
              }
              pageOwners.delete(page.id);
              clearPageLogs(page.id);
              yield* host.closePage(page.id);
            }
            sessions.delete(sessionId);
          }
          if (activeSessionId === sessionId) {
            activeSessionId = null;
          }
          yield* syncPresentation();
        }),
      );
    });

    // #217 Agent Browser MCP capabilities
    const setSessionDevice = Effect.fn('BrowserService.setSessionDevice')(function* (
      sessionId: SessionId,
      deviceId: string | undefined,
    ) {
      yield* lock(
        Effect.sync(() => {
          const record = getOrCreateRecord(sessionId);
          record.deviceId = deviceId;
        }),
      );
    });

    const agentNavigate = Effect.fn('BrowserService.agentNavigate')(function* (
      sessionId: SessionId,
      rawUrl: string,
      pageId?: PageId,
    ) {
      const targetUrl = yield* validateAgentUrl(rawUrl);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          let page: BrowserPage;
          if (pageId === undefined) {
            if (record.activePageId === null || record.pages.length === 0) {
              page = yield* appendPage(record, 'about:blank');
            } else {
              page = yield* ensurePageLive(record, record.activePageId);
            }
          } else {
            page = yield* ensurePageLive(record, pageId);
          }
          if (record.pickerActive && record.activePageId === page.id) {
            yield* host.cancelElementPicker(page.id);
            record.pickerActive = false;
          }
          const index = record.pages.findIndex((candidate) => candidate.id === page.id);
          if (index !== -1) {
            record.pages[index] = {
              ...page,
              url: targetUrl,
              loading: true,
            };
          }
          yield* host.loadUrl(page.id, targetUrl);
          yield* syncPresentation();
          yield* emitState(record);
          return { pageId: page.id, url: targetUrl, title: page.title };
        }),
      );
    });

    const agentBack = Effect.fn('BrowserService.agentBack')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      yield* host.goBack(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentForward = Effect.fn('BrowserService.agentForward')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      yield* host.goForward(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentReload = Effect.fn('BrowserService.agentReload')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      yield* host.reload(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentListPages = Effect.fn('BrowserService.agentListPages')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          return {
            activePageId: record.activePageId,
            pages: record.pages.map((page) => ({ ...page })),
          };
        }),
      );
    });

    const agentCreatePage = Effect.fn('BrowserService.agentCreatePage')(function* (
      sessionId: SessionId,
      rawUrl?: string,
    ) {
      const initialUrl = rawUrl === undefined ? 'about:blank' : yield* validateAgentUrl(rawUrl);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          if (record.pickerActive && record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
            record.pickerActive = false;
          }
          record.lastFrameDataUrl = undefined;
          const page = yield* appendPage(record, initialUrl);
          yield* syncPresentation();
          yield* emitState(record);
          return { ...page };
        }),
      );
    });

    const agentSelectPage = Effect.fn('BrowserService.agentSelectPage')(function* (
      sessionId: SessionId,
      pageId: PageId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          yield* ensurePageLive(record, pageId);
          if (record.activePageId !== pageId) {
            if (record.pickerActive && record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
              record.pickerActive = false;
            }
            record.activePageId = pageId;
            record.lastFrameDataUrl = undefined;
            yield* syncPresentation();
            yield* emitState(record);
          }
          return {
            activePageId: record.activePageId,
            pages: record.pages.map((page) => ({ ...page })),
          };
        }),
      );
    });

    const agentClosePage = Effect.fn('BrowserService.agentClosePage')(function* (
      sessionId: SessionId,
      pageId: PageId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const wasActive = record.activePageId === pageId;
          const wasPickerActive = wasActive && record.pickerActive;
          if (!removePage(record, pageId)) {
            return yield* new BrowserError({
              reason: 'PageNotFound',
              detail: `Page ${pageId} was not found in this Session.`,
            });
          }
          if (wasPickerActive) {
            yield* host.cancelElementPicker(pageId);
          }
          if (wasActive) {
            record.lastFrameDataUrl = undefined;
          }
          yield* host.closePage(pageId);
          yield* syncPresentation();
          yield* emitState(record);
          return {
            activePageId: record.activePageId,
            pages: record.pages.map((page) => ({ ...page })),
          };
        }),
      );
    });

    const agentSnapshot = Effect.fn('BrowserService.agentSnapshot')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.snapshot(page.id);
    });

    const agentScreenshot = Effect.fn('BrowserService.agentScreenshot')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      const shot = yield* host.captureScreenshot(page.id);
      return { ...shot, pageId: page.id };
    });

    const agentConsole = Effect.fn('BrowserService.agentConsole')(function* (
      sessionId: SessionId,
      options?: {
        readonly pageId?: PageId;
        readonly level?: BrowserConsoleLogLevel;
        readonly limit?: number;
      },
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const targetId = options?.pageId ?? record.activePageId;
          if (targetId === null) {
            return yield* new BrowserError({
              reason: 'NoActivePage',
              detail: 'No active Page is open in this Session.',
            });
          }
          const page = yield* ensurePageLive(record, targetId);
          let entries = pageConsoleEntries.get(page.id) ?? [];
          if (options?.level !== undefined) {
            entries = entries.filter((entry) => entry.level === options.level);
          }
          if (options?.limit !== undefined && options.limit > 0) {
            entries = entries.slice(-options.limit);
          }
          return { pageId: page.id, entries: [...entries] };
        }),
      );
    });

    const agentNetwork = Effect.fn('BrowserService.agentNetwork')(function* (
      sessionId: SessionId,
      options?: {
        readonly pageId?: PageId;
        readonly limit?: number;
        readonly statusMin?: number;
        readonly urlContains?: string;
      },
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const targetId = options?.pageId ?? record.activePageId;
          if (targetId === null) {
            return yield* new BrowserError({
              reason: 'NoActivePage',
              detail: 'No active Page is open in this Session.',
            });
          }
          const page = yield* ensurePageLive(record, targetId);
          let entries = pageNetworkEntries.get(page.id) ?? [];
          const statusMin = options?.statusMin;
          if (statusMin !== undefined) {
            entries = entries.filter(
              (entry) => entry.status !== undefined && entry.status >= statusMin,
            );
          }
          if (options?.urlContains !== undefined && options.urlContains !== '') {
            const needle = options.urlContains;
            entries = entries.filter((entry) => entry.url.includes(needle));
          }
          if (options?.limit !== undefined && options.limit > 0) {
            entries = entries.slice(-options.limit);
          }
          return { pageId: page.id, entries: [...entries] };
        }),
      );
    });

    const agentClick = Effect.fn('BrowserService.agentClick')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      options?: {
        readonly pageId?: PageId;
        readonly button?: 'left' | 'right' | 'middle';
        readonly clickCount?: number;
      },
    ) {
      const page = yield* resolveAgentPage(sessionId, options?.pageId);
      return yield* host.click(page.id, target, {
        ...(options?.button === undefined ? {} : { button: options.button }),
        ...(options?.clickCount === undefined ? {} : { clickCount: options.clickCount }),
      });
    });

    const agentFill = Effect.fn('BrowserService.agentFill')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      value: string,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.fill(page.id, target, value);
    });

    const agentType = Effect.fn('BrowserService.agentType')(function* (
      sessionId: SessionId,
      text: string,
      target?: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.type(page.id, text, target);
    });

    const agentPress = Effect.fn('BrowserService.agentPress')(function* (
      sessionId: SessionId,
      key: string,
      target?: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.press(page.id, key, target);
    });

    const agentSelect = Effect.fn('BrowserService.agentSelect')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      values: ReadonlyArray<string>,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.select(page.id, target, values);
    });

    const agentHover = Effect.fn('BrowserService.agentHover')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.hover(page.id, target);
    });

    const agentScroll = Effect.fn('BrowserService.agentScroll')(function* (
      sessionId: SessionId,
      options: {
        readonly direction?: 'up' | 'down' | 'left' | 'right';
        readonly amount?: number;
        readonly target?: BrowserElementTarget;
        readonly pageId?: PageId;
      },
    ) {
      const page = yield* resolveAgentPage(sessionId, options.pageId);
      return yield* host.scroll(page.id, {
        ...(options.direction === undefined ? {} : { direction: options.direction }),
        ...(options.amount === undefined ? {} : { amount: options.amount }),
        ...(options.target === undefined ? {} : { target: options.target }),
      });
    });

    const agentWaitFor = Effect.fn('BrowserService.agentWaitFor')(function* (
      sessionId: SessionId,
      condition: BrowserWaitCondition,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.waitFor(page.id, condition);
    });

    const agentEval = Effect.fn('BrowserService.agentEval')(function* (
      sessionId: SessionId,
      expression: string,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, pageId);
      return yield* host.evaluate(page.id, expression);
    });

    const events = Stream.unwrap(
      PubSub.subscribe(eventsHub).pipe(Effect.map((sub) => Stream.fromSubscription(sub))),
    );

    return BrowserService.of({
      getState,
      setOpen,
      setWidth,
      setActiveSession,
      setBounds,
      // Occlusion (#214)
      setOccluded,
      navigate,
      goBack,
      goForward,
      reload,
      openExternal,
      openDevTools,
      // #213: Multi-Page management
      createPage,
      selectPage,
      closePage,
      // #215 Composer bridge
      captureScreenshot,
      startElementPicker,
      cancelElementPicker,
      getConsoleErrors,
      // #217 Agent Browser MCP capabilities
      setSessionDevice,
      agentNavigate,
      agentBack,
      agentForward,
      agentReload,
      agentListPages,
      agentCreatePage,
      agentSelectPage,
      agentClosePage,
      agentSnapshot,
      agentScreenshot,
      agentConsole,
      agentNetwork,
      agentClick,
      agentFill,
      agentType,
      agentPress,
      agentSelect,
      agentHover,
      agentScroll,
      agentWaitFor,
      agentEval,
      onSessionDeleted,
      events,
    });
  }),
);
