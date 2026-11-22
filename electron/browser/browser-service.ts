import { Context, Deferred, Effect, Layer, Option, PubSub, Semaphore, Stream } from 'effect';
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
  type AgentUrlClassification,
  classifyAgentUrl,
  isAllowedExternalBrowserUrl,
  isAllowedPopupUrl,
  isRemoteDevice,
  parseUserUrl,
} from '../../src/shared/browser/url-policy';
import type { PermissionMode } from '../../src/shared/projects/projects.rpc';
import type { SessionId } from '../../src/shared/sessions/sessions.rpc';
import { AgentLifetime } from '../acp/acpLifetime';
import { Settings } from '../settings/settings';
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
import { BrowserStore, type PersistedBrowserState } from './browser-store';
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

export interface BrowserHandoffAttentionEvent {
  readonly sessionId: SessionId;
  readonly pending: boolean;
}

export interface AgentHandoffResult {
  readonly resumed: true;
  readonly pageId: PageId;
}

export type BrowserOriginDecision = 'allow-session' | 'allow-always' | 'deny';

export interface BrowserOriginPermissionHandler {
  readonly getPermissionMode?: (sessionId: SessionId) => PermissionMode | undefined;
  readonly requestPermission: (input: {
    readonly sessionId: SessionId;
    readonly origin: string;
    readonly url: string;
    readonly kind: 'loopback' | 'external';
  }) => Effect.Effect<BrowserOriginDecision>;
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
  // #216 Persistence, LRU & Clear browsing data
  readonly clearData: () => Effect.Effect<void, BrowserError>;
  // #217 Agent Browser MCP capabilities
  readonly setSessionDevice: (
    sessionId: SessionId,
    deviceId: string | undefined,
  ) => Effect.Effect<void>;
  // #218 Agent URL safety guardrails & origin permissions
  readonly setSessionPermissionMode: (
    sessionId: SessionId,
    mode: PermissionMode,
  ) => Effect.Effect<void>;
  readonly setOriginPermissionHandler: (
    handler: BrowserOriginPermissionHandler,
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
  // #219: Live Agent control, user Take over & Browser handoff
  readonly agentHandoff: (
    sessionId: SessionId,
    reason: string,
    pageId?: PageId,
  ) => Effect.Effect<AgentHandoffResult, BrowserError>;
  readonly takeOver: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly continueAgent: (sessionId: SessionId) => Effect.Effect<BrowserState, BrowserError>;
  readonly onTurnEnded: (sessionId: SessionId) => Effect.Effect<void>;
  readonly handoffAttention: Stream.Stream<BrowserHandoffAttentionEvent>;
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
  permissionMode: PermissionMode;
  readonly approvedOrigins: Set<string>;
  open: boolean;
  width: number;
  pages: Array<BrowserPage>;
  activePageId: PageId | null;
  control: BrowserControlState;
  pickerActive: boolean;
  occluded: boolean;
  bounds: BrowserBounds | null;
  lastFrameDataUrl: string | undefined;
  readonly waiters: Array<Deferred.Deferred<void, BrowserError>>;
}

const makeDefaultRecord = (sessionId: SessionId): SessionBrowserRecord => ({
  sessionId,
  deviceId: undefined,
  permissionMode: 'auto',
  approvedOrigins: new Set(),
  open: false,
  width: BROWSER_DEFAULT_WIDTH,
  pages: [],
  activePageId: null,
  control: { _tag: 'idle' },
  pickerActive: false,
  occluded: false,
  bounds: null,
  lastFrameDataUrl: undefined,
  waiters: [],
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
const MAX_BACKGROUND_LIVE_PAGES = 5;

const toPersistedState = (record: SessionBrowserRecord): PersistedBrowserState => ({
  open: record.open,
  width: record.width,
  activePageId: record.activePageId,
  pages: record.pages.map((page) => ({ id: page.id, url: page.url, title: page.title })),
});

export const layerBrowserService = Layer.effect(
  BrowserService,
  Effect.gen(function* () {
    const host = yield* BrowserHost;
    const browserStore = Option.getOrUndefined(yield* Effect.serviceOption(BrowserStore));
    const agentLifetime = Option.getOrUndefined(yield* Effect.serviceOption(AgentLifetime));
    const settingsService = Option.getOrUndefined(yield* Effect.serviceOption(Settings));
    const lock = (yield* Semaphore.make(1)).withPermit;
    const eventsHub = yield* PubSub.unbounded<BrowserEvent>();
    const handoffAttentionHub = yield* PubSub.unbounded<BrowserHandoffAttentionEvent>();
    const sessions = new Map<SessionId, SessionBrowserRecord>();
    const pageOwners = new Map<PageId, SessionId>();
    const pageErrors = new Map<PageId, Array<BrowserConsoleError>>();
    const pageConsoleEntries = new Map<PageId, Array<BrowserConsoleLogEntry>>();
    const pageNetworkEntries = new Map<PageId, Array<RedactedNetworkEntry>>();
    const liveOrder = new Set<PageId>();
    const pendingOriginRequests = new Map<string, Deferred.Deferred<BrowserOriginDecision>>();
    let originHandler: BrowserOriginPermissionHandler | undefined;
    let activeSessionId: SessionId | null = null;
    let windowOccluded = false;
    let lastPresentation: BrowserHostPresentation | null = null;

    const touchPage = (pageId: PageId): void => {
      liveOrder.delete(pageId);
      liveOrder.add(pageId);
    };

    const persistRecord = (record: SessionBrowserRecord): Effect.Effect<void> =>
      browserStore === undefined
        ? Effect.void
        : browserStore.write(record.sessionId, toPersistedState(record));

    const loadRecord = Effect.fnUntraced(function* (sessionId: SessionId) {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) return existing;
      const persisted =
        browserStore === undefined ? undefined : yield* browserStore.read(sessionId);
      const created = makeDefaultRecord(sessionId);
      if (persisted !== undefined) {
        created.open = persisted.open;
        created.width = persisted.width;
        created.activePageId = persisted.activePageId;
        created.pages = persisted.pages.map((page) => {
          pageOwners.set(page.id, sessionId);
          return {
            id: page.id,
            url: page.url,
            title: page.title,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            suspended: true,
          };
        });
      }
      sessions.set(sessionId, created);
      return created;
    });

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
      const activePage = record.pages.find((page) => page.id === record.activePageId);
      if (activePage === undefined || activePage.suspended) return null;
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

    const enforceLruCap = Effect.fnUntraced(function* () {
      const working =
        agentLifetime === undefined ? new Set<SessionId>() : yield* agentLifetime.workingSessions;
      const backgroundLive: Array<{
        readonly session: SessionBrowserRecord;
        readonly pageId: PageId;
      }> = [];
      for (const pageId of liveOrder) {
        const owner = pageOwners.get(pageId);
        if (owner === undefined) continue;
        if (owner === activeSessionId || working.has(owner)) continue;
        const record = sessions.get(owner);
        if (record === undefined) continue;
        const page = record.pages.find((candidate) => candidate.id === pageId);
        if (page === undefined || page.suspended) continue;
        backgroundLive.push({ session: record, pageId });
      }
      const excess = backgroundLive.length - MAX_BACKGROUND_LIVE_PAGES;
      if (excess <= 0) return;

      const evictedSessions = new Set<SessionBrowserRecord>();
      for (let i = 0; i < excess; i++) {
        const target = backgroundLive[i];
        if (target === undefined) break;
        const index = target.session.pages.findIndex((candidate) => candidate.id === target.pageId);
        if (index === -1) continue;
        const current = target.session.pages[index];
        if (current === undefined || current.suspended) continue;
        target.session.pages[index] = {
          ...current,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          suspended: true,
        };
        if (target.session.pickerActive && target.session.activePageId === target.pageId) {
          yield* host.cancelElementPicker(target.pageId);
          target.session.pickerActive = false;
        }
        if (target.session.activePageId === target.pageId) {
          target.session.lastFrameDataUrl = undefined;
        }
        liveOrder.delete(target.pageId);
        clearPageLogs(target.pageId);
        yield* host.closePage(target.pageId);
        evictedSessions.add(target.session);
      }
      for (const record of evictedSessions) {
        yield* emitState(record);
      }
    });

    const ensurePageLive = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      pageId: PageId,
      overrideUrl?: string,
    ): Effect.fn.Return<boolean> {
      const index = record.pages.findIndex((candidate) => candidate.id === pageId);
      if (index === -1) return false;
      const current = record.pages[index];
      if (current === undefined) return false;
      touchPage(pageId);
      if (!current.suspended) return false;

      const targetUrl = overrideUrl ?? current.url;
      record.pages[index] = {
        ...current,
        url: targetUrl,
        loading: targetUrl !== 'about:blank',
        canGoBack: false,
        canGoForward: false,
        suspended: false,
      };
      yield* host.createPage(pageId, targetUrl);
      yield* enforceLruCap();
      return true;
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
      touchPage(pageId);
      yield* host.createPage(pageId, initialUrl);
      yield* enforceLruCap();
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

    const removePage = (
      record: SessionBrowserRecord,
      pageId: PageId,
    ): { readonly removed: boolean; readonly wasSuspended: boolean } => {
      const index = record.pages.findIndex((page) => page.id === pageId);
      if (index === -1) return { removed: false, wasSuspended: false };
      const wasSuspended = record.pages[index]?.suspended ?? false;
      pageOwners.delete(pageId);
      clearPageLogs(pageId);
      liveOrder.delete(pageId);
      const nextPages = record.pages.filter((page) => page.id !== pageId);
      record.pages = nextPages;
      if (record.activePageId === pageId) {
        record.pickerActive = false;
        record.activePageId = (nextPages[index] ?? nextPages[index - 1])?.id ?? null;
      }
      return { removed: true, wasSuspended };
    };

    const ensureAgentPageLive = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      pageId: PageId,
      overrideUrl?: string,
    ): Effect.fn.Return<BrowserPage, BrowserError> {
      const page = record.pages.find((candidate) => candidate.id === pageId);
      if (page === undefined) {
        return yield* new BrowserError({
          reason: 'PageNotFound',
          detail: `Page ${pageId} was not found in this Session.`,
        });
      }
      const materialized = yield* ensurePageLive(record, pageId, overrideUrl);
      const updated = record.pages.find((candidate) => candidate.id === pageId);
      if (materialized) {
        yield* emitState(record);
      }
      return updated ?? page;
    });

    const requireLocalRecord = Effect.fnUntraced(function* (
      sessionId: SessionId,
    ): Effect.fn.Return<SessionBrowserRecord, BrowserError> {
      const record = yield* loadRecord(sessionId);
      if (isRemoteDevice(record.deviceId)) {
        return yield* new BrowserError({
          reason: 'RemoteUnsupported',
          detail: 'Browser control is not available for remote Sessions.',
        });
      }
      return record;
    });

    const sameControl = (a: BrowserControlState, b: BrowserControlState): boolean => {
      if (a._tag !== b._tag) return false;
      switch (a._tag) {
        case 'idle':
          return true;
        case 'agentActive':
          return b._tag === 'agentActive' && a.pageId === b.pageId && a.action === b.action;
        case 'userTakeover':
          return b._tag === 'userTakeover' && a.pausedCount === b.pausedCount;
        case 'handoffWaiting':
          return b._tag === 'handoffWaiting' && a.pageId === b.pageId && a.reason === b.reason;
      }
    };

    const activateAgentControl = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      action: string,
      pageId?: PageId,
    ): Effect.fn.Return<boolean> {
      let openChanged = false;
      if (activeSessionId === record.sessionId && !record.open) {
        record.open = true;
        openChanged = true;
      }
      const nextControl: BrowserControlState = {
        _tag: 'agentActive',
        ...(pageId === undefined ? {} : { pageId }),
        action,
      };
      const controlChanged = !sameControl(record.control, nextControl);
      if (controlChanged) {
        record.control = nextControl;
      }
      if (openChanged) {
        yield* persistRecord(record);
      }
      return openChanged || controlChanged;
    });

    const removeWaiter = (
      record: SessionBrowserRecord,
      waiter: Deferred.Deferred<void, BrowserError>,
    ): Effect.Effect<void> =>
      lock(
        Effect.gen(function* () {
          const index = record.waiters.indexOf(waiter);
          if (index === -1) return;
          record.waiters.splice(index, 1);
          if (record.control._tag === 'userTakeover') {
            record.control = { _tag: 'userTakeover', pausedCount: record.waiters.length };
            yield* emitState(record);
          }
        }),
      );

    const waitIfControlPaused = Effect.fnUntraced(function* (
      sessionId: SessionId,
    ): Effect.fn.Return<void, BrowserError> {
      while (true) {
        const paused = yield* lock(
          Effect.gen(function* () {
            const record = yield* requireLocalRecord(sessionId);
            if (
              record.control._tag !== 'userTakeover' &&
              record.control._tag !== 'handoffWaiting'
            ) {
              return undefined;
            }
            const waiter = yield* Deferred.make<void, BrowserError>();
            record.waiters.push(waiter);
            if (record.control._tag === 'userTakeover') {
              record.control = { _tag: 'userTakeover', pausedCount: record.waiters.length };
              yield* emitState(record);
            }
            return { record, waiter };
          }),
        );
        if (paused === undefined) return;
        yield* Deferred.await(paused.waiter).pipe(
          Effect.onInterrupt(() => removeWaiter(paused.record, paused.waiter)),
        );
      }
    });

    const resolveAllWaiters = Effect.fnUntraced(function* (record: SessionBrowserRecord) {
      const waiters = record.waiters.splice(0, record.waiters.length);
      for (const waiter of waiters) {
        yield* Deferred.succeed(waiter, undefined);
      }
    });

    const cancelAllWaiters = Effect.fnUntraced(function* (
      record: SessionBrowserRecord,
      detail: string,
    ) {
      const waiters = record.waiters.splice(0, record.waiters.length);
      for (const waiter of waiters) {
        yield* Deferred.fail(waiter, new BrowserError({ reason: 'Unavailable', detail }));
      }
    });

    type AllowedAgentUrl = Extract<
      AgentUrlClassification,
      { readonly kind: 'loopback' | 'external' }
    >;

    const validateAgentUrl = (rawUrl: string): Effect.Effect<AllowedAgentUrl, BrowserError> =>
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
        return Effect.succeed(classified);
      });

    const isOriginAllowedByRecord = (
      record: SessionBrowserRecord,
      classified: AllowedAgentUrl,
    ): boolean => {
      const mode = originHandler?.getPermissionMode?.(record.sessionId) ?? record.permissionMode;
      if (classified.kind === 'loopback' && mode === 'auto') return true;
      return record.approvedOrigins.has(classified.origin);
    };

    const denyOrigin = (origin: string): BrowserError =>
      new BrowserError({
        reason: 'PermissionDenied',
        detail: `Browser access to "${origin}" was denied.`,
      });

    const authorizeClassifiedUrl = Effect.fnUntraced(function* (
      sessionId: SessionId,
      classified: AllowedAgentUrl,
    ): Effect.fn.Return<void, BrowserError> {
      const preApproved = yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          return isOriginAllowedByRecord(record, classified);
        }),
      );
      if (preApproved) return;

      const key = `${sessionId}|${classified.origin}`;
      const fresh = yield* Deferred.make<BrowserOriginDecision>();
      const existing = pendingOriginRequests.get(key);
      if (existing !== undefined) {
        const joined = yield* Deferred.await(existing);
        if (joined === 'deny') return yield* denyOrigin(classified.origin);
        return;
      }

      const currentRecord = sessions.get(sessionId);
      if (currentRecord !== undefined && isOriginAllowedByRecord(currentRecord, classified)) {
        return;
      }

      pendingOriginRequests.set(key, fresh);
      const decision = yield* Effect.gen(function* () {
        if (settingsService !== undefined) {
          const allowedOrigins = (yield* settingsService.get).browserAllowedOrigins;
          if (allowedOrigins.includes(classified.origin)) {
            return 'allow-always' as const;
          }
        }
        if (originHandler === undefined) {
          return 'deny' as const;
        }
        const outcome = yield* originHandler.requestPermission({
          sessionId,
          origin: classified.origin,
          url: classified.url,
          kind: classified.kind,
        });
        if (outcome === 'allow-session') {
          yield* lock(
            Effect.sync(() => {
              sessions.get(sessionId)?.approvedOrigins.add(classified.origin);
            }),
          );
        } else if (outcome === 'allow-always') {
          if (settingsService !== undefined) {
            const latest = (yield* settingsService.get).browserAllowedOrigins;
            if (!latest.includes(classified.origin)) {
              yield* settingsService
                .update({ browserAllowedOrigins: [...latest, classified.origin] })
                .pipe(Effect.ignore);
            }
          } else {
            yield* lock(
              Effect.sync(() => {
                sessions.get(sessionId)?.approvedOrigins.add(classified.origin);
              }),
            );
          }
        }
        return outcome;
      }).pipe(
        Effect.tap((outcome) => Deferred.succeed(fresh, outcome)),
        Effect.ensuring(
          Effect.suspend(() => {
            pendingOriginRequests.delete(key);
            return Deferred.succeed(fresh, 'deny' as const);
          }),
        ),
      );

      if (decision === 'deny') {
        return yield* denyOrigin(classified.origin);
      }
    });

    const resolveAgentPage = Effect.fnUntraced(function* (
      sessionId: SessionId,
      action: string,
      pageId?: PageId,
    ): Effect.fn.Return<BrowserPage, BrowserError> {
      yield* waitIfControlPaused(sessionId);
      while (true) {
        const snapshot = yield* lock(
          Effect.gen(function* () {
            const record = yield* requireLocalRecord(sessionId);
            const targetId = pageId ?? record.activePageId;
            if (targetId === null) {
              return yield* new BrowserError({
                reason: 'NoActivePage',
                detail: 'No active Page is open in this Session.',
              });
            }
            const page = record.pages.find((candidate) => candidate.id === targetId);
            if (page === undefined) {
              return yield* new BrowserError({
                reason: 'PageNotFound',
                detail: `Page ${targetId} was not found in this Session.`,
              });
            }
            return { targetId, url: page.url };
          }),
        );

        const classified = yield* validateAgentUrl(snapshot.url);
        yield* authorizeClassifiedUrl(sessionId, classified);
        yield* waitIfControlPaused(sessionId);

        const resolved = yield* lock(
          Effect.gen(function* () {
            const record = yield* requireLocalRecord(sessionId);
            const current = record.pages.find((candidate) => candidate.id === snapshot.targetId);
            if (current === undefined) {
              return yield* new BrowserError({
                reason: 'PageNotFound',
                detail: `Page ${snapshot.targetId} was not found in this Session.`,
              });
            }
            if (current.url !== snapshot.url) {
              return undefined;
            }
            const page = yield* ensureAgentPageLive(record, snapshot.targetId);
            const changed = yield* activateAgentControl(record, action, page.id);
            if (changed) {
              yield* syncPresentation();
              yield* emitState(record);
            }
            return page;
          }),
        );
        if (resolved !== undefined) return resolved;
      }
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
          if (current === undefined || current.suspended) return;
          const persistedChanged =
            (event.url !== undefined && event.url !== current.url) ||
            (event.title !== undefined && event.title !== current.title);
          record.pages[index] = {
            ...current,
            ...(event.url === undefined ? {} : { url: event.url }),
            ...(event.title === undefined ? {} : { title: event.title }),
            ...(event.loading === undefined ? {} : { loading: event.loading }),
            ...(event.canGoBack === undefined ? {} : { canGoBack: event.canGoBack }),
            ...(event.canGoForward === undefined ? {} : { canGoForward: event.canGoForward }),
          };
          if (persistedChanged) {
            yield* persistRecord(record);
          }
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
          yield* persistRecord(record);
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
            liveOrder.delete(event.pageId);
            return;
          }
          const record = sessions.get(owner);
          if (record === undefined) {
            pageOwners.delete(event.pageId);
            clearPageLogs(event.pageId);
            liveOrder.delete(event.pageId);
            return;
          }
          const prevActive = record.activePageId;
          if (!removePage(record, event.pageId).removed) return;
          yield* persistRecord(record);
          if (prevActive === event.pageId) {
            if (record.open && record.activePageId !== null) {
              yield* ensurePageLive(record, record.activePageId);
            }
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
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          return currentSnapshot(record);
        }),
      );
    });

    const setOpen = Effect.fn('BrowserService.setOpen')(function* (
      sessionId: SessionId,
      open: boolean,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          if (open && record.pages.length === 0) {
            yield* appendPage(record, 'about:blank');
          } else if (open && record.activePageId !== null) {
            yield* ensurePageLive(record, record.activePageId);
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
          yield* persistRecord(record);
          yield* enforceLruCap();
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
          const record = yield* loadRecord(sessionId);
          const clamped = clampBrowserWidth(width);
          if (record.width !== clamped) {
            record.width = clamped;
            yield* persistRecord(record);
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
          if (sessionId !== null) {
            const record = yield* loadRecord(sessionId);
            let autoOpened = false;
            if (record.control._tag !== 'idle' && !record.open) {
              record.open = true;
              autoOpened = true;
              yield* persistRecord(record);
            }
            let woke = false;
            if (record.open && record.activePageId !== null) {
              woke = yield* ensurePageLive(record, record.activePageId);
            }
            if (autoOpened || woke) {
              yield* emitState(record);
            }
          }
          yield* enforceLruCap();
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
          const record = yield* loadRecord(sessionId);
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
          const record = yield* loadRecord(sessionId);
          if (record.activePageId === null || record.pages.length === 0) {
            const created = yield* appendPage(record, 'about:blank');
            record.activePageId = created.id;
          }
          const page = yield* activePageOf(record);
          if (record.pickerActive) {
            yield* host.cancelElementPicker(page.id);
            record.pickerActive = false;
          }
          if (page.suspended) {
            yield* ensurePageLive(record, page.id, parsed.url);
          } else {
            touchPage(page.id);
            const index = record.pages.findIndex((candidate) => candidate.id === page.id);
            if (index !== -1) {
              record.pages[index] = {
                ...page,
                url: parsed.url,
                loading: parsed.url !== 'about:blank',
              };
            }
            yield* host.loadUrl(page.id, parsed.url);
          }
          yield* persistRecord(record);
          yield* syncPresentation();
          yield* emitState(record);
          return currentSnapshot(record);
        }),
      );
    });

    const goBack = Effect.fn('BrowserService.goBack')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
            yield* emitState(record);
          } else {
            yield* host.goBack(page.id);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const goForward = Effect.fn('BrowserService.goForward')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
            yield* emitState(record);
          } else {
            yield* host.goForward(page.id);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const reload = Effect.fn('BrowserService.reload')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
            yield* emitState(record);
          } else {
            yield* host.reload(page.id);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const openExternal = Effect.fn('BrowserService.openExternal')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
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
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
            yield* emitState(record);
          }
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
          const record = yield* loadRecord(sessionId);
          if (record.pickerActive && record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
            record.pickerActive = false;
          }
          record.lastFrameDataUrl = undefined;
          yield* appendPage(record, initialUrl);
          yield* persistRecord(record);
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
          const record = yield* loadRecord(sessionId);
          const page = record.pages.find((candidate) => candidate.id === pageId);
          if (page === undefined) {
            return yield* new BrowserError({
              reason: 'PageNotFound',
              detail: `Page ${pageId} was not found in this Session.`,
            });
          }
          const changed = record.activePageId !== pageId;
          if (changed) {
            if (record.pickerActive && record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
              record.pickerActive = false;
            }
            record.activePageId = pageId;
            record.lastFrameDataUrl = undefined;
          }
          const woke = yield* ensurePageLive(record, pageId);
          if (changed) {
            yield* persistRecord(record);
          }
          if (changed || woke) {
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
          const record = yield* loadRecord(sessionId);
          const wasActive = record.activePageId === pageId;
          const wasPickerActive = wasActive && record.pickerActive;
          const removed = removePage(record, pageId);
          if (!removed.removed) {
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
          if (!removed.wasSuspended) {
            yield* host.closePage(pageId);
          }
          if (wasActive && record.open && record.activePageId !== null) {
            yield* ensurePageLive(record, record.activePageId);
          }
          yield* persistRecord(record);
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
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
            yield* emitState(record);
          }
          return yield* host.captureScreenshot(page.id);
        }),
      );
    });

    const startElementPicker = Effect.fn('BrowserService.startElementPicker')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          if (yield* ensurePageLive(record, page.id)) {
            yield* syncPresentation();
          }
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
          const record = yield* loadRecord(sessionId);
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
          const record = yield* loadRecord(sessionId);
          const page = yield* activePageOf(record);
          return { errors: [...(pageErrors.get(page.id) ?? [])] };
        }),
      );
    });

    const clearData = Effect.fn('BrowserService.clearData')(function* () {
      yield* lock(host.clearBrowsingData());
    });

    const onSessionDeleted = Effect.fn('BrowserService.onSessionDeleted')(function* (
      sessionId: SessionId,
    ) {
      yield* lock(
        Effect.gen(function* () {
          const record = sessions.get(sessionId);
          if (record !== undefined) {
            const wasHandoff = record.control._tag === 'handoffWaiting';
            yield* cancelAllWaiters(record, 'Session deleted while Browser control was paused.');
            if (wasHandoff) {
              yield* PubSub.publish(handoffAttentionHub, { sessionId, pending: false });
            }
            for (const page of record.pages) {
              if (record.pickerActive && record.activePageId === page.id) {
                yield* host.cancelElementPicker(page.id);
              }
              pageOwners.delete(page.id);
              clearPageLogs(page.id);
              liveOrder.delete(page.id);
              if (!page.suspended) {
                yield* host.closePage(page.id);
              }
            }
            sessions.delete(sessionId);
          }
          if (browserStore !== undefined) {
            yield* browserStore.remove(sessionId);
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
        Effect.gen(function* () {
          const record = yield* loadRecord(sessionId);
          record.deviceId = deviceId;
        }),
      );
    });

    const setSessionPermissionMode = Effect.fn('BrowserService.setSessionPermissionMode')(
      function* (sessionId: SessionId, mode: PermissionMode) {
        yield* lock(
          Effect.gen(function* () {
            const record = yield* loadRecord(sessionId);
            record.permissionMode = mode;
          }),
        );
      },
    );

    const setOriginPermissionHandler = Effect.fn('BrowserService.setOriginPermissionHandler')(
      function* (handler: BrowserOriginPermissionHandler) {
        yield* Effect.sync(() => {
          originHandler = handler;
        });
      },
    );

    const agentNavigate = Effect.fn('BrowserService.agentNavigate')(function* (
      sessionId: SessionId,
      rawUrl: string,
      pageId?: PageId,
    ) {
      const classified = yield* validateAgentUrl(rawUrl);
      yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          if (pageId !== undefined && !record.pages.some((item) => item.id === pageId)) {
            return yield* new BrowserError({
              reason: 'PageNotFound',
              detail: `Page ${pageId} was not found in this Session.`,
            });
          }
        }),
      );
      yield* authorizeClassifiedUrl(sessionId, classified);
      yield* waitIfControlPaused(sessionId);
      const targetUrl = classified.url;
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          let page: BrowserPage;
          let materialized = false;
          if (pageId === undefined) {
            if (record.activePageId === null || record.pages.length === 0) {
              page = yield* appendPage(record, 'about:blank');
            } else {
              materialized = yield* ensurePageLive(record, record.activePageId, targetUrl);
              page = yield* ensureAgentPageLive(record, record.activePageId);
            }
          } else {
            const candidate = record.pages.find((item) => item.id === pageId);
            if (candidate === undefined) {
              return yield* new BrowserError({
                reason: 'PageNotFound',
                detail: `Page ${pageId} was not found in this Session.`,
              });
            }
            materialized = yield* ensurePageLive(record, pageId, targetUrl);
            page = yield* ensureAgentPageLive(record, pageId);
          }
          if (record.pickerActive && record.activePageId === page.id) {
            yield* host.cancelElementPicker(page.id);
            record.pickerActive = false;
          }
          if (!materialized) {
            const index = record.pages.findIndex((candidate) => candidate.id === page.id);
            if (index !== -1) {
              record.pages[index] = {
                ...page,
                url: targetUrl,
                loading: true,
              };
            }
            yield* host.loadUrl(page.id, targetUrl);
          }
          yield* activateAgentControl(record, 'navigate', page.id);
          yield* persistRecord(record);
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
      const page = yield* resolveAgentPage(sessionId, 'back', pageId);
      yield* host.goBack(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentForward = Effect.fn('BrowserService.agentForward')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'forward', pageId);
      yield* host.goForward(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentReload = Effect.fn('BrowserService.agentReload')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'reload', pageId);
      yield* host.reload(page.id);
      return { pageId: page.id, url: page.url, title: page.title };
    });

    const agentListPages = Effect.fn('BrowserService.agentListPages')(function* (
      sessionId: SessionId,
    ) {
      yield* waitIfControlPaused(sessionId);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const changed = yield* activateAgentControl(
            record,
            'pages',
            record.activePageId ?? undefined,
          );
          if (changed) {
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

    const agentCreatePage = Effect.fn('BrowserService.agentCreatePage')(function* (
      sessionId: SessionId,
      rawUrl?: string,
    ) {
      let initialUrl = 'about:blank';
      if (rawUrl !== undefined) {
        const classified = yield* validateAgentUrl(rawUrl);
        yield* lock(requireLocalRecord(sessionId));
        yield* authorizeClassifiedUrl(sessionId, classified);
        initialUrl = classified.url;
      }
      yield* waitIfControlPaused(sessionId);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          if (record.pickerActive && record.activePageId !== null) {
            yield* host.cancelElementPicker(record.activePageId);
            record.pickerActive = false;
          }
          record.lastFrameDataUrl = undefined;
          const page = yield* appendPage(record, initialUrl);
          yield* activateAgentControl(record, 'pages', page.id);
          yield* persistRecord(record);
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
      yield* waitIfControlPaused(sessionId);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          yield* ensureAgentPageLive(record, pageId);
          const pageChanged = record.activePageId !== pageId;
          if (pageChanged) {
            if (record.pickerActive && record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
              record.pickerActive = false;
            }
            record.activePageId = pageId;
            record.lastFrameDataUrl = undefined;
            yield* persistRecord(record);
          }
          const controlChanged = yield* activateAgentControl(record, 'pages', pageId);
          if (pageChanged || controlChanged) {
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
      yield* waitIfControlPaused(sessionId);
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const wasActive = record.activePageId === pageId;
          const wasPickerActive = wasActive && record.pickerActive;
          const removed = removePage(record, pageId);
          if (!removed.removed) {
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
          if (!removed.wasSuspended) {
            yield* host.closePage(pageId);
          }
          if (record.open && record.activePageId !== null) {
            yield* ensurePageLive(record, record.activePageId);
          }
          yield* activateAgentControl(record, 'pages', record.activePageId ?? undefined);
          yield* persistRecord(record);
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
      const page = yield* resolveAgentPage(sessionId, 'snapshot', pageId);
      return yield* host.snapshot(page.id);
    });

    const agentScreenshot = Effect.fn('BrowserService.agentScreenshot')(function* (
      sessionId: SessionId,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'screenshot', pageId);
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
      const page = yield* resolveAgentPage(sessionId, 'console', options?.pageId);
      return yield* lock(
        Effect.sync(() => {
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
      const page = yield* resolveAgentPage(sessionId, 'network', options?.pageId);
      return yield* lock(
        Effect.sync(() => {
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
      const page = yield* resolveAgentPage(sessionId, 'click', options?.pageId);
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
      const page = yield* resolveAgentPage(sessionId, 'fill', pageId);
      return yield* host.fill(page.id, target, value);
    });

    const agentType = Effect.fn('BrowserService.agentType')(function* (
      sessionId: SessionId,
      text: string,
      target?: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'type', pageId);
      return yield* host.type(page.id, text, target);
    });

    const agentPress = Effect.fn('BrowserService.agentPress')(function* (
      sessionId: SessionId,
      key: string,
      target?: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'press', pageId);
      return yield* host.press(page.id, key, target);
    });

    const agentSelect = Effect.fn('BrowserService.agentSelect')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      values: ReadonlyArray<string>,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'select', pageId);
      return yield* host.select(page.id, target, values);
    });

    const agentHover = Effect.fn('BrowserService.agentHover')(function* (
      sessionId: SessionId,
      target: BrowserElementTarget,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'hover', pageId);
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
      const page = yield* resolveAgentPage(sessionId, 'scroll', options.pageId);
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
      const page = yield* resolveAgentPage(sessionId, 'wait_for', pageId);
      return yield* host.waitFor(page.id, condition);
    });

    const agentEval = Effect.fn('BrowserService.agentEval')(function* (
      sessionId: SessionId,
      expression: string,
      pageId?: PageId,
    ) {
      const page = yield* resolveAgentPage(sessionId, 'eval', pageId);
      return yield* host.evaluate(page.id, expression);
    });

    const cancelHandoffInterrupt = (
      record: SessionBrowserRecord,
      waiter: Deferred.Deferred<void, BrowserError>,
    ): Effect.Effect<void> =>
      lock(
        Effect.gen(function* () {
          const index = record.waiters.indexOf(waiter);
          if (index !== -1) {
            record.waiters.splice(index, 1);
          }
          if (record.control._tag === 'handoffWaiting') {
            yield* PubSub.publish(handoffAttentionHub, {
              sessionId: record.sessionId,
              pending: false,
            });
            record.control = { _tag: 'idle' };
            yield* emitState(record);
          }
        }),
      );

    const agentHandoff = Effect.fn('BrowserService.agentHandoff')(function* (
      sessionId: SessionId,
      rawReason: string,
      pageId?: PageId,
    ) {
      const reason = rawReason.trim();
      if (reason.length === 0) {
        return yield* new BrowserError({
          reason: 'Unavailable',
          detail: 'Handoff reason must not be empty.',
        });
      }
      yield* waitIfControlPaused(sessionId);
      const pending = yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          const targetId = pageId ?? record.activePageId;
          if (targetId === null) {
            return yield* new BrowserError({
              reason: 'NoActivePage',
              detail: 'No active Page is open in this Session.',
            });
          }
          yield* ensureAgentPageLive(record, targetId);
          let persistedChanged = false;
          if (record.activePageId !== targetId) {
            if (record.pickerActive && record.activePageId !== null) {
              yield* host.cancelElementPicker(record.activePageId);
              record.pickerActive = false;
            }
            record.activePageId = targetId;
            record.lastFrameDataUrl = undefined;
            persistedChanged = true;
          }
          if (activeSessionId === sessionId && !record.open) {
            record.open = true;
            persistedChanged = true;
          }
          if (persistedChanged) {
            yield* persistRecord(record);
          }
          const waiter = yield* Deferred.make<void, BrowserError>();
          record.waiters.push(waiter);
          record.control = { _tag: 'handoffWaiting', pageId: targetId, reason };
          yield* PubSub.publish(handoffAttentionHub, { sessionId, pending: true });
          yield* syncPresentation();
          yield* emitState(record);
          return { record, waiter, targetId };
        }),
      );
      yield* Deferred.await(pending.waiter).pipe(
        Effect.onInterrupt(() => cancelHandoffInterrupt(pending.record, pending.waiter)),
      );
      return { resumed: true as const, pageId: pending.targetId };
    });

    const takeOver = Effect.fn('BrowserService.takeOver')(function* (sessionId: SessionId) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          if (record.control._tag === 'agentActive') {
            record.control = { _tag: 'userTakeover', pausedCount: record.waiters.length };
            yield* emitState(record);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const continueAgent = Effect.fn('BrowserService.continueAgent')(function* (
      sessionId: SessionId,
    ) {
      return yield* lock(
        Effect.gen(function* () {
          const record = yield* requireLocalRecord(sessionId);
          if (record.control._tag !== 'idle') {
            const wasHandoff = record.control._tag === 'handoffWaiting';
            yield* resolveAllWaiters(record);
            record.control = { _tag: 'agentActive' };
            if (wasHandoff) {
              yield* PubSub.publish(handoffAttentionHub, { sessionId, pending: false });
            }
            yield* emitState(record);
          }
          return currentSnapshot(record);
        }),
      );
    });

    const onTurnEnded = Effect.fn('BrowserService.onTurnEnded')(function* (sessionId: SessionId) {
      yield* lock(
        Effect.gen(function* () {
          const record = sessions.get(sessionId);
          if (record === undefined) return;
          const wasHandoff = record.control._tag === 'handoffWaiting';
          yield* cancelAllWaiters(record, 'Turn ended while Browser control was paused.');
          if (wasHandoff) {
            yield* PubSub.publish(handoffAttentionHub, { sessionId, pending: false });
          }
          if (record.control._tag !== 'idle') {
            record.control = { _tag: 'idle' };
            yield* emitState(record);
          }
        }),
      );
    });

    const handoffAttention = Stream.unwrap(
      PubSub.subscribe(handoffAttentionHub).pipe(Effect.map((sub) => Stream.fromSubscription(sub))),
    );

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
      // #216 Persistence, LRU & Clear browsing data
      clearData,
      // #217 Agent Browser MCP capabilities
      setSessionDevice,
      // #218 Agent URL safety guardrails & origin permissions
      setSessionPermissionMode,
      setOriginPermissionHandler,
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
      // #219: Live Agent control, user Take over & Browser handoff
      agentHandoff,
      takeOver,
      continueAgent,
      onTurnEnded,
      handoffAttention,
      onSessionDeleted,
      events,
    });
  }),
);
