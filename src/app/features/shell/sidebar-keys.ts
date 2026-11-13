import type { SessionId } from '../../../shared/sessions/sessions.rpc';

/** One focusable item in a Sidebar list's roving-focus sequence. */
export interface RovingItem {
  readonly key: string;
  readonly projectId?: string;
  readonly sessionId?: SessionId;
  readonly active?: boolean;
}

/**
 * Picks which roving item holds `tabindex="0"`: the currently focused key if still present, else the active Session
 * or draft row, else the first Session row (falling back to the first item).
 */
export const resolveRovingKey = (
  items: ReadonlyArray<RovingItem>,
  focusedKey: string | null,
): string | null => {
  if (focusedKey !== null && items.some((item) => item.key === focusedKey)) return focusedKey;
  return (
    items.find((item) => item.active === true)?.key ??
    items.find((item) => item.sessionId !== undefined)?.key ??
    items[0]?.key ??
    null
  );
};

/** Returns the previous or next item from `currentKey` (clamped at edges), optionally restricted to Session rows or one Project. */
export const adjacentRovingItem = (
  items: ReadonlyArray<RovingItem>,
  currentKey: string,
  delta: 1 | -1,
  options: { readonly sessionOnly: boolean; readonly projectId?: string },
): RovingItem | null => {
  const start = items.findIndex((item) => item.key === currentKey);
  if (start === -1) return null;
  for (let i = start + delta; i >= 0 && i < items.length; i += delta) {
    const candidate = items[i];
    if (candidate === undefined) continue;
    if (options.projectId !== undefined && candidate.projectId !== options.projectId) return null;
    if (!options.sessionOnly || candidate.sessionId !== undefined) return candidate;
  }
  return null;
};

/** Dispatches a synthetic `contextmenu` event centered near the left edge of `element` to open its CDK context menu. */
export const openContextMenuFor = (element: HTMLElement): void => {
  const rect = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + Math.min(rect.width / 2, 24),
      clientY: rect.top + rect.height / 2,
    }),
  );
};
