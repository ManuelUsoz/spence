import { Component, DestroyRef, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatShortcut, KEYMAP_PLATFORM, Keymap, type KeymapPlatform } from './keymap';

const setup = (platform: KeymapPlatform = 'other'): Keymap => {
  TestBed.configureTestingModule({
    providers: [{ provide: KEYMAP_PLATFORM, useValue: platform }],
  });
  return TestBed.inject(Keymap);
};

const keydown = (init: KeyboardEventInit & { readonly altGraph?: boolean }): KeyboardEvent => {
  const { altGraph, ...eventInit } = init;
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...eventInit,
  });
  if (altGraph) {
    Object.defineProperty(event, 'getModifierState', {
      value: (key: string) => key === 'AltGraph',
    });
  }
  return event;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Keymap', () => {
  it('matches Mod per OS (Meta on macOS, Ctrl on Windows/Linux) and guards isComposing / AltGr', () => {
    const winKeymap = setup('other');
    const winCalled = vi.fn();
    winKeymap.register({ binding: { mod: true, key: 'n' }, run: winCalled });

    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', metaKey: true }));
    expect(winCalled).not.toHaveBeenCalled();

    // AltGr on Windows/Linux sets ctrlKey + altKey or AltGraph: must not trigger Mod+n.
    document.dispatchEvent(
      keydown({ key: 'n', code: 'KeyN', ctrlKey: true, altKey: true, altGraph: true }),
    );
    expect(winCalled).not.toHaveBeenCalled();

    // IME composing must be ignored.
    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', ctrlKey: true, isComposing: true }));
    expect(winCalled).not.toHaveBeenCalled();

    const winEvent = keydown({ key: 'N', code: 'KeyN', ctrlKey: true });
    document.dispatchEvent(winEvent);
    expect(winCalled).toHaveBeenCalledOnce();
    expect(winEvent.defaultPrevented).toBe(true);

    TestBed.resetTestingModule();
    const macKeymap = setup('mac');
    const macCalled = vi.fn();
    macKeymap.register({ binding: { mod: true, key: 'n' }, run: macCalled });

    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }));
    expect(macCalled).not.toHaveBeenCalled();

    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', metaKey: true }));
    expect(macCalled).toHaveBeenCalledOnce();
  });

  it('matches punctuation by event.key (Spanish layout) and digits / Tab jumps by event.code', () => {
    const keymap = setup('mac');
    const onSettings = vi.fn();
    const onTab1 = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();

    keymap.register({ binding: { mod: true, key: ',' }, run: onSettings });
    keymap.register({ binding: { mod: true, code: 'Digit1' }, run: onTab1 });
    keymap.register({ binding: { ctrl: true, code: 'Tab' }, run: onNext });
    keymap.register({ binding: { ctrl: true, shift: true, code: 'Tab' }, run: onPrev });

    // On a Spanish layout, ',' can be on a different physical code than US 'Comma'.
    document.dispatchEvent(keydown({ key: ',', code: 'Period', metaKey: true }));
    expect(onSettings).toHaveBeenCalledOnce();

    // Digit matching uses physical code Digit1 even if key differs.
    document.dispatchEvent(keydown({ key: '¡', code: 'Digit1', metaKey: true }));
    expect(onTab1).toHaveBeenCalledOnce();

    // Ctrl+Tab uses physical Ctrl even on macOS; Shift distinguishes prev from next.
    document.dispatchEvent(keydown({ key: 'Tab', code: 'Tab', ctrlKey: true }));
    expect(onNext).toHaveBeenCalledOnce();
    expect(onPrev).not.toHaveBeenCalled();

    document.dispatchEvent(keydown({ key: 'Tab', code: 'Tab', ctrlKey: true, shiftKey: true }));
    expect(onPrev).toHaveBeenCalledOnce();
  });

  it('unregisters actions manually or via DestroyRef', () => {
    @Component({ template: '' })
    class Host {
      readonly keymap = inject(Keymap);
      readonly destroyRef = inject(DestroyRef);
    }

    TestBed.configureTestingModule({
      providers: [{ provide: KEYMAP_PLATFORM, useValue: 'other' }],
    });
    const fixture = TestBed.createComponent(Host);
    const { keymap, destroyRef } = fixture.componentInstance;

    const a = vi.fn();
    const b = vi.fn();
    const stopA = keymap.register({ binding: { mod: true, key: 'k' }, run: a });
    keymap.register({ binding: { mod: true, key: 'p' }, run: b, destroyRef });

    stopA();
    document.dispatchEvent(keydown({ key: 'k', ctrlKey: true }));
    expect(a).not.toHaveBeenCalled();

    document.dispatchEvent(keydown({ key: 'p', ctrlKey: true }));
    expect(b).toHaveBeenCalledOnce();

    fixture.destroy();
    document.dispatchEvent(keydown({ key: 'p', ctrlKey: true }));
    expect(b).toHaveBeenCalledOnce();
  });

  it('runs Esc layers in strict priority: menu -> dialog -> commands -> rename -> selection -> stopTurn', () => {
    const keymap = setup('other');
    const calls: string[] = [];

    let menuOpen = true;
    let dialogOpen = true;
    let commandsOpen = true;
    let renameOpen = true;
    let selectionActive = true;
    let running = true;

    keymap.registerEscape({
      layer: 'stopTurn',
      when: () => running,
      run: () => {
        running = false;
        calls.push('stopTurn');
      },
    });
    keymap.registerEscape({
      layer: 'selection',
      when: () => selectionActive,
      run: () => {
        selectionActive = false;
        calls.push('selection');
      },
    });
    keymap.registerEscape({
      layer: 'rename',
      when: () => renameOpen,
      run: () => {
        renameOpen = false;
        calls.push('rename');
      },
    });
    keymap.registerEscape({
      layer: 'commands',
      when: () => commandsOpen,
      run: () => {
        commandsOpen = false;
        calls.push('commands');
      },
    });
    keymap.registerEscape({
      layer: 'dialog',
      when: () => dialogOpen,
      run: () => {
        dialogOpen = false;
        calls.push('dialog');
      },
    });
    keymap.registerEscape({
      layer: 'menu',
      when: () => menuOpen,
      run: () => {
        menuOpen = false;
        calls.push('menu');
      },
    });

    for (let i = 0; i < 6; i += 1) {
      const event = keydown({ key: 'Escape', code: 'Escape' });
      const stopPropagation = vi.spyOn(event, 'stopPropagation');
      document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(stopPropagation).toHaveBeenCalledOnce();
    }

    expect(calls).toEqual(['menu', 'dialog', 'commands', 'rename', 'selection', 'stopTurn']);
  });

  it('does not trigger lower Esc layers while an open CDK menu overlay is present', () => {
    const keymap = setup('other');
    const stopTurn = vi.fn();
    keymap.registerEscape({ layer: 'stopTurn', run: stopTurn });

    const container = document.createElement('div');
    container.className = 'cdk-overlay-container';
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    container.appendChild(menu);
    document.body.appendChild(container);

    const event = keydown({ key: 'Escape', code: 'Escape' });
    document.dispatchEvent(event);
    expect(stopTurn).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('suspends global shortcuts and non-dialog Esc layers while a modal is open, and restores opener focus on close', async () => {
    const keymap = setup('other');
    const onNew = vi.fn();
    const onRenameEsc = vi.fn();
    const onDialogEsc = vi.fn();

    keymap.register({ binding: { mod: true, key: 'n' }, run: onNew });
    keymap.registerEscape({ layer: 'rename', run: onRenameEsc });

    const opener = document.createElement('button');
    opener.textContent = 'Open settings';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const insideDialog = document.createElement('button');
    insideDialog.textContent = 'Close';

    const release = keymap.pushModal({
      onEscape: () => {
        onDialogEsc();
        insideDialog.remove();
        release();
      },
    });
    expect(keymap.modalOpen()).toBe(true);

    document.body.appendChild(insideDialog);
    insideDialog.focus();

    // Global shortcut must not run while modal is open.
    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }));
    expect(onNew).not.toHaveBeenCalled();

    // Escape runs the modal's handler, not rename/stopTurn, and restores focus to opener.
    document.dispatchEvent(keydown({ key: 'Escape', code: 'Escape' }));
    expect(onDialogEsc).toHaveBeenCalledOnce();
    expect(onRenameEsc).not.toHaveBeenCalled();
    expect(keymap.modalOpen()).toBe(false);

    await vi.waitFor(() => expect(document.activeElement).toBe(opener));

    // Global shortcut works again once modal closes.
    document.dispatchEvent(keydown({ key: 'n', code: 'KeyN', ctrlKey: true }));
    expect(onNew).toHaveBeenCalledOnce();
  });

  it('stores and consumes per-Tab Composer caret positions', () => {
    const keymap = setup('other');
    expect(keymap.consumeComposerCaret('s1')).toBeNull();

    keymap.saveComposerCaret('s1', { start: 4, end: 9 });
    expect(keymap.consumeComposerCaret('s1')).toEqual({ start: 4, end: 9 });
    expect(keymap.consumeComposerCaret('s1')).toBeNull();

    keymap.saveComposerCaret('s2', { start: 1, end: 1 });
    keymap.clearComposerCaret('s2');
    expect(keymap.consumeComposerCaret('s2')).toBeNull();
  });

  it('formats shortcuts per OS', () => {
    expect(formatShortcut({ mod: true, key: 'n' }, 'mac')).toBe('⌘N');
    expect(formatShortcut({ mod: true, key: 'n' }, 'other')).toBe('Ctrl+N');
    expect(formatShortcut({ mod: true, key: ',' }, 'mac')).toBe('⌘,');
    expect(formatShortcut({ mod: true, key: ',' }, 'other')).toBe('Ctrl+,');
    expect(formatShortcut({ ctrl: true, code: 'Tab' }, 'mac')).toBe('Ctrl+Tab');
    expect(formatShortcut({ ctrl: true, code: 'Tab' }, 'other')).toBe('Ctrl+Tab');
    expect(formatShortcut({ ctrl: true, shift: true, code: 'Tab' }, 'mac')).toBe('Ctrl+Shift+Tab');
    expect(formatShortcut({ mod: true, shift: true, key: 'm' }, 'mac')).toBe('⇧⌘M');
    expect(formatShortcut({ mod: true, shift: true, key: 'm' }, 'other')).toBe('Ctrl+Shift+M');
    expect(formatShortcut({ mod: true, code: 'Digit1' }, 'mac')).toBe('⌘1');
    expect(formatShortcut({ mod: true, code: 'Digit1' }, 'other')).toBe('Ctrl+1');
  });
});
