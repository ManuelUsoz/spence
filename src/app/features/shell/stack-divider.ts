import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { PanelId } from '../../../shared/tabs/tabs.rpc';
import { MIN_STACK_SHARE } from '../../../shared/tabs/workspace-layout';

const MIN_PANEL_HEIGHT_PX = 120;
const KEY_STEP_FRACTION = 0.05;
const KEY_STEP_SHIFT_FRACTION = 0.1;

export interface StackResizeEvent {
  readonly upperShare: number;
  readonly lowerShare: number;
}

interface ActiveDrag {
  readonly pointerId: number;
  readonly startY: number;
  readonly startUpper: number;
  readonly combinedShare: number;
  readonly pairHeightPx: number;
}

/**
 * Horizontal resize separator between two adjacent expanded Panels in a Pane's vertical Panel stack.
 * Supports pointer-capture vertical dragging and ArrowUp / ArrowDown keyboard resizing while
 * preserving the pair's combined `heightShare` and enforcing minimum height / `MIN_STACK_SHARE`.
 */
@Component({
  selector: 'app-stack-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'separator',
    'aria-orientation': 'horizontal',
    tabindex: '0',
    'data-testid': 'stack-resize-divider',
    '[attr.aria-label]': 'ariaLabel',
    '[attr.aria-valuenow]': 'valueNow()',
    'aria-valuemin': '15',
    'aria-valuemax': '85',
    class:
      'group relative flex h-1.5 w-full shrink-0 cursor-row-resize items-center justify-center bg-transparent select-none outline-none focus-visible:ring-2 focus-visible:ring-ring',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'onPointerMove($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(pointercancel)': 'onPointerUp($event)',
    '(lostpointercapture)': 'onPointerUp($event)',
    '(keydown)': 'onKeydown($event)',
  },
  template: `
    <div
      aria-hidden="true"
      class="w-full transition-colors"
      [class]="
        dragging()
          ? 'bg-ring h-0.5'
          : 'bg-border/70 group-hover:bg-ring/60 group-focus-visible:bg-ring h-px'
      "
    ></div>
  `,
})
export class StackDivider {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly upperPanelId = input.required<PanelId>();
  readonly lowerPanelId = input.required<PanelId>();
  readonly upperShare = input.required<number>();
  readonly lowerShare = input.required<number>();
  readonly totalExpandedShare = input.required<number>();

  readonly resized = output<StackResizeEvent>();

  protected readonly ariaLabel = $localize`Resize stacked Panels`;
  protected readonly dragging = signal(false);

  protected readonly valueNow = computed(() => {
    const combined = this.upperShare() + this.lowerShare();
    return combined > 0 ? Math.round((this.upperShare() / combined) * 100) : 50;
  });

  private drag: ActiveDrag | null = null;

  protected onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startUpper = this.upperShare();
    const combinedShare = startUpper + this.lowerShare();
    const pairHeightPx = this.measurePairHeightPx(combinedShare);
    if (combinedShare <= 0 || pairHeightPx <= 0) return;

    this.drag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startUpper,
      combinedShare,
      pairHeightPx,
    };
    this.dragging.set(true);
    try {
      this.el.nativeElement.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events in unit tests have no active browser pointer to capture.
    }
  }

  protected onPointerMove(event: PointerEvent): void {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    event.preventDefault();
    const deltaY = event.clientY - this.drag.startY;
    const deltaShare = (deltaY / this.drag.pairHeightPx) * this.drag.combinedShare;
    this.resized.emit(
      this.clampPair(
        this.drag.startUpper + deltaShare,
        this.drag.combinedShare,
        this.drag.pairHeightPx,
      ),
    );
  }

  protected onPointerUp(event: PointerEvent): void {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    const host = this.el.nativeElement;
    try {
      if (host.hasPointerCapture?.(event.pointerId)) {
        host.releasePointerCapture?.(event.pointerId);
      }
    } catch {
      // Ignore synthetic events without active capture.
    }
    this.drag = null;
    this.dragging.set(false);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    event.stopPropagation();
    const startUpper = this.upperShare();
    const combinedShare = startUpper + this.lowerShare();
    if (combinedShare <= 0) return;
    const fraction = event.shiftKey ? KEY_STEP_SHIFT_FRACTION : KEY_STEP_FRACTION;
    const delta = (event.key === 'ArrowDown' ? 1 : -1) * fraction * combinedShare;
    const pairHeightPx = this.measurePairHeightPx(combinedShare);
    this.resized.emit(this.clampPair(startUpper + delta, combinedShare, pairHeightPx));
  }

  private measurePairHeightPx(combinedShare: number): number {
    const parent = this.el.nativeElement.parentElement;
    if (parent === null) return 0;

    const upperId = this.upperPanelId();
    const lowerId = this.lowerPanelId();
    let upperHeight = 0;
    let lowerHeight = 0;
    for (const child of Array.from(parent.children)) {
      const panelId = child.getAttribute('data-panel-id');
      if (panelId === upperId) upperHeight = child.getBoundingClientRect().height;
      else if (panelId === lowerId) lowerHeight = child.getBoundingClientRect().height;
    }
    if (upperHeight > 0 && lowerHeight > 0) return upperHeight + lowerHeight;

    const parentHeight = parent.getBoundingClientRect().height;
    const totalShare = this.totalExpandedShare();
    if (parentHeight > 0 && totalShare > 0) {
      return parentHeight * (combinedShare / totalShare);
    }
    return 0;
  }

  private clampPair(
    nextUpper: number,
    combinedShare: number,
    pairHeightPx: number,
  ): StackResizeEvent {
    const half = combinedShare / 2;
    const minFromShare = Math.min(MIN_STACK_SHARE, half);
    const minFromPx =
      pairHeightPx > 0 ? Math.min((MIN_PANEL_HEIGHT_PX / pairHeightPx) * combinedShare, half) : 0;
    const minShare = Math.max(minFromShare, minFromPx);
    const upperShare = Math.min(combinedShare - minShare, Math.max(minShare, nextUpper));
    return {
      upperShare,
      lowerShare: combinedShare - upperShare,
    };
  }
}
