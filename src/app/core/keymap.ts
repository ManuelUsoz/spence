import { DestroyRef, DOCUMENT, inject, Injectable, InjectionToken, signal } from '@angular/core';

export type KeymapPlatform = 'mac' | 'other';

const detectPlatform = (): KeymapPlatform => {
  if (typeof navigator === 'undefined') return 'other';
  return /mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent) ? 'mac' : 'other';
};

/** Platform token used by `Keymap` to map `Mod` (`Meta` on macOS, `Ctrl` elsewhere); overridable in tests. */
export const KEYMAP_PLATFORM = new InjectionToken<KeymapPlatform>('KEYMAP_PLATFORM', {
  providedIn: 'root',
  factory: detectPlatform,
});

/** Declarative shortcut matcher: `key` matches logical characters (layout-aware), `code` matches physical keys. */
export interface KeyBinding {
  /** Platform primary modifier (`Meta` on macOS, `Ctrl` on Windows/Linux). */
  readonly mod?: boolean;
  /** Physical `Ctrl` key on all platforms (e.g. `Ctrl+Tab`, even on macOS). */
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Logical `event.key` (case-insensitive for ASCII letters `a–z`, exact for punctuation like `,` or `/`). */
  readonly key?: string;
  /** Physical `event.code` (for digits `Digit1`–`Digit9` and `Tab` jumps). */
  readonly code?: string;
}

/** Esc dismissal priority from highest (`menu`) to lowest (`stopTurn`), matching spec §9. */
export const ESC_LAYERS = [
  'menu',
  'dialog',
  'commands',
  'rename',
  'selection',
  'stopTurn',
] as const;
export type EscLayer = (typeof ESC_LAYERS)[number];

export interface ShortcutOptions {
  readonly binding: KeyBinding;
  /** Return `false` when the shortcut is currently inactive; defaults to active. */
  readonly when?: () => boolean;
  /** Runs when matched. Returning `false` declines the shortcut so propagation continues. */
  readonly run: (event: KeyboardEvent) => boolean | void;
  /** Allow this shortcut while a modal dialog/sheet/lightbox is open (default `false`). */
  readonly allowInModal?: boolean;
  /** Optional `DestroyRef` to unregister automatically when the registering scope is destroyed. */
  readonly destroyRef?: DestroyRef;
}

export interface EscapeOptions {
  readonly layer: EscLayer;
  /** Return `false` when this layer currently has nothing to dismiss; defaults to active. */
  readonly when?: () => boolean;
  readonly run: () => void;
  readonly destroyRef?: DestroyRef;
}

export interface ModalOptions {
  /** Optional Esc handler for the modal; registered on the `dialog` Esc layer while the modal is open. */
  readonly onEscape?: () => void;
  /** Explicit opener element to restore focus to on close; defaults to `document.activeElement`. */
  readonly opener?: HTMLElement | null;
  /** Whether to restore focus to the opener when the modal closes (default `true`). */
  readonly restoreFocus?: boolean;
}

export interface ComposerCaret {
  readonly start: number;
  readonly end: number;
}

export interface FallbackOptions {
  /** Runs when no registered shortcut matched; return `true` to prevent default and stop propagation. */
  readonly run: (event: KeyboardEvent) => boolean;
  readonly destroyRef?: DestroyRef;
}

interface ShortcutEntry {
  readonly binding: KeyBinding;
  readonly when: (() => boolean) | undefined;
  readonly run: (event: KeyboardEvent) => boolean | void;
  readonly allowInModal: boolean;
}

interface EscapeEntry {
  readonly layer: EscLayer;
  readonly when: (() => boolean) | undefined;
  readonly run: () => void;
}

const ASCII_LETTER = /^[a-z]$/i;
const DIGIT_CODE = /^Digit(\d)$/;

/** Returns `true` when `event` matches `binding` on `platform`, guarding against IME composition and AltGr. */
export const matchesBinding = (
  event: KeyboardEvent,
  binding: KeyBinding,
  platform: KeymapPlatform,
): boolean => {
  if (event.isComposing) return false;
  if (binding.key === undefined && binding.code === undefined) return false;
  if (platform !== 'mac' && event.getModifierState?.('AltGraph') === true) return false;

  const expectedMeta = platform === 'mac' ? (binding.mod ?? false) : false;
  const expectedCtrl =
    platform === 'mac'
      ? (binding.ctrl ?? false)
      : (binding.mod ?? false) || (binding.ctrl ?? false);
  const expectedShift = binding.shift ?? false;
  const expectedAlt = binding.alt ?? false;

  if (
    event.metaKey !== expectedMeta ||
    event.ctrlKey !== expectedCtrl ||
    event.shiftKey !== expectedShift ||
    event.altKey !== expectedAlt
  ) {
    return false;
  }

  if (binding.code !== undefined && event.code !== binding.code) return false;
  if (binding.key !== undefined) {
    if (ASCII_LETTER.test(binding.key)) {
      if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;
    } else if (event.key !== binding.key) {
      return false;
    }
  }
  return true;
};

const keyLabel = (binding: KeyBinding): string => {
  if (binding.code !== undefined) {
    const digit = DIGIT_CODE.exec(binding.code);
    if (digit !== null) return digit[1] ?? binding.code;
    if (binding.code === 'Tab') return 'Tab';
  }
  const key = binding.key ?? binding.code ?? '';
  if (ASCII_LETTER.test(key)) return key.toUpperCase();
  if (key === 'Escape') return 'Esc';
  if (key === 'Delete') return 'Del';
  if (key === ' ') return 'Space';
  return key;
};

/** Formats `binding` into an OS-appropriate human hint (e.g. `⌘N` vs `Ctrl+N`, `Ctrl+Tab`, `⌘,` vs `Ctrl+,`). */
export const formatShortcut = (binding: KeyBinding, platform: KeymapPlatform): string => {
  const label = keyLabel(binding);
  if (platform === 'mac') {
    if (binding.ctrl === true && binding.mod !== true) {
      const parts = ['Ctrl'];
      if (binding.alt === true) parts.push('Alt');
      if (binding.shift === true) parts.push('Shift');
      parts.push(label);
      return parts.join('+');
    }
    const prefix = `${binding.ctrl === true ? '⌃' : ''}${binding.alt === true ? '⌥' : ''}${binding.shift === true ? '⇧' : ''}${binding.mod === true ? '⌘' : ''}`;
    return `${prefix}${label}`;
  }

  const parts: string[] = [];
  if (binding.mod === true || binding.ctrl === true) parts.push('Ctrl');
  if (binding.alt === true) parts.push('Alt');
  if (binding.shift === true) parts.push('Shift');
  parts.push(label);
  return parts.join('+');
};

/**
 * Single root keyboard service for the renderer: the only `document` keydown listener. Handles OS-aware shortcuts,
 * strict `Esc` layering, modal locking with opener focus restoration, and per-Tab Composer caret persistence.
 */
@Injectable({ providedIn: 'root' })
export class Keymap {
  private readonly document = inject(DOCUMENT);
  private readonly platform = inject(KEYMAP_PLATFORM);
  private readonly shortcuts: ShortcutEntry[] = [];
  private readonly fallbacks: FallbackOptions[] = [];
  private readonly escapeLayers = new Map<EscLayer, EscapeEntry[]>(
    ESC_LAYERS.map((layer) => [layer, []]),
  );
  private readonly modals: symbol[] = [];
  private readonly carets = new Map<string, ComposerCaret>();
  private readonly _modalOpen = signal(false);

  /** Whether any modal dialog, sheet, alert-dialog, or lightbox is currently open. */
  readonly modalOpen = this._modalOpen.asReadonly();

  constructor() {
    const onKeydown = (event: KeyboardEvent): void => this.handleKeydown(event);
    this.document.addEventListener('keydown', onKeydown, { capture: true });
    inject(DestroyRef).onDestroy(() => {
      this.document.removeEventListener('keydown', onKeydown, { capture: true });
    });
  }

  /** Formats `binding` for the active OS (`⌘N` on macOS, `Ctrl+N` on Windows/Linux). */
  format(binding: KeyBinding): string {
    return formatShortcut(binding, this.platform);
  }

  /** Registers a shortcut action and returns an idempotent unregister callback. */
  register(options: ShortcutOptions): () => void {
    const entry: ShortcutEntry = {
      binding: options.binding,
      when: options.when,
      run: options.run,
      allowInModal: options.allowInModal ?? false,
    };
    this.shortcuts.push(entry);
    return this.withDestroyRef(() => {
      const index = this.shortcuts.indexOf(entry);
      if (index !== -1) this.shortcuts.splice(index, 1);
    }, options.destroyRef);
  }

  /** Registers a low-priority keydown fallback (such as Session type-to-focus) that runs only if no shortcut matched. */
  registerFallback(options: FallbackOptions): () => void {
    this.fallbacks.push(options);
    return this.withDestroyRef(() => {
      const index = this.fallbacks.indexOf(options);
      if (index !== -1) this.fallbacks.splice(index, 1);
    }, options.destroyRef);
  }

  /** Registers an `Esc` handler at `options.layer` and returns an idempotent unregister callback. */
  registerEscape(options: EscapeOptions): () => void {
    const entry: EscapeEntry = {
      layer: options.layer,
      when: options.when,
      run: options.run,
    };
    const bucket = this.escapeLayers.get(options.layer);
    bucket?.push(entry);
    return this.withDestroyRef(() => {
      const list = this.escapeLayers.get(options.layer);
      if (list === undefined) return;
      const index = list.indexOf(entry);
      if (index !== -1) list.splice(index, 1);
    }, options.destroyRef);
  }

  /**
   * Suspends global shortcuts and non-dialog key layers while a modal is open, captures opener focus, and restores it
   * on release. Returns an idempotent release function.
   */
  pushModal(options?: ModalOptions): () => void {
    const token = Symbol('modal');
    const active = this.document.activeElement;
    const opener =
      options?.opener !== undefined
        ? options.opener
        : active instanceof HTMLElement
          ? active
          : null;
    this.modals.push(token);
    this._modalOpen.set(true);

    const stopEscape =
      options?.onEscape === undefined
        ? undefined
        : this.registerEscape({ layer: 'dialog', run: options.onEscape });

    let released = false;
    return () => {
      if (released) return;
      released = true;
      stopEscape?.();
      const index = this.modals.indexOf(token);
      if (index !== -1) this.modals.splice(index, 1);
      this._modalOpen.set(this.modals.length > 0);

      if (options?.restoreFocus !== false && opener !== null) {
        queueMicrotask(() => {
          if (!opener.isConnected) return;
          const current = this.document.activeElement;
          if (current === null || current === this.document.body || !current.isConnected) {
            opener.focus({ preventScroll: true });
          }
        });
      }
    };
  }

  /** Returns `true` if a menu Esc layer or an open CDK menu overlay is currently active. */
  isMenuOpen(): boolean {
    const registered = this.escapeLayers.get('menu') ?? [];
    if (registered.some((entry) => entry.when?.() ?? true)) return true;
    return this.hasOpenDomMenu();
  }

  saveComposerCaret(key: string, caret: ComposerCaret): void {
    this.carets.set(key, caret);
  }

  consumeComposerCaret(key: string): ComposerCaret | null {
    const caret = this.carets.get(key) ?? null;
    if (caret !== null) this.carets.delete(key);
    return caret;
  }

  clearComposerCaret(key: string): void {
    this.carets.delete(key);
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (
      event.key === 'Escape' &&
      !event.isComposing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      this.handleEscape(event);
      return;
    }

    const inModal = this._modalOpen();
    for (let i = this.shortcuts.length - 1; i >= 0; i -= 1) {
      const entry = this.shortcuts[i];
      if (entry === undefined) continue;
      if (inModal && !entry.allowInModal) continue;
      if (!matchesBinding(event, entry.binding, this.platform)) continue;
      if (entry.when !== undefined && !entry.when()) continue;
      if (entry.run(event) === false) continue;
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (inModal || event.defaultPrevented || this.isMenuOpen()) return;
    for (let i = this.fallbacks.length - 1; i >= 0; i -= 1) {
      const entry = this.fallbacks[i];
      if (entry === undefined) continue;
      if (entry.run(event)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
    }
  }

  private handleEscape(event: KeyboardEvent): void {
    for (const layer of ESC_LAYERS) {
      if (layer !== 'menu' && layer !== 'dialog' && this._modalOpen()) return;
      const entries = this.escapeLayers.get(layer) ?? [];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry === undefined) continue;
        if (entry.when !== undefined && !entry.when()) continue;
        event.preventDefault();
        event.stopPropagation();
        entry.run();
        return;
      }
      if (layer === 'menu' && this.hasOpenDomMenu()) return;
      if (layer === 'dialog' && this._modalOpen()) return;
    }
  }

  private hasOpenDomMenu(): boolean {
    return this.document.querySelector('.cdk-overlay-container [role="menu"]') !== null;
  }

  private withDestroyRef(cleanup: () => void, destroyRef?: DestroyRef): () => void {
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      cleanup();
    };
    destroyRef?.onDestroy(stop);
    return stop;
  }
}
