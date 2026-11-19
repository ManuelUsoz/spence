import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ProjectId } from '../../../shared/projects/projects.rpc';
import type { LeafPaneNode, PanelId } from '../../../shared/tabs/tabs.rpc';
import { PanelFrame } from './panel-frame';

/**
 * Renders one `LeafPaneNode`'s Panels via `PanelFrame`. Forms the clean seam below the split Pane tree
 * and will grow into vertically collapsible Panel stacks in #205.
 */
@Component({
  selector: 'app-pane-view',
  imports: [PanelFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'pane-view',
    '[attr.data-pane-id]': 'pane().id',
  },
  template: `
    @for (panel of pane().panels; track panel.id) {
      <app-panel-frame
        [panel]="panel"
        [paneId]="pane().id"
        [projectId]="projectId()"
        [projectName]="projectName()"
        [focused]="focusedPanelId() === panel.id"
        [canSplit]="canSplit()"
      />
    }
  `,
})
export class PaneView {
  readonly pane = input.required<LeafPaneNode>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focusedPanelId = input<PanelId | null>(null);
  readonly canSplit = input(true);
}
