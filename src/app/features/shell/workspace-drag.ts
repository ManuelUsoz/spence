import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import {
  PanelId,
  type PaneId,
  type TabId,
  type WorkspacePanel,
} from '../../../shared/tabs/tabs.rpc';
import type { SplitSide } from '../../../shared/tabs/workspace-layout';
import { Keymap } from '../../core/keymap';
import { Tabs } from '../../core/tabs';

export const DRAG_THRESHOLD_PX = 5;
const EDGE_FRACTION = 0.25;

export type DropZone = SplitSide | 'center';

export interface PanelDropTarget {
  readonly tabId: TabId;
  readonly paneId: PaneId;
  readonly zone: DropZone;
  readonly insertIndex?: number;
}

export interface TabDropTarget {
  readonly projectId: ProjectId;
  readonly fromTabId: TabId;
  readonly overTabId: TabId;
}

export interface PaneDropRegistration {
  readonly tabId: () => TabId | null;
  readonly paneId: () => PaneId;
  readonly panels: () => ReadonlyArray<WorkspacePanel>;
  readonly element: HTMLElement;
}

export interface TabDragRegistration {
  readonly projectId: () => ProjectId | null;
  readonly tabId: () => TabId;
  readonly element: HTMLElement;
}

interface PendingPanelDrag {
  readonly kind: 'panel';
  readonly pointerId: number | null;
  readonly startX: number;
  readonly startY: number;
  readonly tabId: TabId;
  readonly sourcePaneId: PaneId;
  readonly panelId: PanelId;
}

interface PendingTabDrag {
  readonly kind: 'tab';
  readonly pointerId: number | null;
  readonly startX: number;
  readonly startY: number;
  readonly projectId: ProjectId;
  readonly tabId: TabId;
}

type PendingDrag = PendingPanelDrag | PendingTabDrag;

type ActiveDrag =
  | {
      readonly kind: 'panel';
      readonly tabId: TabId;
      readonly sourcePaneId: PaneId;
      readonly panelId: PanelId;
      readonly target: PanelDropTarget | null;
    }
  | {
      readonly kind: 'tab';
      readonly projectId: ProjectId;
      readonly tabId: TabId;
      readonly overTabId: TabId | null;
    };

const computeStackInsertIndex = (
  paneEl: HTMLElement,
  panels: ReadonlyArray<WorkspacePanel>,
  draggedPanelId: PanelId,
  clientY: number,
): number => {
  const otherIds = new Set(
    panels.filter((panel) => panel.id !== draggedPanelId).map((panel) => panel.id),
  );
  if (otherIds.size === 0) return 0;

  const frames = [...paneEl.querySelectorAll<HTMLElement>('[data-testid="panel-frame"]')].filter(
    (el) => {
      const id = el.getAttribute('data-panel-id');
      return id !== null && otherIds.has(PanelId.make(id));
    },
  );
  const rects = frames.map((el) => el.getBoundingClientRect());
  if (rects.length === 0 || rects.some((rect) => rect.height <= 0)) {
    return otherIds.size;
  }
  let index = 0;
  for (const rect of rects) {
    if (clientY >= rect.top + rect.height / 2) index += 1;
  }
  return index;
};

/**
 * Coordinates direct pointer drag-and-drop for Panels (split edges + stack center/reorder) and
 * Tabs (horizontal strip reorder) with a 5px activation threshold and `Keymap` Esc cancellation.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceDragService {
  private readonly tabs = inject(Tabs);
  private readonly keymap = inject(Keymap);
  private readonly destroyRef = inject(DestroyRef);

  private readonly panes = new Set<PaneDropRegistration>();
  private readonly tabItems = new Set<TabDragRegistration>();

  private pending: PendingDrag | null = null;
  private listenersAttached = false;
  private suppressClick = false;

  private readonly _activeDrag = signal<ActiveDrag | null>(null);

  readonly panelDropTarget = computed((): PanelDropTarget | null => {
    const drag = this._activeDrag();
    return drag?.kind === 'panel' ? drag.target : null;
  });

  readonly tabDropTarget = computed((): TabDropTarget | null => {
    const drag = this._activeDrag();
    if (drag?.kind !== 'tab' || drag.overTabId === null || drag.overTabId === drag.tabId) {
      return null;
    }
    return { projectId: drag.projectId, fromTabId: drag.tabId, overTabId: drag.overTabId };
  });

  readonly draggingPanelId = computed((): PanelId | null => {
    const drag = this._activeDrag();
    return drag?.kind === 'panel' ? drag.panelId : null;
  });

  readonly draggingTabId = computed((): TabId | null => {
    const drag = this._activeDrag();
    return drag?.kind === 'tab' ? drag.tabId : null;
  });

  private readonly handlePointerMove = (event: PointerEvent): void => this.onPointerMove(event);
  private readonly handlePointerUp = (event: PointerEvent): void => this.onPointerUp(event);
  private readonly handlePointerCancel = (event: PointerEvent): void => this.onPointerCancel(event);

  constructor() {
    this.keymap.registerEscape({
      layer: 'menu',
      when: () => this._activeDrag() !== null,
      run: () => this.cancel(),
      destroyRef: this.destroyRef,
    });
    this.destroyRef.onDestroy(() => this.detachListeners());
  }

  /** Registers a `PaneView` element for drop-zone hit-testing and returns an unregister callback. */
  registerPane(entry: PaneDropRegistration): () => void {
    this.panes.add(entry);
    return () => this.panes.delete(entry);
  }

  /** Registers a `TabStrip` item element for horizontal reorder hit-testing and returns an unregister callback. */
  registerTab(entry: TabDragRegistration): () => void {
    this.tabItems.add(entry);
    return () => this.tabItems.delete(entry);
  }

  /** Begins tracking a potential Panel drag on `pointerdown` (activates past `5px` movement). */
  beginPanelDrag(options: {
    readonly pointerId: number | null;
    readonly clientX: number;
    readonly clientY: number;
    readonly tabId: TabId;
    readonly paneId: PaneId;
    readonly panelId: PanelId;
  }): void {
    this.suppressClick = false;
    this.pending = {
      kind: 'panel',
      pointerId: options.pointerId,
      startX: options.clientX,
      startY: options.clientY,
      tabId: options.tabId,
      sourcePaneId: options.paneId,
      panelId: options.panelId,
    };
    this._activeDrag.set(null);
    this.attachListeners();
  }

  /** Begins tracking a potential Tab drag on `pointerdown` (activates past `5px` horizontal movement). */
  beginTabDrag(options: {
    readonly pointerId: number | null;
    readonly clientX: number;
    readonly clientY: number;
    readonly projectId: ProjectId;
    readonly tabId: TabId;
  }): void {
    this.suppressClick = false;
    this.pending = {
      kind: 'tab',
      pointerId: options.pointerId,
      startX: options.clientX,
      startY: options.clientY,
      projectId: options.projectId,
      tabId: options.tabId,
    };
    this._activeDrag.set(null);
    this.attachListeners();
  }

  /** Returns `true` once if a drag just completed and its trailing `click` should be ignored. */
  consumeSuppressedClick(): boolean {
    if (!this.suppressClick) return false;
    this.suppressClick = false;
    return true;
  }

  /** Cancels any pending or active drag without mutating workspace layout. */
  cancel(): void {
    this.pending = null;
    this._activeDrag.set(null);
    this.detachListeners();
  }

  private matchesPointer(event: PointerEvent): boolean {
    if (this.pending === null) return false;
    return (
      this.pending.pointerId === null ||
      typeof event.pointerId !== 'number' ||
      event.pointerId === this.pending.pointerId
    );
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.matchesPointer(event) || this.pending === null) return;
    const pending = this.pending;
    let active = this._activeDrag();

    if (active === null) {
      const dx = event.clientX - pending.startX;
      const dy = event.clientY - pending.startY;
      const movedEnough =
        pending.kind === 'tab'
          ? Math.abs(dx) >= DRAG_THRESHOLD_PX
          : Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
      if (!movedEnough) return;

      active =
        pending.kind === 'panel'
          ? {
              kind: 'panel',
              tabId: pending.tabId,
              sourcePaneId: pending.sourcePaneId,
              panelId: pending.panelId,
              target: null,
            }
          : {
              kind: 'tab',
              projectId: pending.projectId,
              tabId: pending.tabId,
              overTabId: null,
            };
    }

    event.preventDefault();
    if (active.kind === 'panel') {
      const target = this.hitTestPanel(
        active.tabId,
        active.sourcePaneId,
        active.panelId,
        event.clientX,
        event.clientY,
      );
      this._activeDrag.set({ ...active, target });
    } else {
      const overTabId = this.hitTestTab(active.projectId, event.clientX);
      this._activeDrag.set({ ...active, overTabId });
    }
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.matchesPointer(event)) return;
    const active = this._activeDrag();
    this.pending = null;
    this._activeDrag.set(null);
    this.detachListeners();

    if (active === null) return;

    this.suppressClick = true;
    queueMicrotask(() => {
      this.suppressClick = false;
    });

    if (active.kind === 'panel') {
      const target =
        this.hitTestPanel(
          active.tabId,
          active.sourcePaneId,
          active.panelId,
          event.clientX,
          event.clientY,
        ) ?? active.target;
      if (target === null) return;
      if (target.zone === 'center') {
        this.tabs.movePanelToStack(active.panelId, target.paneId, target.insertIndex);
      } else {
        this.tabs.movePanelToSplit(active.panelId, target.paneId, target.zone);
      }
      return;
    }

    const overTabId = this.hitTestTab(active.projectId, event.clientX) ?? active.overTabId;
    if (overTabId !== null && overTabId !== active.tabId) {
      this.tabs.reorderTabs(active.projectId, active.tabId, overTabId);
    }
  }

  private onPointerCancel(event: PointerEvent): void {
    if (!this.matchesPointer(event)) return;
    this.cancel();
  }

  private hitTestPanel(
    tabId: TabId,
    sourcePaneId: PaneId,
    panelId: PanelId,
    clientX: number,
    clientY: number,
  ): PanelDropTarget | null {
    for (const entry of this.panes) {
      if (entry.tabId() !== tabId) continue;
      const rect = entry.element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        continue;
      }

      const targetPaneId = entry.paneId();
      const rx = (clientX - rect.left) / rect.width;
      const ry = (clientY - rect.top) / rect.height;

      let bestSide: SplitSide | null = null;
      let bestDist = EDGE_FRACTION;
      if (rx < bestDist) {
        bestDist = rx;
        bestSide = 'left';
      }
      if (1 - rx < bestDist) {
        bestDist = 1 - rx;
        bestSide = 'right';
      }
      if (ry < bestDist) {
        bestDist = ry;
        bestSide = 'top';
      }
      if (1 - ry < bestDist) {
        bestSide = 'bottom';
      }

      if (bestSide !== null) {
        if (!this.tabs.canDropSplit(tabId, sourcePaneId, targetPaneId)) return null;
        return { tabId, paneId: targetPaneId, zone: bestSide };
      }

      const panels = entry.panels();
      if (sourcePaneId === targetPaneId && panels.length <= 1) return null;
      const insertIndex = computeStackInsertIndex(entry.element, panels, panelId, clientY);
      return { tabId, paneId: targetPaneId, zone: 'center', insertIndex };
    }
    return null;
  }

  private hitTestTab(projectId: ProjectId, clientX: number): TabId | null {
    const measured: Array<{ readonly tabId: TabId; readonly rect: DOMRect }> = [];
    for (const entry of this.tabItems) {
      if (entry.projectId() !== projectId) continue;
      const rect = entry.element.getBoundingClientRect();
      if (rect.width <= 0) continue;
      measured.push({ tabId: entry.tabId(), rect });
    }
    if (measured.length === 0) return null;
    measured.sort((a, b) => a.rect.left - b.rect.left);

    for (const item of measured) {
      if (clientX >= item.rect.left && clientX <= item.rect.right) return item.tabId;
    }
    const first = measured[0];
    const last = measured.at(-1);
    if (first !== undefined && clientX < first.rect.left) return first.tabId;
    if (last !== undefined && clientX > last.rect.right) return last.tabId;

    let closest: TabId | null = null;
    let minDistance = Infinity;
    for (const item of measured) {
      const center = item.rect.left + item.rect.width / 2;
      const distance = Math.abs(clientX - center);
      if (distance < minDistance) {
        minDistance = distance;
        closest = item.tabId;
      }
    }
    return closest;
  }

  private attachListeners(): void {
    if (this.listenersAttached) return;
    this.listenersAttached = true;
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerCancel);
  }

  private detachListeners(): void {
    if (!this.listenersAttached) return;
    this.listenersAttached = false;
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerCancel);
  }
}
