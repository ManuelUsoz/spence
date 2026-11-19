import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { LeafPaneNode, PanelId, WorkspacePanel } from '../../../shared/tabs/tabs.rpc';
import { Tabs } from '../../core/tabs';
import { PanelFrame } from './panel-frame';
import { StackDivider, type StackResizeEvent } from './stack-divider';

interface StackRenderItem {
  readonly panel: WorkspacePanel;
  readonly previousExpanded: WorkspacePanel | null;
}

/**
 * Renders one `LeafPaneNode`'s Panels as a single Panel or a vertically collapsible Panel stack
 * (`data-stacked="true"` when holding two or more Panels), with `<app-stack-divider>` between
 * adjacent expanded Panels.
 */
@Component({
  selector: 'app-pane-view',
  imports: [PanelFrame, StackDivider],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
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
  `,
})
export class PaneView {
  private readonly tabs = inject(Tabs);

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
