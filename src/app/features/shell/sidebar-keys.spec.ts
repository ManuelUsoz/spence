import { Component, type ElementRef, signal, viewChild, viewChildren } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SessionId } from '../../../shared/sessions/sessions.rpc';
import { Keymap } from '../../core/keymap';
import {
  adjacentRovingItem,
  createRovingFocus,
  resolveRovingKey,
  wireEditorFocus,
  wirePendingFocus,
  type RovingItem,
} from './sidebar-keys';

describe('sidebar-keys', () => {
  it('resolves the active roving key and finds adjacent items', () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');
    const items: ReadonlyArray<RovingItem> = [
      { key: 'new:p1', projectId: 'p1' },
      { key: s1, projectId: 'p1', sessionId: s1 },
      { key: s2, projectId: 'p1', sessionId: s2, active: true },
      { key: 'new:p2', projectId: 'p2' },
    ];

    expect(resolveRovingKey(items, null)).toBe(s2);
    expect(resolveRovingKey(items, 'new:p1')).toBe('new:p1');
    expect(resolveRovingKey(items, 'missing')).toBe(s2);
    expect(adjacentRovingItem(items, 'new:p1', 1, { sessionOnly: true })).toEqual(items[1]);
    expect(adjacentRovingItem(items, s2, 1, { sessionOnly: true, projectId: 'p1' })).toBeNull();
  });

  it('wires editor auto-focus/select and pending trigger refocus', () => {
    @Component({
      template: `
        @if (editing()) {
          <input #editor value="Hello" />
        } @else {
          <button #trigger type="button" data-item-id="a">A</button>
          <button #trigger type="button" data-item-id="b">B</button>
        }
      `,
    })
    class Host {
      readonly editing = signal(false);
      readonly pendingId = signal<string | null>(null);
      readonly focused = signal<string | null>(null);
      readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');
      readonly triggers = viewChildren<ElementRef<HTMLElement>>('trigger');

      constructor() {
        wireEditorFocus(this.editor);
        wirePendingFocus({
          pendingId: this.pendingId,
          isEditing: () => this.editing(),
          elements: this.triggers,
          attribute: 'data-item-id',
          onFocused: (id) => this.focused.set(id),
        });
      }
    }

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    fixture.componentInstance.editing.set(true);
    fixture.detectChanges();
    const input = fixture.nativeElement.querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);

    fixture.componentInstance.pendingId.set('b');
    fixture.componentInstance.editing.set(false);
    fixture.detectChanges();

    const triggerB = fixture.nativeElement.querySelector('[data-item-id="b"]');
    expect(document.activeElement).toBe(triggerB);
    expect(fixture.componentInstance.focused()).toBe('b');
    expect(fixture.componentInstance.pendingId()).toBeNull();
  });

  it('handles roving keydown (arrows, Space, F2, Delete fallback focus) via createRovingFocus', () => {
    const s1 = SessionId.make('s1');
    const s2 = SessionId.make('s2');

    @Component({
      template: `
        @for (item of items(); track item.key) {
          <button
            #roving
            type="button"
            [attr.data-roving-key]="item.key"
            [attr.tabindex]="rovingFocus.tabIndex(item.key)"
            (keydown)="onKeydown($event, item)"
          >
            {{ item.key }}
          </button>
        }
      `,
    })
    class Host {
      readonly items = signal<ReadonlyArray<RovingItem>>([
        { key: s1, sessionId: s1, active: true },
        { key: s2, sessionId: s2 },
      ]);
      readonly editing = signal(false);
      readonly rovingEls = viewChildren<ElementRef<HTMLElement>>('roving');
      readonly toggled: SessionId[] = [];
      readonly extended: SessionId[] = [];
      readonly renamed: SessionId[] = [];
      readonly deleted: SessionId[] = [];

      readonly rovingFocus = createRovingFocus({
        items: this.items,
        elements: this.rovingEls,
        isEditing: () => this.editing(),
      });

      onKeydown(event: KeyboardEvent, item: RovingItem): void {
        this.rovingFocus.handleKeydown(event, {
          key: item.key,
          ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }),
          onToggleSelect: () => {
            if (item.sessionId !== undefined) this.toggled.push(item.sessionId);
          },
          onExtendSelection: (to) => this.extended.push(to),
          onStartRename: () => {
            if (item.sessionId !== undefined) this.renamed.push(item.sessionId);
          },
          onDelete: () => {
            if (item.sessionId !== undefined) {
              this.deleted.push(item.sessionId);
              this.items.update((list) => list.filter((entry) => entry.key !== item.key));
            }
          },
        });
      }
    }

    TestBed.inject(Keymap);
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const buttons = () =>
      [...fixture.nativeElement.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons().map((b) => b.getAttribute('tabindex'))).toEqual(['0', '-1']);

    const first = buttons()[0];
    const second = buttons()[1];
    if (first === undefined || second === undefined) throw new Error('missing buttons');

    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(second);
    expect(fixture.componentInstance.extended).toEqual([s2]);

    second.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    second.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F2', bubbles: true, cancelable: true }),
    );
    expect(fixture.componentInstance.toggled).toEqual([s2]);
    expect(fixture.componentInstance.renamed).toEqual([s2]);

    // Delete on s2 focuses fallback s1 once s2 is removed from items.
    second.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(fixture.componentInstance.deleted).toEqual([s2]);
    expect(document.activeElement).toBe(buttons()[0]);
  });
});
