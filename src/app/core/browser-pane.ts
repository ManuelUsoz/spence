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
import {
  BROWSER_DEFAULT_WIDTH,
  type BrowserBounds,
  type BrowserConsoleError,
  type BrowserError,
  type BrowserEvent,
  type BrowserScreenshotResult,
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

type BrowserActionResult =
  | { readonly ok: true; readonly state: BrowserState }
  | { readonly ok: false; readonly reason: BrowserError['reason'] };

type BrowserVoidResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: BrowserError['reason'] };

const navigateBrowser = Effect.fnUntraced(function* (sessionId: SessionId, url: string) {
  const api = yield* DesktopApi;
  return yield* api['Browser.navigate']({ sessionId, url }).pipe(
    Effect.map((state): BrowserActionResult => ({ ok: true, state })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
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
  return yield* api['Browser.openExternal']({ sessionId }).pipe(
    Effect.as({ ok: true } as BrowserVoidResult),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const openBrowserDevTools = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.openDevTools']({ sessionId });
});

type BrowserValueResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: BrowserError['reason'] };

// #213: Multi-Page management
const createBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, url?: string) {
  const api = yield* DesktopApi;
  return yield* api['Browser.createPage']({
    sessionId,
    ...(url === undefined ? {} : { url }),
  }).pipe(
    Effect.map((state): BrowserActionResult => ({ ok: true, state })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const selectBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, pageId: PageId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.selectPage']({ sessionId, pageId }).pipe(
    Effect.map((state): BrowserActionResult => ({ ok: true, state })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const closeBrowserPage = Effect.fnUntraced(function* (sessionId: SessionId, pageId: PageId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.closePage']({ sessionId, pageId }).pipe(
    Effect.map((state): BrowserActionResult => ({ ok: true, state })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

// #215 Composer bridge
const captureBrowserScreenshot = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.captureScreenshot']({ sessionId }).pipe(
    Effect.map((value): BrowserValueResult<BrowserScreenshotResult> => ({ ok: true, value })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const startBrowserElementPicker = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.startElementPicker']({ sessionId }).pipe(
    Effect.map((state): BrowserActionResult => ({ ok: true, state })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const cancelBrowserElementPicker = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.cancelElementPicker']({ sessionId });
});

const fetchBrowserConsoleErrors = Effect.fnUntraced(function* (sessionId: SessionId) {
  const api = yield* DesktopApi;
  return yield* api['Browser.getConsoleErrors']({ sessionId }).pipe(
    Effect.map((result): BrowserValueResult<ReadonlyArray<BrowserConsoleError>> => ({
      ok: true,
      value: result.errors,
    })),
    Effect.catchTag('BrowserError', (error) =>
      Effect.succeed({ ok: false, reason: error.reason } as const),
    ),
  );
});

const errorTextFor = (reason: BrowserError['reason']): string => {
  switch (reason) {
    case 'SchemeBlocked':
      return $localize`Only http://, https://, and about:blank addresses are allowed.`;
    case 'InvalidUrl':
      return $localize`Enter a valid web address.`;
    case 'RemoteUnsupported':
      return $localize`Browser is not available for remote Sessions.`;
    case 'NoActivePage':
    case 'PageNotFound':
    case 'NotFound':
    case 'PickerCancelled':
    case 'CaptureFailed':
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
  private readonly loadedSessions = new Set<SessionId>();
  private readonly lastBounds = new Map<SessionId, BrowserBounds>();
  private lastActiveSession: SessionId | null | undefined = undefined;
  private lastOccluded: boolean | undefined = undefined;

  readonly states = this._states.asReadonly();
  readonly dragWidth = this._dragWidth.asReadonly();

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

  private async runStateAction(
    program: Effect.Effect<BrowserActionResult, unknown, DesktopApi>,
    sessionId: SessionId,
  ): Promise<boolean> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(program, { signal: this.aborts.signal });
    if (!Exit.isSuccess(exit)) {
      this.setError(sessionId, errorTextFor('Unavailable'));
      return false;
    }
    if (!exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
      return false;
    }
    this.putState(exit.value.state);
    return true;
  }

  async goBack(sessionId: SessionId): Promise<void> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(goBackBrowser(sessionId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit)) this.putState(exit.value);
  }

  async goForward(sessionId: SessionId): Promise<void> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(goForwardBrowser(sessionId), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit)) this.putState(exit.value);
  }

  async reload(sessionId: SessionId): Promise<void> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(reloadBrowser(sessionId), { signal: this.aborts.signal });
    if (Exit.isSuccess(exit)) this.putState(exit.value);
  }

  async openExternal(sessionId: SessionId): Promise<void> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(openExternalBrowser(sessionId), {
      signal: this.aborts.signal,
    });
    if (Exit.isSuccess(exit) && !exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
    }
  }

  async openDevTools(sessionId: SessionId): Promise<void> {
    await this.runtime.run(openBrowserDevTools(sessionId), { signal: this.aborts.signal });
  }

  pickerActiveFor(sessionId: SessionId | null): boolean {
    return this.stateFor(sessionId)?.pickerActive ?? false;
  }

  async captureScreenshot(sessionId: SessionId): Promise<boolean> {
    this.setError(sessionId, null);
    const exit = await this.runtime.run(captureBrowserScreenshot(sessionId), {
      signal: this.aborts.signal,
    });
    if (!Exit.isSuccess(exit)) {
      this.setError(sessionId, errorTextFor('CaptureFailed'));
      return false;
    }
    if (!exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
      return false;
    }
    this.composerBridge.attachImage(sessionId, exit.value.value);
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
    this.setError(sessionId, null);
    const exit = await this.runtime.run(startBrowserElementPicker(sessionId), {
      signal: this.aborts.signal,
    });
    if (!Exit.isSuccess(exit)) {
      this.setError(sessionId, errorTextFor('Unavailable'));
      return false;
    }
    if (!exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
      return false;
    }
    this.putState(exit.value.state);
    return true;
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
    this.setError(sessionId, null);
    const exit = await this.runtime.run(fetchBrowserConsoleErrors(sessionId), {
      signal: this.aborts.signal,
    });
    if (!Exit.isSuccess(exit)) {
      this.setError(sessionId, errorTextFor('Unavailable'));
      return 'failed';
    }
    if (!exit.value.ok) {
      this.setError(sessionId, errorTextFor(exit.value.reason));
      return 'failed';
    }
    if (exit.value.value.length === 0) {
      return 'empty';
    }
    this.composerBridge.attachConsoleErrors(sessionId, exit.value.value);
    return 'attached';
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
