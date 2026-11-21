import { Context, Effect, Layer, PubSub, Semaphore, Stream } from 'effect';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserBounds,
  type BrowserControlState,
  BrowserError,
  type BrowserEvent,
  type BrowserPage,
  type BrowserState,
  clampBrowserWidth,
  PageId,
} from '../../src/shared/browser/browser.rpc';
import { isAllowedExternalBrowserUrl, parseUserUrl } from '../../src/shared/browser/url-policy';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { BrowserHost, type BrowserHostEvent, type BrowserHostPresentation } from './browser-host';

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
  readonly onSessionDeleted: (sessionId: SessionId) => Effect.Effect<void>;
  readonly events: Stream.Stream<BrowserEvent>;
}

/** Main-process Browser domain service owning per-Session Browser state, Page lifecycle, and host presentation. */
export class BrowserService extends Context.Service<BrowserService, BrowserServiceShape>()(
  'browser/BrowserService',
) {}

interface SessionBrowserRecord {
  readonly sessionId: SessionId;
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

export const layerBrowserService = Layer.effect(
  BrowserService,
  Effect.gen(function* () {
    const host = yield* BrowserHost;
    const lock = (yield* Semaphore.make(1)).withPermit;
    const eventsHub = yield* PubSub.unbounded<BrowserEvent>();
    const sessions = new Map<SessionId, SessionBrowserRecord>();
    const pageOwners = new Map<PageId, SessionId>();
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

    const createInitialPage = Effect.fnUntraced(function* (
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

    const handleHostEvent = Effect.fnUntraced(function* (event: BrowserHostEvent) {
      if (event._tag === 'PageUpdated') {
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
      } else if (event._tag === 'PageClosed') {
        const owner = pageOwners.get(event.pageId);
        pageOwners.delete(event.pageId);
        if (owner === undefined) return;
        const record = sessions.get(owner);
        if (record === undefined) return;
        record.pages = record.pages.filter((page) => page.id !== event.pageId);
        if (record.activePageId === event.pageId) {
          record.activePageId = record.pages[0]?.id ?? null;
          yield* syncPresentation();
        }
        yield* emitState(record);
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
            yield* createInitialPage(record, 'about:blank');
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
            const created = yield* createInitialPage(record, 'about:blank');
            record.activePageId = created.id;
          }
          const page = yield* activePageOf(record);
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

    const onSessionDeleted = Effect.fn('BrowserService.onSessionDeleted')(function* (
      sessionId: SessionId,
    ) {
      yield* lock(
        Effect.gen(function* () {
          const record = sessions.get(sessionId);
          if (record !== undefined) {
            for (const page of record.pages) {
              pageOwners.delete(page.id);
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
      onSessionDeleted,
      events,
    });
  }),
);
