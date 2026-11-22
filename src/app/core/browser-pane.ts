import {
  DestroyRef,
  InjectionToken,
  Injectable,
  type Type,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { Effect, Exit, Schedule, Stream } from 'effect';
import type { RpcClientError } from 'effect/rpc';
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserBounds,
  type BrowserError,
  type BrowserEvent,
  type BrowserState,
  clampBrowserWidth,
  type PageId,
} from '../../shared/browser/browser.rpc';
import type { SessionId } from '../../shared/sessions/sessions.rpc';
import { ComposerBridge } from './composer-bridge';
import { DesktopApi } from './desktop-api';
import { EffectRuntime } from './effect-runtime';
import { OverlayOcclusion } from './overlay-occlusion';

/**
 * The component that renders a Session's embedded Browser pane, taking `sessionId` as an input.
 * Features never import each other, so the shell renders whatever `app.config.ts` provides here.
 */
export const BROWSER_PANE_VIEW = new InjectionToken<Type<unknown> | null>('BROWSER_PANE_VIEW', {
  providedIn: 'root',
  factory: () => null,
});

const RESUBSCRIBE_AFTER = '500 millis';

const followBrowserEvents = (onEvent: (event: BrowserEvent) => void) =>
  Effect.gen(function* () {
    const api = yield* DesktopApi;
    yield* api['Browser.events']().pipe(
      Stream.runForEach((event) => Effect.sync(() => onEvent(event))),
    );
  }).pipe(Effect.retry(Schedule.spaced(RESUBSCRIBE_AFTER)));

const fetchBrowserState = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.getState']({ sessionId });
});

const setBrowserOpen = Effect.fnUntraced(function* (sessionId: SessionId, open: boolean) {
  const api = yield* DesktopApi;
  return yield* api['Browser.setOpen']({ sessionId, open });
});

const setBrowserWidth = Effect.fnUntraced(function* (sessionId: SessionId, width: number) {
  const api = yield* DesktopApi;
  return yield* api['Browser.setWidth']({ sessionId, width });
});

const setActiveBrowserSession = Effect.fnUntraced(function* (sessionId: SessionId | null) {
  const api = yield* DesktopApi;
  yield* api['Browser.setActiveSession']({ sessionId });
});

const setBrowserBounds = Effect.fnUntraced(function* (sessionId: SessionId, bounds: BrowserBounds) {
  const api = yield* DesktopApi;
  yield* api['Browser.setBounds']({ sessionId, bounds });
});

// Occlusion (#214)
const setBrowserOccluded = Effect.fnUntraced(function* (occluded: boolean, captureFrame?: boolean) {
  const api = yield* DesktopApi;
  yield* api['Browser.setOccluded']({
    occluded,
    ...(captureFrame === undefined ? {} : { captureFrame }),
  });
});

const navigateBrowser = Effect.fnUntraced(function* (sessionId: SessionId, url: string) {
  const api = yield* DesktopApi;
  return yield* api['Browser.navigate']({ sessionId, url });
});

const goBackBrowser = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.goBack']({ sessionId });
});

const goForwardBrowser = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.goForward']({ sessionId });
});

const reloadBrowser = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.reload']({ sessionId });
});

const openExternalBrowser = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.openExternal']({ sessionId });
});

const openBrowserDevTools = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.openDevTools']({ sessionId });
});

// #213: Multi-Page management
const createBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, url?: string) {
  const api = yield* DesktopApi;
  return yield* api['Browser.createPage']({
    sessionId,
    ...(url === undefined ? {} : { url }),
  });
});

const selectBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, pageId: PageId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.selectPage']({ sessionId, pageId });
});

const closeBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, pageId: PageId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.closePage']({ sessionId, pageId });
});

// #215 Composer bridge
const captureBrowserScreenshot = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.captureScreenshot']({ sessionId });
});

const startBrowserElementPicker = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.startElementPicker']({ sessionId });
});

const cancelBrowserElementPicker = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.cancelElementPicker']({ sessionId });
});

const fetchBrowserConsoleErrors = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.getConsoleErrors']({ sessionId });
});

// #216: Persistence, LRU & browsing data
const clearBrowserData = Effect.fnUntraced(function* () {
  const api = yield* DesktopApi;
  return yield* api['Browser.clearData']();
});

// #219: Live Agent control, user Take over & Browser handoff
const takeOverBrowser = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.takeOver']({ sessionId });
});

const continueBrowserAgent = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.continueAgent']({ sessionId });
});

const errorTextFor = (reason: BrowserError['reason']): string => {
  switch (reason) {
    case 'SchemeBlocked':
      return $localize`Only http://, https://, and about:blank addresses are allowed.`;
    case 'PermissionDenied':
      return $localize`Access to that origin was denied.`;
    case 'InvalidUrl':
      return $localize`Enter a valid web address.`;
    case 'RemoteUnsupported':
      return $localize`Browser is not available for remote Sessions.`;
    case 'NoActivePage':
    case 'PageNotFound':
    case 'NotFound':
    case 'PickerCancelled':
    case 'Unavailable':
      return $localize`Could not complete the browser action.`;
  }
};

const sameBounds = (a: BrowserBounds | undefined, b: BrowserBounds): boolean =>
  a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Shared Browser pane state per Session, synchronizing RPC state, width, bounds, and navigation. */
@Injectable({ providedIn: 'root' })
export class BrowserPaneState {
  private readonly runtime = inject(EffectRuntime);
  private readonly composerBridge = inject(ComposerBridge);
  private readonly occlusion = inject(OverlayOcclusion);
  private readonly aborts = new AbortController();
  private readonly _states = signal<ReadonlyMap<SessionId, BrowserState>>(new Map());
  private readonly _errors = signal<ReadonlyMap<SessionId, string>>(new Map());
  private readonly _dragWidth = signal<number | null>(null);
  private readonly _clearingData = signal(false);
  private readonly loadedSessions = new Set<SessionId>();
  private readonly lastBounds = new Map<SessionId, BrowserBounds>();
  private lastActiveSession: SessionId | null | undefined = undefined;
  private lastOccluded: boolean | undefined = undefined;

  readonly states = this._states.asReadonly();
  readonly dragWidth = this._dragWidth.asReadonly();
  readonly clearingData = this._clearingData.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.aborts.abort());
    void this.runtime.run(
      followBrowserEvents((event) => this.applyEvent(event)),
      { signal: this.aborts.signal },
    );
    effect(() => {
      const occluded = this.occlusion.occluded();
      untracked(() => this.setOccluded(occluded));
    });
  }

  stateFor(sessionId: SessionId | null): BrowserState | null {
    return sessionId === null ? null : (this._states().get(sessionId) ?? null);
  }

  isOpen(sessionId: SessionId | null): boolean {
    return this.stateFor(sessionId)?.open ?? false;
  }

  widthFor(sessionId: SessionId | null): number {
    const drag = this._dragWidth();
    if (drag !== null) return clampBrowserWidth(drag);
    return clampBrowserWidth(this.stateFor(sessionId)?.width ?? BROWSER_DEFAULT_WIDTH);
  }

  errorFor(sessionId: SessionId | null): string | null {
    return sessionId === null ? null : (this._errors().get(sessionId) ?? null);
  }

  clearError(sessionId: SessionId): void {
    this.setError(sessionId, null);
  }

  ensureLoaded(sessionId: SessionId): void {
    if (this.loadedSessions.has(sessionId)) return;
    this.loadedSessions.add(sessionId);
    void this.runtime
      .run(fetchBrowserState(sessionId), { signal: this.aborts.signal })
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          this.putState(exit.value);
        } else {
          this.loadedSessions.delete(sessionId);
        }
      });
  }

  syncContext(sessionId: SessionId | null): void {
    if (this.lastActiveSession !== sessionId) {
      this.lastActiveSession = sessionId;
      void this.runtime.run(setActiveBrowserSession(sessionId), { signal: this.aborts.signal });
    }
    if (sessionId !== null) {
      this.ensureLoaded(sessionId);
    }
  }

  async setOpen(sessionId: SessionId, open: boolean): Promise<void> {
    if (!open) this._dragWidth.set(null);
    const exit = await this.runtime.run(setBrowserOpen(sessionId, open), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) {
      this.putState(exit.value);
    }
  }

  async toggle(sessionId: SessionId): Promise<void> {
    await this.setOpen(sessionId, !this.isOpen(sessionId));
  }

  setDragWidth(width: number | null): void {
    this._dragWidth.set(width === null ? null : clampBrowserWidth(width));
  }

  async commitWidth(sessionId: SessionId, width: number): Promise<void> {
    const clamped = clampBrowserWidth(width);
    this._dragWidth.set(null);
    const existing = this.stateFor(sessionId);
    if (existing !== null) {
      this.putState({ ...existing, width: clamped });
    }
    const exit = await this.runtime.run(setBrowserWidth(sessionId, clamped), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) {
      this.putState(exit.value);
    }
  }

  setBounds(sessionId: SessionId, bounds: BrowserBounds): void {
    const rounded: BrowserBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    };
    if (sameBounds(this.lastBounds.get(sessionId), rounded)) return;
    this.lastBounds.set(sessionId, rounded);
    void this.runtime.run(setBrowserBounds(sessionId, rounded), { signal: this.aborts.signal });
  }

  // Occlusion (#214)
  setOccluded(occluded: boolean, captureFrame?: boolean): void {
    if (this.lastOccluded === occluded) return;
    this.lastOccluded = occluded;
    void this.runtime.run(setBrowserOccluded(occluded, captureFrame), {
      signal: this.aborts.signal,
    });
  }

  async navigate(sessionId: SessionId, url: string): Promise<boolean> {
    return this.runStateAction(navigateBrowser(sessionId, url), sessionId);
  }

  // #213: Multi-Page management
  async createPage(sessionId: SessionId, url?: string): Promise<void> {
    await this.runStateAction(createBrowserPage(sessionId, url), sessionId);
  }

  async selectPage(sessionId: SessionId, pageId: PageId): Promise<void> {
    await this.runStateAction(selectBrowserPage(sessionId, pageId), sessionId);
  }

  async closePage(sessionId: SessionId, pageId: PageId): Promise<void> {
    await this.runStateAction(closeBrowserPage(sessionId, pageId), sessionId);
  }

  private async runAction<T>(
    program: Effect.Effect<T, BrowserError | RpcClientError.RpcClientError, DesktopApi>,
    sessionId: SessionId,
  ): Promise<T | undefined> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(
      program.pipe(
        Effect.map((value) => ({ ok: true as const, value })),
        Effect.catchTag('BrowserError', (error) =>
          Effect.succeed({ ok: false as const, reason: error.reason }),
        ),
      ),
      { signal: this.aborts.signal },
    );
    if (!Exit.isSuccess(exit)) {
      this.setError(sessionId, errorTextFor('Unavailable'));
      return undefined;
    }
    if (!exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
      return undefined;
    }
    return exit.value.value;
  }

  private async runStateAction(
    program: Effect.Effect<BrowserState, BrowserError | RpcClientError.RpcClientError, DesktopApi>,
    sessionId: SessionId,
  ): Promise<boolean> {
    const state = await this.runAction(program, sessionId);
    if (state === undefined) return false;
    this.putState(state);
    return true;
  }

  async goBack(sessionId: SessionId): Promise<void> {
    await this.runStateAction(goBackBrowser(sessionId), sessionId);
  }

  async goForward(sessionId: SessionId): Promise<void> {
    await this.runStateAction(goForwardBrowser(sessionId), sessionId);
  }

  async reload(sessionId: SessionId): Promise<void> {
    await this.runStateAction(reloadBrowser(sessionId), sessionId);
  }

  async openExternal(sessionId: SessionId): Promise<void> {
    await this.runAction(openExternalBrowser(sessionId), sessionId);
  }

  async openDevTools(sessionId: SessionId): Promise<void> {
    await this.runtime.run(openBrowserDevTools(sessionId), { signal: this.aborts.signal });
  }

  pickerActiveFor(sessionId: SessionId | null): boolean {
    return this.stateFor(sessionId)?.pickerActive ?? false;
  }

  async captureScreenshot(sessionId: SessionId): Promise<boolean> {
    const shot = await this.runAction(captureBrowserScreenshot(sessionId), sessionId);
    if (shot === undefined) return false;
    this.composerBridge.attachImage(sessionId, shot);
    return true;
  }

  async toggleElementPicker(sessionId: SessionId): Promise<void> {
    if (this.pickerActiveFor(sessionId)) {
      await this.cancelElementPicker(sessionId);
    } else {
      await this.startElementPicker(sessionId);
    }
  }

  async startElementPicker(sessionId: SessionId): Promise<boolean> {
    return this.runStateAction(startBrowserElementPicker(sessionId), sessionId);
  }

  async cancelElementPicker(sessionId: SessionId): Promise<void> {
    const exit = await this.runtime.run(cancelBrowserElementPicker(sessionId), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) {
      this.putState(exit.value);
    }
  }

  async attachConsoleErrors(sessionId: SessionId): Promise<'attached' | 'empty' | 'failed'> {
    const result = await this.runAction(fetchBrowserConsoleErrors(sessionId), sessionId);
    if (result === undefined) return 'failed';
    if (result.errors.length === 0) return 'empty';
    this.composerBridge.attachConsoleErrors(sessionId, result.errors);
    return 'attached';
  }

  async clearData(): Promise<boolean> {
    const exit = await this.runtime.run(
      clearBrowserData().pipe(
        Effect.as(true),
        Effect.catchTag('BrowserError', () => Effect.succeed(false)),
      ),
      { signal: this.aborts.signal },
    );
    return Exit.isSuccess(exit) && exit.value;
  }

  async clearDataWithToast(notify: {
    readonly success: (message: string) => void;
    readonly error: (message: string) => void;
  }): Promise<boolean> {
    if (this._clearingData()) return false;
    this._clearingData.set(true);
    try {
      const ok = await this.clearData();
      if (ok) {
        notify.success($localize`Browsing data cleared.`);
      } else {
        notify.error($localize`Could not clear browsing data.`);
      }
      return ok;
    } finally {
      this._clearingData.set(false);
    }
  }

  // #219: Live Agent control, user Take over & Browser handoff
  async takeOver(sessionId: SessionId): Promise<boolean> {
    return this.runStateAction(takeOverBrowser(sessionId), sessionId);
  }

  async continueAgent(sessionId: SessionId): Promise<boolean> {
    return this.runStateAction(continueBrowserAgent(sessionId), sessionId);
  }

  private applyEvent(event: BrowserEvent): void {
    switch (event._tag) {
      case 'State':
        this.putState(event.state);
        return;
      case 'ElementPicked':
        this.composerBridge.attachPickedElement(event.sessionId, event.element);
        return;
    }
  }

  private putState(state: BrowserState): void {
    this.loadedSessions.add(state.sessionId);
    this._states.update((map) => {
      const next = new Map(map);
      next.set(state.sessionId, state);
      return next;
    });
  }

  private setError(sessionId: SessionId, message: string | null): void {
    this._errors.update((map) => {
      const next = new Map(map);
      if (message === null) next.delete(sessionId);
      else next.set(sessionId, message);
      return next;
    });
  }
}
