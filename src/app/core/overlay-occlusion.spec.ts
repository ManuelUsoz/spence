import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverlayOcclusion } from './overlay-occlusion';

const mockRect = (
  element: Element,
  rect: { left: number; top: number; width: number; height: number },
): void => {
  const domRect = {
    x: rect.left,
    y: rect.top,
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    toJSON: () => ({}),
  };
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => domRect,
  });
};

const ensureCdkContainer = (): HTMLElement => {
  const existing = document.querySelector<HTMLElement>('.cdk-overlay-container');
  if (existing !== null) return existing;
  const container = document.createElement('div');
  container.className = 'cdk-overlay-container';
  document.body.appendChild(container);
  return container;
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('OverlayOcclusion', () => {
  it('starts unoccluded and occludes on non-tooltip CDK panes and backdrops, ignoring detaching backdrops and empty panes', async () => {
    const occlusion = TestBed.inject(OverlayOcclusion);
    expect(occlusion.occluded()).toBe(false);

    const container = ensureCdkContainer();

    // Empty pane does not occlude.
    const emptyPane = document.createElement('div');
    emptyPane.className = 'cdk-overlay-pane';
    container.appendChild(emptyPane);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    // Menu/dialog/sheet/popover pane occludes immediately.
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    emptyPane.appendChild(menu);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));

    // Detaching content restores immediately.
    emptyPane.remove();
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    // Active backdrop occludes, and detaching backdrop (pointer-events: none) restores immediately.
    const backdrop = document.createElement('div');
    backdrop.className = 'cdk-overlay-backdrop cdk-overlay-backdrop-showing';
    container.appendChild(backdrop);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));

    backdrop.style.pointerEvents = 'none';
    backdrop.classList.remove('cdk-overlay-backdrop-showing');
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));
  });

  it('occludes on handoff backdrop, tab switcher backdrop, aria-modal dialogs, workers sidebar, and active sonner toasts', async () => {
    const occlusion = TestBed.inject(OverlayOcclusion);

    const handoff = document.createElement('div');
    handoff.setAttribute('data-testid', 'handoff-backdrop');
    document.body.appendChild(handoff);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));
    handoff.remove();
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    const tabSwitcher = document.createElement('div');
    tabSwitcher.setAttribute('data-testid', 'tab-switcher-backdrop');
    document.body.appendChild(tabSwitcher);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));
    tabSwitcher.remove();
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    const modal = document.createElement('section');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));
    modal.remove();
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    const workers = document.createElement('aside');
    workers.setAttribute('data-testid', 'workers-sidebar');
    document.body.appendChild(workers);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));
    workers.remove();
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    const toast = document.createElement('li');
    toast.setAttribute('data-sonner-toast', '');
    document.body.appendChild(toast);
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));
    toast.setAttribute('data-removed', 'true');
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));
    toast.remove();
  });

  it('occludes for tooltips only when the tooltip rect intersects the Browser viewport slot rect', async () => {
    const occlusion = TestBed.inject(OverlayOcclusion);
    const viewport = document.createElement('div');
    viewport.setAttribute('data-testid', 'browser-viewport');
    mockRect(viewport, { left: 800, top: 88, width: 480, height: 700 });
    document.body.appendChild(viewport);

    const container = ensureCdkContainer();
    const pane = document.createElement('div');
    pane.className = 'cdk-overlay-pane';
    const tooltip = document.createElement('div');
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('data-state', 'open');
    // Left-sidebar tooltip far outside the Browser viewport rect.
    mockRect(tooltip, { left: 260, top: 44, width: 120, height: 28 });
    pane.appendChild(tooltip);
    container.appendChild(pane);

    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));

    // Repositioning the tooltip so it overlaps the Browser viewport triggers occlusion.
    mockRect(tooltip, { left: 790, top: 100, width: 140, height: 28 });
    pane.style.transform = 'translateX(530px)';
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(true));

    // Closing the tooltip clears occlusion immediately.
    tooltip.setAttribute('data-state', 'closed');
    await vi.waitFor(() => expect(occlusion.occluded()).toBe(false));
  });
});
