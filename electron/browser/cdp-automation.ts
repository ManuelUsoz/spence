import { Effect } from 'effect';
import { BrowserError, type PageId } from '../../src/shared/browser/browser.rpc';
import type {
  BrowserActionResult,
  BrowserElementTarget,
  BrowserEvalResult,
  BrowserPageSnapshot,
  BrowserWaitCondition,
} from './browser-host';
import { buildAccessibilitySnapshot, type CdpAxNode } from './snapshot';

export interface CdpDebuggerLike {
  readonly isAttached: () => boolean;
  readonly attach: (protocolVersion: string) => void;
  readonly sendCommand: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

export interface CdpPageHandle {
  readonly pageId: PageId;
  readonly debugger: CdpDebuggerLike;
  readonly getUrl: () => string;
  readonly getTitle: () => string;
  readonly isDestroyed: () => boolean;
}

interface CdpRemoteObject {
  readonly objectId?: string;
  readonly type?: string;
  readonly subtype?: string;
  readonly value?: unknown;
  readonly description?: string;
}

interface CdpEvaluateResponse {
  readonly result?: CdpRemoteObject;
  readonly exceptionDetails?: {
    readonly text?: string;
    readonly exception?: { readonly description?: string };
  };
}

interface CdpResolveNodeResponse {
  readonly object?: CdpRemoteObject;
}

interface CdpGetFullAxTreeResponse {
  readonly nodes?: ReadonlyArray<CdpAxNode>;
}

interface CdpScreenshotResponse {
  readonly data?: string;
}

interface KeyDescriptor {
  readonly key: string;
  readonly code: string;
  readonly windowsVirtualKeyCode: number;
  readonly text?: string;
}

const SPECIAL_KEYS: Readonly<Record<string, KeyDescriptor>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

const MODIFIER_BITS: Readonly<Record<string, number>> = {
  Alt: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Cmd: 4,
  Shift: 8,
};

const describeKey = (keyName: string): KeyDescriptor => {
  const known = SPECIAL_KEYS[keyName];
  if (known !== undefined) return known;
  if (keyName.length === 1) {
    const upper = keyName.toUpperCase();
    return {
      key: keyName,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: keyName,
    };
  }
  return { key: keyName, code: keyName, windowsVirtualKeyCode: 0 };
};

const parseKeyChord = (
  chord: string,
): { readonly modifiers: number; readonly key: KeyDescriptor } => {
  const parts = chord.split('+').filter((part) => part.length > 0);
  if (parts.length <= 1) {
    return { modifiers: 0, key: describeKey(chord) };
  }
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    modifiers |= MODIFIER_BITS[part] ?? 0;
  }
  const last = parts.at(-1) ?? chord;
  return { modifiers, key: describeKey(last) };
};

const ensureAttached = (handle: CdpPageHandle): Effect.Effect<CdpDebuggerLike, BrowserError> =>
  Effect.try({
    try: () => {
      if (!handle.debugger.isAttached()) {
        handle.debugger.attach('1.3');
      }
      return handle.debugger;
    },
    catch: (cause) =>
      new BrowserError({
        reason: 'Unavailable',
        detail: `Could not attach debugger: ${String(cause)}`,
      }),
  });

const sendCdp = <T>(
  dbg: CdpDebuggerLike,
  method: string,
  params?: Record<string, unknown>,
  reason: BrowserError['reason'] = 'Unavailable',
): Effect.Effect<T, BrowserError> =>
  Effect.tryPromise({
    try: () => dbg.sendCommand(method, params) as Promise<T>,
    catch: (cause) =>
      new BrowserError({
        reason,
        detail: `CDP ${method} failed: ${String(cause)}`,
      }),
  });

const releaseObject = (dbg: CdpDebuggerLike, objectId: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => dbg.sendCommand('Runtime.releaseObject', { objectId }),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const evaluateRaw = (
  dbg: CdpDebuggerLike,
  expression: string,
  returnByValue: boolean,
): Effect.Effect<CdpEvaluateResponse, BrowserError> =>
  sendCdp<CdpEvaluateResponse>(dbg, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue,
  });

const resolveTargetObjectId = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  dbg: CdpDebuggerLike,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
): Effect.fn.Return<string, BrowserError> {
  if (target.ref !== undefined) {
    const backendNodeId = pageRefs.get(handle.pageId)?.get(target.ref);
    if (backendNodeId === undefined) {
      return yield* new BrowserError({
        reason: 'NotFound',
        detail: `Unknown or stale element ref "${target.ref}". Run snapshot first.`,
      });
    }
    const resolved = yield* sendCdp<CdpResolveNodeResponse>(dbg, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) {
      return yield* new BrowserError({
        reason: 'NotFound',
        detail: `Element for ref "${target.ref}" is no longer attached to the DOM.`,
      });
    }
    return objectId;
  }

  if (target.selector !== undefined) {
    const res = yield* evaluateRaw(
      dbg,
      `document.querySelector(${JSON.stringify(target.selector)})`,
      false,
    );
    const objectId = res.result?.objectId;
    if (res.result?.subtype === 'null' || objectId === undefined) {
      return yield* new BrowserError({
        reason: 'NotFound',
        detail: `No element matched selector "${target.selector}".`,
      });
    }
    return objectId;
  }

  if (target.text !== undefined) {
    const script = `(() => {
      const needle = ${JSON.stringify(target.text)}.trim().toLowerCase();
      if (!needle) return null;
      const candidates = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],label,h1,h2,h3,p,span,div'));
      const labelOf = (el) => {
        const text = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.value || el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        return text;
      };
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const exact = candidates.find((el) => isVisible(el) && labelOf(el) === needle);
      if (exact) return exact;
      return candidates.find((el) => isVisible(el) && labelOf(el).includes(needle)) || null;
    })()`;
    const res = yield* evaluateRaw(dbg, script, false);
    const objectId = res.result?.objectId;
    if (res.result?.subtype === 'null' || objectId === undefined) {
      return yield* new BrowserError({
        reason: 'NotFound',
        detail: `No visible element matched text "${target.text}".`,
      });
    }
    return objectId;
  }

  return yield* new BrowserError({
    reason: 'NotFound',
    detail: 'Provide ref, selector, or text to target an element.',
  });
});

const withResolvedElement = Effect.fnUntraced(function* <A>(
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
  fn: (dbg: CdpDebuggerLike, objectId: string) => Effect.Effect<A, BrowserError>,
): Effect.fn.Return<A, BrowserError> {
  const dbg = yield* ensureAttached(handle);
  return yield* Effect.acquireUseRelease(
    resolveTargetObjectId(handle, dbg, pageRefs, target),
    (objectId) => fn(dbg, objectId),
    (objectId) => releaseObject(dbg, objectId),
  );
});

const centerOfElement = Effect.fnUntraced(function* (dbg: CdpDebuggerLike, objectId: string) {
  const res = yield* sendCdp<CdpEvaluateResponse>(dbg, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const rect = this.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: rect.width, height: rect.height };
    }`,
    returnByValue: true,
  });
  const val = res.result?.value;
  if (
    typeof val === 'object' &&
    val !== null &&
    'x' in val &&
    'y' in val &&
    'width' in val &&
    'height' in val &&
    typeof val.x === 'number' &&
    typeof val.y === 'number' &&
    typeof val.width === 'number' &&
    typeof val.height === 'number'
  ) {
    return { x: val.x, y: val.y, width: val.width, height: val.height };
  }
  return yield* new BrowserError({
    reason: 'Unavailable',
    detail: 'Could not compute element viewport geometry.',
  });
});

const focusElement = (dbg: CdpDebuggerLike, objectId: string): Effect.Effect<void, BrowserError> =>
  sendCdp(dbg, 'Runtime.callFunctionOn', {
    objectId,
    functionDeclaration: `function() {
      this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      if (typeof this.focus === 'function') this.focus();
    }`,
    returnByValue: true,
  }).pipe(Effect.asVoid);

const dispatchKeyPress = Effect.fnUntraced(function* (dbg: CdpDebuggerLike, chord: string) {
  const { modifiers, key } = parseKeyChord(chord);
  yield* sendCdp(dbg, 'Input.dispatchKeyEvent', {
    type: key.text === undefined ? 'rawKeyDown' : 'keyDown',
    modifiers,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
    nativeVirtualKeyCode: key.windowsVirtualKeyCode,
    ...(key.text === undefined ? {} : { text: key.text, unmodifiedText: key.text }),
  });
  yield* sendCdp(dbg, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    modifiers,
    key: key.key,
    code: key.code,
    windowsVirtualKeyCode: key.windowsVirtualKeyCode,
    nativeVirtualKeyCode: key.windowsVirtualKeyCode,
  });
});

/** Captures a PNG screenshot via CDP when `capturePage()` returns empty (e.g. detached views). */
export const captureScreenshotViaCdp = Effect.fnUntraced(function* (handle: CdpPageHandle) {
  const dbg = yield* ensureAttached(handle);
  const res = yield* sendCdp<CdpScreenshotResponse>(
    dbg,
    'Page.captureScreenshot',
    { format: 'png' },
    'Unavailable',
  );
  if (typeof res.data !== 'string' || res.data.length === 0) {
    return yield* new BrowserError({
      reason: 'Unavailable',
      detail: 'Captured CDP screenshot was empty.',
    });
  }
  return res.data;
});

/** Captures an accessibility snapshot and updates `pageRefs` (`ref -> backendDOMNodeId`). */
export const runCdpSnapshot = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
): Effect.fn.Return<BrowserPageSnapshot, BrowserError> {
  const dbg = yield* ensureAttached(handle);
  yield* sendCdp(dbg, 'DOM.enable');
  yield* sendCdp(dbg, 'Accessibility.enable');
  const ax = yield* sendCdp<CdpGetFullAxTreeResponse>(dbg, 'Accessibility.getFullAXTree');
  const built = buildAccessibilitySnapshot(ax.nodes ?? []);
  pageRefs.set(handle.pageId, built.refs);
  const url = handle.getUrl();
  return {
    pageId: handle.pageId,
    url: url === '' ? 'about:blank' : url,
    title: handle.getTitle(),
    snapshot: built.outline,
    refCount: built.refs.size,
  };
});

/** Clicks an element resolved by `ref`, CSS `selector`, or visible `text`. */
export const runCdpClick = (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
  options?: { readonly button?: 'left' | 'right' | 'middle'; readonly clickCount?: number },
): Effect.Effect<BrowserActionResult, BrowserError> =>
  withResolvedElement(
    handle,
    pageRefs,
    target,
    Effect.fnUntraced(function* (dbg, objectId) {
      const box = yield* centerOfElement(dbg, objectId);
      if (box.width <= 0 || box.height <= 0) {
        yield* sendCdp(dbg, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function() { if (typeof this.click === "function") this.click(); }',
          returnByValue: true,
        });
        return { ok: true as const, detail: 'Clicked via DOM fallback.' };
      }
      const button = options?.button ?? 'left';
      const clickCount = options?.clickCount ?? 1;
      yield* sendCdp(dbg, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
      });
      yield* sendCdp(dbg, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x,
        y: box.y,
        button,
        clickCount,
      });
      yield* sendCdp(dbg, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x,
        y: box.y,
        button,
        clickCount,
      });
      return { ok: true as const };
    }),
  );

/** Hovers the pointer over an element resolved by `ref`, CSS `selector`, or visible `text`. */
export const runCdpHover = (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
): Effect.Effect<BrowserActionResult, BrowserError> =>
  withResolvedElement(
    handle,
    pageRefs,
    target,
    Effect.fnUntraced(function* (dbg, objectId) {
      const box = yield* centerOfElement(dbg, objectId);
      yield* sendCdp(dbg, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x,
        y: box.y,
      });
      return { ok: true as const };
    }),
  );

/** Sets the value of an input/textarea/contentEditable element and dispatches input/change events. */
export const runCdpFill = (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
  value: string,
): Effect.Effect<BrowserActionResult, BrowserError> =>
  withResolvedElement(
    handle,
    pageRefs,
    target,
    Effect.fnUntraced(function* (dbg, objectId) {
      const res = yield* sendCdp<CdpEvaluateResponse>(dbg, 'Runtime.callFunctionOn', {
        objectId,
        arguments: [{ value }],
        functionDeclaration: `function(nextValue) {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          if (typeof this.focus === 'function') this.focus();
          if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
            const proto = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(this, nextValue);
            else this.value = nextValue;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
          if (this.isContentEditable) {
            this.textContent = nextValue;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
          }
          return false;
        }`,
        returnByValue: true,
      });
      if (res.result?.value !== true) {
        return yield* new BrowserError({
          reason: 'Unavailable',
          detail: 'Target element is not an editable input, textarea, or contentEditable node.',
        });
      }
      return { ok: true as const };
    }),
  );

/** Types text into the focused element (or `target` when supplied). */
export const runCdpType = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  text: string,
  target?: BrowserElementTarget,
): Effect.fn.Return<BrowserActionResult, BrowserError> {
  if (target !== undefined) {
    yield* withResolvedElement(handle, pageRefs, target, focusElement);
  }
  const dbg = yield* ensureAttached(handle);
  if (text.length > 0) {
    yield* sendCdp(dbg, 'Input.insertText', { text });
  }
  return { ok: true as const };
});

/** Dispatches a key press (optionally focusing `target` first). */
export const runCdpPress = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  key: string,
  target?: BrowserElementTarget,
): Effect.fn.Return<BrowserActionResult, BrowserError> {
  if (target !== undefined) {
    yield* withResolvedElement(handle, pageRefs, target, focusElement);
  }
  const dbg = yield* ensureAttached(handle);
  yield* dispatchKeyPress(dbg, key);
  return { ok: true as const };
});

/** Selects option values or labels on a `<select>` element. */
export const runCdpSelect = (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  target: BrowserElementTarget,
  values: ReadonlyArray<string>,
): Effect.Effect<BrowserActionResult, BrowserError> =>
  withResolvedElement(
    handle,
    pageRefs,
    target,
    Effect.fnUntraced(function* (dbg, objectId) {
      const res = yield* sendCdp<CdpEvaluateResponse>(dbg, 'Runtime.callFunctionOn', {
        objectId,
        arguments: [{ value: [...values] }],
        functionDeclaration: `function(wanted) {
          if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: 'Target is not a <select> element.' };
          const matches = [];
          for (const option of Array.from(this.options)) {
            const hit = wanted.includes(option.value) || wanted.includes(option.text.trim());
            option.selected = hit;
            if (hit) matches.push(option.value);
          }
          if (matches.length === 0 && wanted.length > 0) {
            return { ok: false, reason: 'No matching option found for values: ' + wanted.join(', ') };
          }
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, selected: matches };
        }`,
        returnByValue: true,
      });
      const out = res.result?.value;
      if (typeof out === 'object' && out !== null && 'ok' in out && out.ok === true) {
        return { ok: true as const };
      }
      const reason =
        typeof out === 'object' && out !== null && 'reason' in out && typeof out.reason === 'string'
          ? out.reason
          : 'Select failed.';
      return yield* new BrowserError({ reason: 'NotFound', detail: reason });
    }),
  );

/** Scrolls either a targeted element or the page window. */
export const runCdpScroll = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  pageRefs: Map<PageId, Map<string, number>>,
  options: {
    readonly direction?: 'up' | 'down' | 'left' | 'right';
    readonly amount?: number;
    readonly target?: BrowserElementTarget;
  },
): Effect.fn.Return<BrowserActionResult, BrowserError> {
  const direction = options.direction ?? 'down';
  const amount = options.amount ?? 400;
  const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
  const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
  if (options.target !== undefined) {
    yield* withResolvedElement(handle, pageRefs, options.target, (dbg, objectId) =>
      sendCdp(dbg, 'Runtime.callFunctionOn', {
        objectId,
        arguments: [{ value: dx }, { value: dy }],
        functionDeclaration: 'function(x, y) { this.scrollBy(x, y); }',
        returnByValue: true,
      }).pipe(Effect.asVoid),
    );
    return { ok: true as const };
  }
  const dbg = yield* ensureAttached(handle);
  yield* evaluateRaw(dbg, `window.scrollBy(${dx}, ${dy})`, true);
  return { ok: true as const };
});

/** Polls until `url`, `selector`, and/or `text` matches or `timeoutMs` elapses. */
export const runCdpWaitFor = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  condition: BrowserWaitCondition,
): Effect.fn.Return<BrowserActionResult, BrowserError> {
  const timeoutMs = Math.min(30_000, Math.max(100, condition.timeoutMs ?? 5_000));
  const deadline = Date.now() + timeoutMs;
  const dbg = yield* ensureAttached(handle);

  while (true) {
    if (handle.isDestroyed()) {
      return yield* new BrowserError({
        reason: 'PageNotFound',
        detail: `Page ${handle.pageId} closed.`,
      });
    }
    let ok = true;
    if (condition.url !== undefined && !handle.getUrl().includes(condition.url)) {
      ok = false;
    }
    if (ok && (condition.selector !== undefined || condition.text !== undefined)) {
      const res = yield* evaluateRaw(
        dbg,
        `(() => {
          const selOk = ${condition.selector === undefined ? 'true' : `document.querySelector(${JSON.stringify(condition.selector)}) !== null`};
          const textOk = ${condition.text === undefined ? 'true' : `(document.body?.innerText || '').includes(${JSON.stringify(condition.text)})`};
          return selOk && textOk;
        })()`,
        true,
      );
      ok = res.result?.value === true;
    }
    if (ok) return { ok: true as const };
    if (Date.now() >= deadline) {
      return yield* new BrowserError({
        reason: 'Unavailable',
        detail: `Timed out after ${timeoutMs}ms waiting for condition.`,
      });
    }
    yield* Effect.sleep('100 millis');
  }
});

/** Evaluates a JavaScript expression in the Page's main world and returns its serialized value. */
export const runCdpEvaluate = Effect.fnUntraced(function* (
  handle: CdpPageHandle,
  expression: string,
): Effect.fn.Return<BrowserEvalResult, BrowserError> {
  const dbg = yield* ensureAttached(handle);
  const res = yield* evaluateRaw(dbg, expression, true);
  if (res.exceptionDetails !== undefined) {
    const detail =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'Evaluation threw an exception.';
    return yield* new BrowserError({ reason: 'Unavailable', detail });
  }
  return {
    value: res.result?.value ?? null,
    type: res.result?.type ?? 'undefined',
  };
});
