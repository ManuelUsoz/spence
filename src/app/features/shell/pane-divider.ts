import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { SplitDirection } from '../../../shared/tabs/tabs.rpc';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO } from '../../../shared/tabs/workspace-layout';

export const MIN_PANE_WIDTH_PX = 220;
export const MIN_PANE_HEIGHT_PX = 140;

const KEYBOARD_STEP = 0.05;

const roundRatio = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * Interactive resize divider between two sibling Panes in a binary `SplitPaneNode`.
 * A horizontal split (left | right) renders a vertical bar (`aria-orientation="vertical"`);
 * a vertical split (top / bottom) renders a horizontal bar (`aria-orientation="horizontal"`).
 */
@Component({
  selector: 'app-pane-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'group relative flex shrink-0 items-center justify-center select-none outline-none focus-visible:ring-1 focus-visible:ring-ring',
    '[class.w-1.5]': "direction() === 'horizontal'",
    '[class.cursor-col-resize]': "direction() === 'horizontal'",
    '[class.h-1.5]': "direction() === 'vertical'",
    '[class.cursor-row-resize]': "direction() === 'vertical'",
    'data-testid': 'pane-resize-divider',
    '[attr.data-direction]': 'direction()',
    '[attr.data-dragging]': "dragging() ? 'true' : null",
    role: 'separator',
    tabindex: '0',
    '[attr.aria-orientation]': "direction() === 'horizontal' ? 'vertical' : 'horizontal'",
    '[attr.aria-valuemin]': 'minPercent',
    '[attr.aria-valuemax]': 'maxPercent',
    '[attr.aria-valuenow]': 'percentNow()',
    '[attr.aria-label]': 'ariaLabel',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerCancel($event)',
    '(keydown)': 'onKeyDown($event)',
  },
  template: `
    <span
      aria-hidden="true"
      class="bg-border/60 group-hover:bg-ring group-focus-visible:bg-ring pointer-events-none transition-colors"
      [class.bg-ring]="dragging()"
      [class.h-full]="direction() === 'horizontal'"
      [class.w-px]="direction() === 'horizontal'"
      [class.w-full]="direction() === 'vertical'"
      [class.h-px]="direction() === 'vertical'"
    ></span>
  `,
})
export class PaneDivider {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly direction = input.required<SplitDirection>();
  readonly ratio = input.required<number>();
  readonly container = input<HTMLElement | null>(null);

  readonly ratioPreview = output<number | null>();
  readonly ratioCommit = output<number>();

  protected readonly dragging = signal(false);
  protected readonly minPercent = Math.round(MIN_SPLIT_RATIO * 100);
  protected readonly maxPercent = Math.round(MAX_SPLIT_RATIO * 100);
  protected readonly ariaLabel = $localize`Resize Panes`;
  protected readonly percentNow = computed(() => Math.round(this.ratio() * 100));

  private activePointerId: number | null = null;
  private draggedRatio: number | null = null;
  private lastHandledEvent: Event | null = null;

  private readonly handleWindowMove = (event: PointerEvent): void => this.onPointerMove(event);
  private readonly handleWindowUp = (event: PointerEvent): void => this.onPointerUp(event);
  private readonly handleWindowCancel = (event: PointerEvent): void => this.onPointerCancel(event);

  constructor() {
    this.destroyRef.onDestroy(() => this.detachWindowListeners());
  }

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.dragging.set(true);
    this.draggedRatio = null;
    this.activePointerId = typeof event.pointerId === 'number' ? event.pointerId : null;
    const el = this.host.nativeElement;
    if (this.activePointerId !== null && typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(this.activePointerId);
      } catch {
        // Synthetic PointerEvents in unit tests have no active browser pointer to capture.
      }
    }
    this.attachWindowListeners();
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.dragging() || this.lastHandledEvent === event) return;
    this.lastHandledEvent = event;
    const next = this.ratioFromPointer(event);
    if (next === null) return;
    this.draggedRatio = next;
    this.ratioPreview.emit(next);
  }

  protected onPointerUp(event: PointerEvent): void {
    if (!this.dragging() || this.lastHandledEvent === event) return;
    this.lastHandledEvent = event;
    const finalRatio = this.ratioFromPointer(event) ?? this.draggedRatio;
    const hadMove = this.draggedRatio !== null;
    this.stopDrag();
    this.ratioPreview.emit(null);
    if (hadMove && finalRatio !== null) {
      this.ratioCommit.emit(finalRatio);
    }
  }

  protected onPointerCancel(event: PointerEvent): void {
    if (!this.dragging() || this.lastHandledEvent === event) return;
    this.lastHandledEvent = event;
    this.stopDrag();
    this.ratioPreview.emit(null);
  }

  protected onKeyDown(event: KeyboardEvent): void {
    const isHorizontal = this.direction() === 'horizontal';
    const { min, max } = this.ratioBounds();
    let next: number | null = null;

    if (isHorizontal) {
      if (event.key === 'ArrowLeft') next = this.ratio() - KEYBOARD_STEP;
      else if (event.key === 'ArrowRight') next = this.ratio() + KEYBOARD_STEP;
    } else {
      if (event.key === 'ArrowUp') next = this.ratio() - KEYBOARD_STEP;
      else if (event.key === 'ArrowDown') next = this.ratio() + KEYBOARD_STEP;
    }
    if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;

    if (next === null) return;
    event.preventDefault();
    const clamped = roundRatio(Math.min(max, Math.max(min, next)));
    this.ratioCommit.emit(clamped);
  }

  private ratioBounds(): { readonly min: number; readonly max: number } {
    const container = this.container();
    if (container === null) return { min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO };
    const rect = container.getBoundingClientRect();
    const isHorizontal = this.direction() === 'horizontal';
    const size = isHorizontal ? rect.width : rect.height;
    if (size <= 0) return { min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO };
    const minPx = isHorizontal ? MIN_PANE_WIDTH_PX : MIN_PANE_HEIGHT_PX;
    const min = Math.min(0.5, Math.max(MIN_SPLIT_RATIO, minPx / size));
    return { min, max: 1 - min };
  }

  private ratioFromPointer(event: PointerEvent): number | null {
    const container = this.container();
    if (container === null) return null;
    const rect = container.getBoundingClientRect();
    const isHorizontal = this.direction() === 'horizontal';
    const size = isHorizontal ? rect.width : rect.height;
    if (size <= 0) return null;
    const offset = isHorizontal ? event.clientX - rect.left : event.clientY - rect.top;
    const { min, max } = this.ratioBounds();
    return roundRatio(Math.min(max, Math.max(min, offset / size)));
  }

  private stopDrag(): void {
    const el = this.host.nativeElement;
    if (
      this.activePointerId !== null &&
      typeof el.releasePointerCapture === 'function' &&
      typeof el.hasPointerCapture === 'function'
    ) {
      try {
        if (el.hasPointerCapture(this.activePointerId)) {
          el.releasePointerCapture(this.activePointerId);
        }
      } catch {
        // Ignore synthetic pointer capture cleanup errors.
      }
    }
    this.activePointerId = null;
    this.draggedRatio = null;
    this.dragging.set(false);
    this.detachWindowListeners();
  }

  private attachWindowListeners(): void {
    window.addEventListener('pointermove', this.handleWindowMove);
    window.addEventListener('pointerup', this.handleWindowUp);
    window.addEventListener('pointercancel', this.handleWindowCancel);
  }

  private detachWindowListeners(): void {
    window.removeEventListener('pointermove', this.handleWindowMove);
    window.removeEventListener('pointerup', this.handleWindowUp);
    window.removeEventListener('pointercancel', this.handleWindowCancel);
  }
}
