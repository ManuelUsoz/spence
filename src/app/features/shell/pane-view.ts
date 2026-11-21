import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  input,
} from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { LeafPaneNode, PanelId, TabId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { Tabs } from '../../core/tabs';
import { PanelFrame } from './panel-frame';
import { StackDivider, type StackResizeEvent } from './stack-divider';
import { type DropZone, WorkspaceDragService } from './workspace-drag';

interface StackRenderItem {
  readonly panel: WorkspacePanel;
  readonly previousExpanded: WorkspacePanel | null;
}

const DROP_ZONE_CLASSES: Record<DropZone, string> = {
  left: 'inset-y-1 left-1 w-1/2',
  right: 'inset-y-1 right-1 w-1/2',
  top: 'inset-x-1 top-1 h-1/2',
  bottom: 'inset-x-1 bottom-1 h-1/2',
  center: 'inset-2',
};

/**
 * Renders one `LeafPaneNode`'s Panels as a single Panel or a vertically collapsible Panel stack
 * (`data-stacked="true"` when holding two or more Panels), with `<app-stack-divider>` between
 * adjacent expanded Panels and a drop-zone overlay during Panel drag-and-drop.
 */
@Component({
  selector: 'app-pane-view',
  imports: [PanelFrame, StackDivider],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'pane-view',
    '[attr.data-pane-id]': 'pane().id',
    '[attr.data-stacked]': "stacked() ? 'true' : 'false'",
  },
  template: `
    @for (item of stackItems(); track item.panel.id) {
      @if (item.previousExpanded; as upper) {
        <app-stack-divider
          [upperPanelId]="upper.id"
          [lowerPanelId]="item.panel.id"
          [upperShare]="upper.heightShare"
          [lowerShare]="item.panel.heightShare"
          [totalExpandedShare]="totalExpandedShare()"
          (resized)="onStackResize(upper.id, item.panel.id, $event)"
        />
      }
      <app-panel-frame
        [tabId]="tabId()"
        [panel]="item.panel"
        [paneId]="pane().id"
        [projectId]="projectId()"
        [projectName]="projectName()"
        [focused]="focusedPanelId() === item.panel.id"
        [canSplit]="canSplit()"
        [stacked]="stacked()"
        [canCollapse]="expandedCount() > 1 || item.panel.collapsed"
      />
    }
    @if (dropZone(); as zone) {
      <div
        aria-hidden="true"
        data-testid="pane-drop-zone"
        [attr.data-drop-zone]="zone"
        [attr.data-drop-index]="dropInsertIndex()"
        class="border-ring bg-accent/35 pointer-events-none absolute z-20 rounded-md border-2 transition-all"
        [class]="dropZoneClasses(zone)"
      ></div>
    }
  `,
})
export class PaneView {
  private readonly tabs = inject(Tabs);
  private readonly drag = inject(WorkspaceDragService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabId = input<TabId | null>(null);
  readonly pane = input.required<LeafPaneNode>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focusedPanelId = input<PanelId | null>(null);
  readonly canSplit = input(true);

  protected readonly stacked = computed(() => this.pane().panels.length >= 2);
  protected readonly expandedCount = computed(
    () => this.pane().panels.filter((panel) => !panel.collapsed).length,
  );
  protected readonly totalExpandedShare = computed(() =>
    this.pane().panels.reduce((sum, panel) => (panel.collapsed ? sum : sum + panel.heightShare), 0),
  );
  protected readonly stackItems = computed((): ReadonlyArray<StackRenderItem> => {
    let lastExpanded: WorkspacePanel | null = null;
    return this.pane().panels.map((panel) => {
      const previousExpanded = !panel.collapsed ? lastExpanded : null;
      if (!panel.collapsed) lastExpanded = panel;
      return { panel, previousExpanded };
    });
  });

  protected readonly dropZone = computed((): DropZone | null => {
    const target = this.drag.panelDropTarget();
    if (target === null || target.paneId !== this.pane().id) return null;
    if (this.tabId() !== null && target.tabId !== this.tabId()) return null;
    return target.zone;
  });

  protected readonly dropInsertIndex = computed((): number | null => {
    const target = this.drag.panelDropTarget();
    if (target === null || target.paneId !== this.pane().id || target.zone !== 'center') {
      return null;
    }
    return target.insertIndex ?? null;
  });

  constructor() {
    const unregister = this.drag.registerPane({
      tabId: () => this.tabId(),
      paneId: () => this.pane().id,
      panels: () => this.pane().panels,
      element: this.el.nativeElement,
    });
    this.destroyRef.onDestroy(unregister);
  }

  protected dropZoneClasses(zone: DropZone): string {
    return DROP_ZONE_CLASSES[zone];
  }

  protected onStackResize(
    upperPanelId: PanelId,
    lowerPanelId: PanelId,
    event: StackResizeEvent,
  ): void {
    this.tabs.resizeStackPanels(
      this.pane().id,
      upperPanelId,
      lowerPanelId,
      event.upperShare,
      event.lowerShare,
    );
  }
}
