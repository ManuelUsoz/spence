import {
  computed,
  effect,
  inject,
  signal,
  untracked,
  type ElementRef,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import type { SessionId } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';

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

/** Focuses and selects an inline rename `<input>` whenever its `viewChild` attaches. Must be called in an injection context. */
export const wireEditorFocus = (editor: Signal<ElementRef<HTMLInputElement> | undefined>): void => {
  effect(() => {
    const input = editor()?.nativeElement;
    if (input !== undefined) {
      input.focus();
      input.select();
    }
  });
};

/** Restores focus to the matching trigger element when `pendingId` is set and inline editing has closed. */
export const wirePendingFocus = <T extends string>(options: {
  readonly pendingId: WritableSignal<T | null>;
  readonly isEditing: () => boolean;
  readonly elements: Signal<ReadonlyArray<ElementRef<HTMLElement>>>;
  readonly attribute: string;
  readonly onFocused?: (id: T) => void;
}): void => {
  effect(() => {
    const id = options.pendingId();
    if (id === null || options.isEditing()) return;
    const element = options
      .elements()
      .find((ref) => ref.nativeElement.getAttribute(options.attribute) === id)?.nativeElement;
    if (element === undefined) return;
    untracked(() => {
      options.pendingId.set(null);
      options.onFocused?.(id);
    });
    element.focus({ preventScroll: true });
  });
};

export interface RovingKeydownContext {
  readonly key: string;
  readonly projectId?: string;
  readonly sessionId?: SessionId;
  readonly onToggleSelect?: () => void;
  readonly onExtendSelection?: (to: SessionId) => void;
  readonly onStartRename?: () => void;
  readonly onDelete?: () => void;
}

export interface RovingFocusController {
  readonly focusedKey: WritableSignal<string | null>;
  readonly tabIndex: (key: string) => number;
  readonly handleKeydown: (event: KeyboardEvent, context: RovingKeydownContext) => void;
}

/**
 * Manages roving `tabindex`, arrow/Shift+arrow navigation, Space/F2/Shift+F10/Delete row actions, and post-Delete
 * fallback focus for a Sidebar list. Must be called in an injection context.
 */
export const createRovingFocus = (options: {
  readonly items: Signal<ReadonlyArray<RovingItem>>;
  readonly elements: Signal<ReadonlyArray<ElementRef<HTMLElement>>>;
  readonly isEditing: () => boolean;
}): RovingFocusController => {
  const keymap = inject(Keymap);
  const focusedKey = signal<string | null>(null);
  const activeKey = computed(() => resolveRovingKey(options.items(), focusedKey()));
  let fallbackFocusKey: string | null = null;

  const focusKey = (key: string): void => {
    const element = options
      .elements()
      .find((ref) => ref.nativeElement.getAttribute('data-roving-key') === key)?.nativeElement;
    element?.focus({ preventScroll: true });
  };

  effect(() => {
    const items = options.items();
    const fallback = fallbackFocusKey;
    if (fallback === null) return;
    const current = untracked(() => focusedKey());
    if (current !== null && !items.some((item) => item.key === current)) {
      const target = items.find((item) => item.key === fallback);
      if (target !== undefined) {
        untracked(() => {
          fallbackFocusKey = null;
          focusedKey.set(target.key);
        });
        focusKey(target.key);
      }
    }
  });

  const findDeleteFallback = (
    items: ReadonlyArray<RovingItem>,
    key: string,
    projectId?: string,
  ): RovingItem | null => {
    if (projectId !== undefined) {
      const inProject =
        adjacentRovingItem(items, key, 1, { sessionOnly: true, projectId }) ??
        adjacentRovingItem(items, key, -1, { sessionOnly: true, projectId });
      if (inProject !== null) return inProject;
    }
    return (
      adjacentRovingItem(items, key, 1, { sessionOnly: true }) ??
      adjacentRovingItem(items, key, -1, { sessionOnly: true })
    );
  };

  return {
    focusedKey,
    tabIndex: (key: string) => (activeKey() === key ? 0 : -1),
    handleKeydown: (event: KeyboardEvent, context: RovingKeydownContext) => {
      if (event.isComposing || options.isEditing()) return;
      if (keymap.modalOpen() || keymap.isMenuOpen()) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const items = options.items();
        if (event.shiftKey) {
          if (context.sessionId === undefined) return;
          event.preventDefault();
          const next = adjacentRovingItem(items, context.key, delta, {
            sessionOnly: true,
            ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
          });
          if (next === null || next.sessionId === undefined) return;
          focusedKey.set(next.key);
          focusKey(next.key);
          context.onExtendSelection?.(next.sessionId);
          return;
        }
        event.preventDefault();
        const next = adjacentRovingItem(items, context.key, delta, { sessionOnly: false });
        if (next !== null) {
          focusedKey.set(next.key);
          focusKey(next.key);
        }
        return;
      }

      if (context.sessionId === undefined) return;

      if (event.key === ' ' && !event.shiftKey) {
        event.preventDefault();
        context.onToggleSelect?.();
        return;
      }
      if (event.key === 'F2' && !event.shiftKey) {
        event.preventDefault();
        context.onStartRename?.();
        return;
      }
      if (
        (event.shiftKey && event.key === 'F10') ||
        (event.key === 'ContextMenu' && !event.shiftKey)
      ) {
        event.preventDefault();
        event.stopPropagation();
        const target = event.currentTarget;
        if (target instanceof HTMLElement) openContextMenuFor(target);
        return;
      }
      if (event.key === 'Delete' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        fallbackFocusKey =
          findDeleteFallback(options.items(), context.key, context.projectId)?.key ?? null;
        context.onDelete?.();
      }
    },
  };
};
