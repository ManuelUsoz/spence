import { DestroyRef, DOCUMENT, Injectable, inject, signal } from '@angular/core';

const NON_CDK_OVERLAY_SELECTOR = [
  '[role="dialog"][aria-modal="true"]:not([hidden]):not([data-state="closed"])',
  '[role="alertdialog"][aria-modal="true"]:not([hidden]):not([data-state="closed"])',
  '[data-testid="handoff-backdrop"]:not([hidden])',
  '[data-testid="workers-sidebar"]:not([hidden])',
  '[data-sonner-toast]:not([data-removed="true"]):not([hidden])',
].join(', ');

const NON_TOOLTIP_PANE_CONTENT_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[data-slot="popover"]',
  '[data-slot="dropdown-menu"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="sheet-content"]',
].join(', ');

const VIEWPORT_SLOT_SELECTOR = '[data-testid="browser-viewport"]';

const rectsIntersect = (a: DOMRect, b: DOMRect): boolean =>
  a.width > 0 &&
  a.height > 0 &&
  b.width > 0 &&
  b.height > 0 &&
  a.left < b.right &&
  a.right > b.left &&
  a.top < b.bottom &&
  a.bottom > b.top;

const isPaneHidden = (pane: HTMLElement): boolean =>
  pane.childElementCount === 0 ||
  pane.hasAttribute('hidden') ||
  pane.style.display === 'none' ||
  pane.style.visibility === 'hidden' ||
  pane.getAttribute('aria-hidden') === 'true';

const isBackdropActive = (backdrop: HTMLElement): boolean =>
  !backdrop.classList.contains('cdk-overlay-transparent-backdrop') &&
  backdrop.style.pointerEvents !== 'none' &&
  backdrop.getAttribute('data-state') !== 'closed' &&
  !backdrop.hasAttribute('hidden');

/**
 * Tracks active Angular/Spartan/non-CDK overlays in the DOM so main can hide the native
 * `WebContentsView` while overlays cover or compete with the Browser pane.
 */
@Injectable({ providedIn: 'root' })
export class OverlayOcclusion {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly _occluded = signal(false);

  readonly occluded = this._occluded.asReadonly();

  constructor() {
    this.recheck();

    const body = this.document.body;
    const win = this.document.defaultView;
    const onViewportChange = () => this.recheck();

    let observer: MutationObserver | undefined;
    if (body !== null && typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(() => this.recheck());
      observer.observe(body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          'data-state',
          'data-removed',
          'aria-modal',
          'aria-hidden',
          'hidden',
          'role',
          'style',
          'class',
        ],
      });
    }

    win?.addEventListener('resize', onViewportChange, { passive: true });
    win?.addEventListener('scroll', onViewportChange, { passive: true, capture: true });

    this.destroyRef.onDestroy(() => {
      observer?.disconnect();
      win?.removeEventListener('resize', onViewportChange);
      win?.removeEventListener('scroll', onViewportChange, { capture: true });
    });
  }

  recheck(): void {
    const next = this.computeOccluded();
    if (this._occluded() !== next) {
      this._occluded.set(next);
    }
  }

  private computeOccluded(): boolean {
    if (this.document.querySelector(NON_CDK_OVERLAY_SELECTOR) !== null) {
      return true;
    }

    const container = this.document.querySelector('.cdk-overlay-container');
    if (container === null) return false;

    const backdrops = container.querySelectorAll<HTMLElement>('.cdk-overlay-backdrop');
    for (const backdrop of backdrops) {
      if (isBackdropActive(backdrop)) return true;
    }

    const panes = container.querySelectorAll<HTMLElement>('.cdk-overlay-pane');
    if (panes.length === 0) return false;

    let viewportRect: DOMRect | null | undefined;
    const readViewportRect = (): DOMRect | null => {
      if (viewportRect !== undefined) return viewportRect;
      const slot = this.document.querySelector(VIEWPORT_SLOT_SELECTOR);
      viewportRect = slot === null ? null : slot.getBoundingClientRect();
      return viewportRect;
    };

    for (const pane of panes) {
      if (isPaneHidden(pane)) continue;
      const tooltip = pane.querySelector<HTMLElement>('[role="tooltip"]');
      const isTooltipOnly =
        tooltip !== null && pane.querySelector(NON_TOOLTIP_PANE_CONTENT_SELECTOR) === null;
      if (!isTooltipOnly) return true;

      if (tooltip.getAttribute('data-state') === 'closed' || tooltip.hasAttribute('hidden')) {
        continue;
      }
      const slotRect = readViewportRect();
      if (slotRect !== null && rectsIntersect(tooltip.getBoundingClientRect(), slotRect)) {
        return true;
      }
    }

    return false;
  }
}
