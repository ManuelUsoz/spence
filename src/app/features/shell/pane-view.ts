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
import type { LeafPaneNode, PanelId, TabId } from '../../../shared/tabs/tabs.rpc';
import { PanelFrame } from './panel-frame';
import { type DropZone, WorkspaceDragService } from './workspace-drag';

const DROP_ZONE_CLASSES: Record<DropZone, string> = {
  left: 'inset-y-1 left-1 w-1/2',
  right: 'inset-y-1 right-1 w-1/2',
  top: 'inset-x-1 top-1 h-1/2',
  bottom: 'inset-x-1 bottom-1 h-1/2',
  center: 'inset-2',
};

/**
 * Renders one `LeafPaneNode`'s single Panel and a split/swap drop-zone overlay during Panel drag-and-drop.
 */
@Component({
  selector: 'app-pane-view',
  imports: [PanelFrame],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
    'data-testid': 'pane-view',
    '[attr.data-pane-id]': 'pane().id',
  },
  template: `
    @for (panel of pane().panels.slice(0, 1); track panel.id) {
      <app-panel-frame
        [tabId]="tabId()"
        [panel]="panel"
        [paneId]="pane().id"
        [projectId]="projectId()"
        [projectName]="projectName()"
        [focused]="focusedPanelId() === panel.id"
        [canSplit]="canSplit()"
        [isSplit]="isSplit()"
      />
    }
    @if (dropZone(); as zone) {
      <div
        aria-hidden="true"
        data-testid="pane-drop-zone"
        [attr.data-drop-zone]="zone"
        class="border-ring bg-accent/35 pointer-events-none absolute z-30 rounded-md border-2 transition-all"
        [class]="dropZoneClasses(zone)"
      ></div>
    }
  `,
})
export class PaneView {
  private readonly drag = inject(WorkspaceDragService);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  readonly tabId = input<TabId | null>(null);
  readonly pane = input.required<LeafPaneNode>();
  readonly projectId = input.required<ProjectId>();
  readonly projectName = input('');
  readonly focusedPanelId = input<PanelId | null>(null);
  readonly canSplit = input(true);
  readonly isSplit = input(false);

  protected readonly dropZone = computed((): DropZone | null => {
    const target = this.drag.panelDropTarget();
    if (target === null || target.paneId !== this.pane().id) return null;
    if (this.tabId() !== null && target.tabId !== this.tabId()) return null;
    return target.zone;
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
}
